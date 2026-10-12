import { DatabaseSync } from "node:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export class GatewayError extends Error {
  constructor(
    public code: number,
    message: string,
    public status = "FAILED_PRECONDITION",
    public retryAfter?: number,
  ) {
    super(message);
  }
}
export type Credential = {
  api_key?: string;
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  client_id?: string;
  client_secret?: string;
};
export type Bucket = {
  modelId?: string;
  remainingFraction?: number;
  remainingAmount?: string;
  resetTime?: string;
  tokenType?: string;
};
export type Account = {
  id: string;
  name: string;
  kind: "api-key" | "oauth";
  project: string;
  quotaScope: string;
  models: string[];
  maxInflight: number;
  enabled: boolean;
  state: "ready" | "reauth_required";
  quota: { buckets: Bucket[] } | null;
  quotaUpdatedAt: number | null;
  createdAt: number;
};
export type ClientKey = {
  id: string;
  name: string;
  accounts: string[];
  enabled: boolean;
  createdAt: number;
};
export type RequestRecord = {
  id: string;
  accountId: string | null;
  model: string;
  method: string;
  status: number;
  outcome: "success" | "failed" | "partial" | "cancelled";
  attempts: number;
  tokens: number;
  durationMs: number;
  createdAt: number;
};
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const token = (prefix: string) =>
  `${prefix}${randomBytes(32).toString("base64url")}`;
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new GatewayError(400, "Expected a JSON object", "INVALID_ARGUMENT");
  return value as Record<string, unknown>;
}
export function string(value: unknown, name: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new GatewayError(400, `Invalid ${name}`, "INVALID_ARGUMENT");
  return value.trim();
}
function models(value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 200 ||
    value.some(
      (v) => typeof v !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(v),
    )
  )
    throw new GatewayError(400, "Invalid models", "INVALID_ARGUMENT");
  return [...new Set(value)] as string[];
}
function concurrency(value: unknown): number {
  if (value === undefined) return 4;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 64)
    throw new GatewayError(
      400,
      "maxInflight must be 1..64",
      "INVALID_ARGUMENT",
    );
  return Number(value);
}
function credential(kind: Account["kind"], input: unknown): Credential {
  const source = object(input);
  if (kind === "api-key")
    return { api_key: string(source.api_key, "API key", 4096) };
  const c: Credential = {};
  for (const field of [
    "access_token",
    "refresh_token",
    "client_id",
    "client_secret",
  ] as const) {
    if (source[field] !== undefined)
      c[field] = string(source[field], field, 16384);
  }
  if (source.expiry_date !== undefined) {
    if (
      typeof source.expiry_date !== "number" ||
      !Number.isFinite(source.expiry_date) ||
      source.expiry_date < 0
    )
      throw new GatewayError(400, "Invalid expiry_date", "INVALID_ARGUMENT");
    c.expiry_date = source.expiry_date;
  }
  if (!c.access_token && !c.refresh_token)
    throw new GatewayError(
      400,
      "OAuth requires access_token or refresh_token",
      "INVALID_ARGUMENT",
    );
  if (c.refresh_token && (!c.client_id || !c.client_secret))
    throw new GatewayError(
      400,
      "Refresh requires matching client_id and client_secret; supply --oauth-client on CLI import",
      "INVALID_ARGUMENT",
    );
  if (!c.refresh_token && (!c.expiry_date || c.expiry_date <= Date.now()))
    throw new GatewayError(
      400,
      "Access-token-only import requires a future expiry_date",
      "INVALID_ARGUMENT",
    );
  return c;
}

