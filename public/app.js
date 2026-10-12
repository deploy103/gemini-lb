"use strict";

const $ = (id) => document.getElementById(id);
let token = "";
let accounts = [];
let generation = 0;
let loading = false;
const format = (value) => (value == null ? "—" : String(value));
const time = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
};
function node(tag, value, className) {
  const element = document.createElement(tag);
  if (value != null) element.textContent = String(value);
  if (className) element.className = className;
  return element;
}
function cell(row, value) {
  const td = node("td");
  td.append(value instanceof Node ? value : node("span", format(value)));
  row.append(td);
  return td;
}
function details(primary, secondary) {
  const box = node("div");
  box.append(
    node("div", format(primary)),
    node("div", format(secondary), "small muted"),
  );
  return box;
}
function empty(id, columns, message) {
  const row = node("tr");
  const td = cell(row, message);
  td.colSpan = columns;
  td.className = "empty";
  $(id).replaceChildren(row);
}
function notice(message, error = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
}
async function api(path, method = "GET", body) {
  const response = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    credentials: "same-origin",
  });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      data?.error?.message || `Request failed (${response.status})`,
    );
  return data;
}
function controls(connected) {
  $("connection").textContent = connected ? "Connected" : "Disconnected";
  $("connection").classList.toggle("online", connected);
  $("connect-form").hidden = connected;
  $("disconnect").hidden = !connected;
  for (const id of ["refresh", "add-account", "add-key"])
    $(id).disabled = !connected;
}
function clear() {
  accounts = [];
  for (const key of ["requests", "errors", "tokens", "inflight"])
    $(`stat-${key}`).textContent = "—";
  $("account-count").textContent = "—";
  empty("accounts-body", 6, "Connect to view your account pool.");
  empty("requests-body", 8, "Connect to view request history.");
  empty("keys-body", 5, "Connect to manage client keys.");
}
function action(label, accessible, run) {
  const button = node("button", label, "compact");
  button.type = "button";
  button.setAttribute("aria-label", accessible);
  button.addEventListener("click", async () => {
    button.disabled = true;
    const current = generation;
    try {
      await run();
      if (current === generation) await refresh();
    } catch (error) {
      if (current === generation) notice(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  return button;
}
function renderAccounts() {
  $("account-count").textContent = String(accounts.length);
  $("accounts-body").replaceChildren();
  if (!accounts.length)
    return empty(
      "accounts-body",
      6,
      "No upstream accounts yet. Add an account to start routing.",
    );
  for (const account of accounts) {
    const row = node("tr");
    cell(row, details(account.name, `${account.kind} · ${account.project}`));
    const state = !account.enabled ? "disabled" : account.state;
    const stateBox = details(
      state,
      account.cooldownUntil > Date.now()
        ? `Cooldown until ${time(account.cooldownUntil)}`
        : account.id,
    );
    stateBox.firstChild.className = `badge ${state === "ready" ? "good" : "neutral"}`;
    cell(row, stateBox);
    cell(row, `${format(account.inflight)} / ${format(account.maxInflight)}`);
    cell(
      row,
      account.models?.length ? account.models.join(", ") : "All models",
    );
    const quota = node("div", null, "quota");
    if (account.kind === "api-key")
      quota.append(node("span", "Unknown", "muted"));
    else {
      const buckets = Array.isArray(account.quota)
        ? account.quota
        : account.quota?.buckets;
      if (!buckets?.length)
        quota.append(node("span", "No quota snapshot", "muted"));
      else
        for (const bucket of buckets)
          quota.append(
            details(
              bucket.modelId,
              `remainingFraction: ${format(bucket.remainingFraction)} · resetTime: ${format(bucket.resetTime)}`,
            ),
          );
      if (account.quotaUpdatedAt)
        quota.append(
          node("div", `Updated ${time(account.quotaUpdatedAt)}`, "small muted"),
        );
    }
    cell(row, quota);
    const buttons = node("div", null, "row-actions");
    buttons.append(
      action(
        account.enabled ? "Disable" : "Enable",
        `${account.enabled ? "Disable" : "Enable"} ${account.name}`,
        () =>
          api(`/admin/accounts/${encodeURIComponent(account.id)}`, "PATCH", {
            enabled: !account.enabled,
          }),
      ),
    );
    if (account.kind === "oauth")
      buttons.append(
        action("Refresh quota", `Refresh quota for ${account.name}`, () =>
          api(
            `/admin/accounts/${encodeURIComponent(account.id)}/quota`,
            "POST",
          ),
        ),
      );
    cell(row, buttons);
    $("accounts-body").append(row);
  }
}
function renderRequests(requests) {
  $("requests-body").replaceChildren();
  if (!requests.length)
    return empty(
      "requests-body",
      8,
      "No requests recorded. Gateway activity will appear here.",
    );
  for (const request of requests) {
    const row = node("tr");
    cell(row, details(time(request.createdAt), request.id));
    cell(
      row,
      accounts.find((a) => a.id === request.accountId)?.name ||
        request.accountId,
    );
    cell(row, details(request.model, request.method));
    cell(
      row,
      node(
        "span",
        request.outcome,
        `badge ${request.outcome === "success" ? "good" : "neutral"}`,
      ),
    );
    for (const field of ["status", "attempts", "tokens"])
      cell(row, request[field]);
    cell(row, request.durationMs == null ? "—" : `${request.durationMs} ms`);
    $("requests-body").append(row);
  }
}
function renderKeys(keys) {
  $("keys-body").replaceChildren();
  if (!keys.length)
    return empty(
      "keys-body",
      5,
      "No client keys. Create a key for downstream access.",
    );
  for (const key of keys) {
    const row = node("tr");
    cell(row, details(key.name, key.id));
    cell(
      row,
      key.accounts?.length
        ? key.accounts
            .map((id) => accounts.find((a) => a.id === id)?.name || id)
            .join(", ")
        : "All accounts",
    );
    cell(row, time(key.createdAt));
    cell(
      row,
      node(
        "span",
        key.enabled ? "Active" : "Revoked",
        `badge ${key.enabled ? "good" : "neutral"}`,
      ),
    );
    cell(
      row,
      action(
        key.enabled ? "Revoke" : "Restore",
        `${key.enabled ? "Revoke" : "Restore"} ${key.name}`,
        async () => {
          if (
            key.enabled &&
            !window.confirm(
              `Revoke client key “${key.name}”? Clients using this key will lose access.`,
            )
          )
            return;
          await api(`/admin/keys/${encodeURIComponent(key.id)}`, "PATCH", {
            enabled: !key.enabled,
          });
        },
      ),
    );
    $("keys-body").append(row);
  }
}
async function refresh() {
  if (!token || loading) return;
  loading = true;
  const current = generation;
  $("refresh").disabled = true;
  notice("Loading gateway activity…");
  try {
    const overview = await api("/admin/overview");
    if (current !== generation) return;
    controls(true);
    accounts = overview.accounts;
    for (const key of ["requests", "errors", "tokens", "inflight"])
      $(`stat-${key}`).textContent = format(overview.stats[key]);
    renderAccounts();
    renderRequests(overview.requests);
    try {
      const keys = await api("/admin/keys");
      if (current !== generation) return;
      renderKeys(keys);
      notice(
        `Last updated ${new Date().toLocaleTimeString()}. Refresh to retrieve current activity.`,
      );
    } catch (error) {
      if (current !== generation) return;
      empty(
        "keys-body",
        5,
        "Client keys could not be loaded. Refresh to retry.",
      );
      notice(`Overview loaded; client keys: ${error.message}`, true);
    }
  } catch (error) {
    if (current === generation) {
      $("connection").textContent = "Connection error";
      $("connection").classList.remove("online");
      notice(
        `Unable to load overview: ${error.message}. Disconnect to change your token, or refresh to retry.`,
        true,
      );
    }
  } finally {
    if (current === generation) {
      loading = false;
      $("refresh").disabled = !token;
    }
  }
}
$("connect-form").addEventListener("submit", (event) => {
  event.preventDefault();
  token = $("admin-token").value.trim();
  if (!token) return;
  $("admin-token").value = "";
  generation++;
  loading = false;
  controls(true);
  $("connection").textContent = "Connecting…";
  $("connection").classList.remove("online");
  refresh();
});
$("disconnect").addEventListener("click", () => {
  token = "";
  generation++;
  loading = false;
  for (const dialog of document.querySelectorAll("dialog")) dialog.close();
  $("account-form").reset();
  $("key-form").reset();
  controls(false);
  clear();
  notice("Disconnected. The admin token has been cleared from memory.");
});
$("refresh").addEventListener("click", refresh);
for (const button of document.querySelectorAll("[data-close]"))
  button.addEventListener("click", () => $(button.dataset.close).close());
function kindChanged() {
  const oauth = $("account-form").elements.kind.value === "oauth";
  $("api-credential").hidden = oauth;
  $("oauth-credential").hidden = !oauth;
  $("account-form").elements.api_key.required = !oauth;
  $("account-form").elements.oauth_json.required = oauth;
}
$("account-form").elements.kind.addEventListener("change", kindChanged);
$("add-account").addEventListener("click", () => {
  $("account-form").reset();
  kindChanged();
  $("account-error").textContent = "";
  $("account-dialog").showModal();
});
$("account-dialog").addEventListener("close", () => {
  $("account-form").reset();
  kindChanged();
});
$("account-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  const current = generation;
  $("account-error").textContent = "";
  button.disabled = true;
  try {
    const fields = form.elements;
    let credential;
    if (fields.kind.value === "oauth") {
      try {
        credential = JSON.parse(fields.oauth_json.value);
      } catch {
        throw new Error("Enter valid credentials JSON.");
      }
      if (
        !credential ||
        Array.isArray(credential) ||
        typeof credential !== "object"
      )
        throw new Error("Credentials must be a JSON object.");
      if (!credential.access_token && !credential.refresh_token)
        throw new Error("Include an access_token or refresh_token.");
    } else credential = { api_key: fields.api_key.value.trim() };
    await api("/admin/accounts", "POST", {
      name: fields.name.value.trim(),
      kind: fields.kind.value,
      project: fields.project.value.trim(),
      credential,
      models: fields.models.value
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean),
      maxInflight: Number(fields.maxInflight.value),
    });
    if (current !== generation) return;
    $("account-dialog").close();
    await refresh();
  } catch (error) {
    if (current === generation) $("account-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$("add-key").addEventListener("click", () => {
  $("key-form").reset();
  $("key-form").hidden = false;
  $("key-result").hidden = true;
  $("key-error").textContent = "";
  $("key-scopes").replaceChildren();
  for (const account of accounts) {
    const label = node("label", null, "checkbox");
    const input = node("input");
    input.type = "checkbox";
    input.name = "accounts";
    input.value = account.id;
    label.append(input, node("span", `${account.name} · ${account.project}`));
    $("key-scopes").append(label);
  }
  $("key-dialog").showModal();
});
$("key-dialog").addEventListener("close", () => {
  $("new-key").value = "";
  $("copy-status").textContent = "";
  $("key-form").reset();
});
$("key-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  const current = generation;
  button.disabled = true;
  $("key-error").textContent = "";
  try {
    const scope = [...$("key-scopes").querySelectorAll("input:checked")].map(
      (input) => input.value,
    );
    const result = await api("/admin/keys", "POST", {
      name: $("key-form").elements.name.value.trim(),
      ...(scope.length ? { accounts: scope } : {}),
    });
    if (current !== generation) return;
    $("new-key").value = result.key;
    $("key-form").hidden = true;
    $("key-result").hidden = false;
    $("new-key").focus();
    await refresh();
  } catch (error) {
    if (current === generation) $("key-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$("copy-key").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("new-key").value);
    $("copy-status").textContent = "Copied to clipboard.";
  } catch {
    $("new-key").focus();
    $("new-key").select();
    $("copy-status").textContent =
      "Clipboard unavailable. Copy the selected key manually.";
  }
});
clear();
