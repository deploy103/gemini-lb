#!/usr/bin/env node
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store, GatewayError, object, string } from "./store.js";
import { createServer } from "./server.js";

const help = `gemini-lb 0.1.0 — Node 24+
  init                       Initialize protected store; print tokens once
  serve                      Run gateway and dashboard
  account add                --name NAME --project PROJECT --key-file PATH
  account import             --name NAME --project PROJECT --file PATH [--oauth-client PATH]
  account list               List accounts (no credentials)
  account enable|disable     --id ID
  key create                 --name NAME [--accounts ID,ID]
Options: --data-dir PATH (default ~/.gemini-lb or GEMINI_LB_DATA_DIR)
Serve options: --host HOST (127.0.0.1), --port PORT (2456)
Use protected files for secrets, never secret command-line arguments.
Offline commands require the server to be stopped.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      "data-dir": { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      name: { type: "string" },
      project: { type: "string" },
      "key-file": { type: "string" },
      file: { type: "string" },
      "oauth-client": { type: "string" },
      id: { type: "string" },
      accounts: { type: "string" },
    },
  });
  if (values.help || !positionals.length) {
    console.log(help);
    return;
  }
  const command = positionals.join(" ");
  if (
    ![
      "init",
      "serve",
      "account add",
      "account import",
      "account list",
      "account enable",
      "account disable",
      "key create",
    ].includes(command)
  )
    throw new GatewayError(400, "Unknown command; use --help");
  const dir = resolve(
    values["data-dir"] ??
      process.env.GEMINI_LB_DATA_DIR ??
      `${homedir()}/.gemini-lb`,
  );
  const store = new Store(dir, command === "init");
  if (command === "serve") {
    try {
      const port = Number(values.port ?? 2456);
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new GatewayError(400, "Port must be 1..65535");
      const { app } = await createServer(store);
      const address = await app.listen({
        host: values.host ?? "127.0.0.1",
        port,
      });
      console.log(
        `gemini-lb 0.1.0 listening at ${address}; admin authentication required`,
      );
      const stop = async () => {
        await app.close();
        store.close();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      return;
    } catch (error) {
      store.close();
      throw error;
    }
  }
  try {
    let result: unknown;
    if (command === "init") result = store.initialTokens;
    if (command === "account list") result = store.accounts();
    if (command === "account enable" || command === "account disable")
      result = store.patchAccount(string(values.id, "id"), {
        enabled: command === "account enable",
      });
    if (command === "key create")
      result = store.createKey({
        name: values.name,
        accounts: values.accounts?.split(",").filter(Boolean),
      });
    if (command === "account add")
      result = store.addAccount({
        name: values.name,
        kind: "api-key",
        project: values.project,
        credential: {
          api_key: readFileSync(
            string(values["key-file"], "key-file"),
            "utf8",
          ).trim(),
        },
      });
    if (command === "account import") {
      const credential = object(
        JSON.parse(readFileSync(string(values.file, "file"), "utf8")),
      );
      if (values["oauth-client"]) {
        const source = object(
          JSON.parse(readFileSync(values["oauth-client"], "utf8")),
        );
        const client = object(source.installed ?? source);
        credential.client_id = client.client_id;
        credential.client_secret = client.client_secret;
      }
      result = store.addAccount({
        name: values.name,
        kind: "oauth",
        project: values.project,
        credential,
      });
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    store.close();
  }
}
main().catch((error) => {
  console.error(
    error instanceof GatewayError
      ? error.message
      : "Operation failed; check protected input files, permissions and configuration",
  );
  process.exitCode = 1;
});