export class Store {
  readonly db: DatabaseSync;
  readonly master: Buffer;
  private lock: string;
  private closed = false;
  readonly initialTokens?: { adminToken: string; clientKey: string };
  constructor(
    readonly dir: string,
    initialize = false,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.lock = join(dir, "instance.lock");
    this.acquire();
    try {
      const path = join(dir, "secrets.json");
      if (initialize) {
        if (existsSync(path))
          throw new GatewayError(409, "Already initialized");
        const adminToken = token("glb-admin-");
        writeFileSync(
          path,
          JSON.stringify({
            version: 1,
            master: randomBytes(32).toString("base64"),
            adminHash: hash(adminToken),
          }),
          { mode: 0o600, flag: "wx" },
        );
        this.initialTokens = { adminToken, clientKey: "" };
      }
      if (!existsSync(path)) throw new GatewayError(409, "Run init first");
      chmodSync(path, 0o600);
      const secrets = JSON.parse(readFileSync(path, "utf8"));
      this.master = Buffer.from(secrets.master, "base64");
      if (secrets.version !== 1 || this.master.length !== 32)
        throw new Error("Invalid secrets file");
      this.db = new DatabaseSync(join(dir, "gateway.db"));
      chmodSync(join(dir, "gateway.db"), 0o600);
      const version = this.db.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      if (version.user_version > 1)
        throw new Error("Database belongs to a newer version");
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL, credential TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS client_keys (id TEXT PRIMARY KEY, key_hash TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS cooldowns (scope TEXT NOT NULL, model TEXT NOT NULL, until INTEGER NOT NULL, PRIMARY KEY(scope,model));
        CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, created INTEGER NOT NULL, data TEXT NOT NULL);
        PRAGMA user_version=1;`);
      if (this.initialTokens)
        this.initialTokens.clientKey = this.createKey({ name: "default" }).key;
    } catch (error) {
      rmSync(this.lock, { recursive: true, force: true });
      throw error;
    }
  }
  private acquire() {
    if (existsSync(this.lock)) {
      try {
        const owner = JSON.parse(
          readFileSync(join(this.lock, "owner.json"), "utf8"),
        );
        if (owner.host !== hostname())
          throw new GatewayError(
            409,
            "Data directory is locked by another host",
          );
        try {
          process.kill(owner.pid, 0);
          throw new GatewayError(
            409,
            "Another process owns this data directory; stop it before offline commands",
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        // Automatic stale-lock deletion races with another process acquiring it.
        throw new GatewayError(
          409,
          "Stale instance lock; verify the recorded process is stopped before removing instance.lock",
        );
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw new GatewayError(
          409,
          "Cannot verify instance lock; inspect instance.lock before removing a stale lock",
        );
      }
    }
    try {
      mkdirSync(this.lock, { mode: 0o700 });
    } catch {
      throw new GatewayError(409, "Data directory is already locked");
    }
    writeFileSync(
      join(this.lock, "owner.json"),
      JSON.stringify({ pid: process.pid, host: hostname() }),
      { mode: 0o600 },
    );
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    rmSync(this.lock, { recursive: true, force: true });
  }
  admin(value: string): boolean {
    return (
      hash(value) ===
      JSON.parse(readFileSync(join(this.dir, "secrets.json"), "utf8")).adminHash
    );
  }
  private encrypt(id: string, value: Credential): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.master, nonce);
    cipher.setAAD(Buffer.from(id));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString("base64");
  }
  credentials(id: string): Credential {
    const row = this.db
      .prepare("SELECT credential FROM accounts WHERE id=?")
      .get(id) as { credential: string } | undefined;
    if (!row) throw new GatewayError(404, "Account not found", "NOT_FOUND");
    const data = Buffer.from(row.credential, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.master,
      data.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        decipher.update(data.subarray(28)),
        decipher.final(),
      ]).toString(),
    );
  }
  saveCredentials(id: string, value: Credential) {
    this.db
      .prepare("UPDATE accounts SET credential=? WHERE id=?")
      .run(this.encrypt(id, value), id);
  }
  accounts(): Account[] {
    return (
      this.db.prepare("SELECT data FROM accounts ORDER BY rowid").all() as {
        data: string;
      }[]
    ).map((row) => JSON.parse(row.data));
  }
  account(id: string): Account {
    const row = this.db
      .prepare("SELECT data FROM accounts WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!row) throw new GatewayError(404, "Account not found", "NOT_FOUND");
    return JSON.parse(row.data);
  }
  saveAccount(a: Account) {
    this.db
      .prepare("UPDATE accounts SET data=? WHERE id=?")
      .run(JSON.stringify(a), a.id);
  }
  addAccount(input: unknown): Account {
    const b = object(input);
    const name = string(b.name, "name");
    if (b.kind !== "api-key" && b.kind !== "oauth")
      throw new GatewayError(400, "Invalid account kind", "INVALID_ARGUMENT");
    const project = string(b.project, "project");
    if (!/^[a-zA-Z0-9._:-]{1,256}$/.test(project))
      throw new GatewayError(400, "Invalid project", "INVALID_ARGUMENT");
    const id = randomUUID();
    const c = credential(b.kind, b.credential);
    const a: Account = {
      id,
      name,
      kind: b.kind,
      project,
      quotaScope: b.kind === "api-key" ? `api:${project}` : `oauth:${id}`,
      models: models(b.models),
      maxInflight: concurrency(b.maxInflight),
      enabled: true,
      state: "ready",
      quota: null,
      quotaUpdatedAt: null,
      createdAt: Date.now(),
    };
    this.db
      .prepare("INSERT INTO accounts VALUES (?,?,?)")
      .run(id, JSON.stringify(a), this.encrypt(id, c));
    return a;
  }
  patchAccount(id: string, input: unknown): Account {
    const b = object(input),
      a = this.account(id);
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== "boolean")
        throw new GatewayError(400, "Invalid enabled", "INVALID_ARGUMENT");
      a.enabled = b.enabled;
    }
    if (b.models !== undefined) a.models = models(b.models);
    if (b.maxInflight !== undefined) a.maxInflight = concurrency(b.maxInflight);
    this.saveAccount(a);
    return a;
  }
  reimport(id: string, input: unknown): Account {
    const a = this.account(id);
    this.saveCredentials(id, credential(a.kind, object(input).credential));
    a.state = "ready";
    this.saveAccount(a);
    return a;
  }
  createKey(input: unknown): { id: string; key: string } {
    const b = object(input),
      id = randomUUID(),
      key = token("glb-");
    const allowed = b.accounts ?? [];
    if (!Array.isArray(allowed) || allowed.some((v) => typeof v !== "string"))
      throw new GatewayError(400, "Invalid account scope", "INVALID_ARGUMENT");
    for (const accountId of allowed) this.account(accountId);
    const data: ClientKey = {
      id,
      name: string(b.name, "name"),
      accounts: [...new Set(allowed)],
      enabled: true,
      createdAt: Date.now(),
    };
    this.db
      .prepare("INSERT INTO client_keys VALUES (?,?,?)")
      .run(id, hash(key), JSON.stringify(data));
    return { id, key };
  }
  keys(): ClientKey[] {
    return (
      this.db.prepare("SELECT data FROM client_keys").all() as {
        data: string;
      }[]
    ).map((row) => JSON.parse(row.data));
  }
  patchKey(id: string, input: unknown): ClientKey {
    const b = object(input),
      k = this.keys().find((k) => k.id === id);
    if (!k) throw new GatewayError(404, "Client key not found", "NOT_FOUND");
    if (typeof b.enabled !== "boolean")
      throw new GatewayError(400, "Invalid enabled", "INVALID_ARGUMENT");
    k.enabled = b.enabled;
    this.db
      .prepare("UPDATE client_keys SET data=? WHERE id=?")
      .run(JSON.stringify(k), id);
    return k;
  }
  authenticate(value: string): ClientKey {
    const row = this.db
      .prepare("SELECT data FROM client_keys WHERE key_hash=?")
      .get(hash(value)) as { data: string } | undefined;
    const k: ClientKey | undefined = row && JSON.parse(row.data);
    if (!k?.enabled)
      throw new GatewayError(
        401,
        "Valid gateway client key required",
        "UNAUTHENTICATED",
      );
    return k;
  }
  session(keyId: string, session: string): string | undefined {
    const row = this.db
      .prepare("SELECT account_id FROM sessions WHERE id=? AND expires>?")
      .get(hash(`${keyId}\0${session}`), Date.now()) as
      { account_id: string } | undefined;
    return row?.account_id;
  }
  bind(keyId: string, session: string, accountId: string) {
    this.db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
    this.db
      .prepare("INSERT OR REPLACE INTO sessions VALUES (?,?,?)")
      .run(hash(`${keyId}\0${session}`), accountId, Date.now() + 86400_000);
  }
  cooldown(scope: string, model: string, until: number) {
    this.db
      .prepare(
        "INSERT INTO cooldowns VALUES (?,?,?) ON CONFLICT(scope,model) DO UPDATE SET until=MAX(until,excluded.until)",
      )
      .run(scope, model, until);
  }
  cooldownUntil(scope: string, model?: string): number {
    const row = (
      model === undefined
        ? this.db
            .prepare("SELECT MAX(until) AS until FROM cooldowns WHERE scope=?")
            .get(scope)
        : this.db
            .prepare(
              "SELECT MAX(until) AS until FROM cooldowns WHERE scope=? AND model IN (?, '*')",
            )
            .get(scope, model)
    ) as { until: number | null };
    return row.until ?? 0;
  }
  record(r: RequestRecord) {
    this.db
      .prepare("INSERT INTO requests VALUES (?,?,?)")
      .run(r.id, r.createdAt, JSON.stringify(r));
    this.db.exec(
      "DELETE FROM requests WHERE rowid NOT IN (SELECT rowid FROM requests ORDER BY rowid DESC LIMIT 1000)",
    );
  }
  requests(): RequestRecord[] {
    return (
      this.db
        .prepare("SELECT data FROM requests ORDER BY rowid DESC LIMIT 1000")
        .all() as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
}
