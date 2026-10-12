import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";

test("CLI initializes once, imports protected files without changing them and refuses locked store", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gemini-lb-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const args = ["--import", "tsx", cli, "--data-dir", join(dir, "data")];
  const run = (...command: string[]) =>
    JSON.parse(
      execFileSync(process.execPath, [...args, ...command], {
        encoding: "utf8",
      }),
    );
  const initialized = run("init");
  assert.match(initialized.adminToken, /^glb-admin-/);
  assert.match(initialized.clientKey, /^glb-/);
  assert.equal(spawnSync(process.execPath, [...args, "init"]).status, 1);
  const keyPath = join(dir, "key.txt");
  writeFileSync(keyPath, "test-cli-upstream-key\n", { mode: 0o600 });
  const account = run(
    "account",
    "add",
    "--name",
    "cli-api",
    "--project",
    "test-project",
    "--key-file",
    keyPath,
  );
  assert.equal(account.kind, "api-key");
  assert.ok(!JSON.stringify(account).includes("test-cli-upstream-key"));
  const source = JSON.stringify({
    refresh_token: "test-cli-refresh-token",
    access_token: "test-cli-access-token",
    expiry_date: 1,
  });
  const oauthPath = join(dir, "oauth.json"),
    clientPath = join(dir, "client.json");
  writeFileSync(oauthPath, source, { mode: 0o600 });
  writeFileSync(
    clientPath,
    JSON.stringify({
      installed: {
        client_id: "test-cli-client-id",
        client_secret: "test-cli-client-secret",
      },
    }),
    { mode: 0o600 },
  );
  const imported = run(
    "account",
    "import",
    "--name",
    "cli-oauth",
    "--project",
    "managed-project",
    "--file",
    oauthPath,
    "--oauth-client",
    clientPath,
  );
  assert.equal(imported.kind, "oauth");
  assert.equal(readFileSync(oauthPath, "utf8"), source);
  assert.equal(run("account", "disable", "--id", account.id).enabled, false);
  assert.equal(run("account", "enable", "--id", account.id).enabled, true);
  const scoped = run(
    "key",
    "create",
    "--name",
    "service",
    "--accounts",
    account.id,
  );
  assert.match(scoped.key, /^glb-/);
  assert.equal(run("account", "list").length, 2);
  const store = new Store(join(dir, "data"));
  try {
    const result = spawnSync(process.execPath, [...args, "account", "list"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Another process/);
    assert.ok(!result.stderr.includes("test-cli-refresh-token"));
  } finally {
    store.close();
  }
});
