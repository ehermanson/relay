import type { Hono } from "hono";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  DEFAULT_ACCOUNT_ID,
  type Account,
  type AccountLoginStatus,
  type AccountStatus,
  type ProviderKind,
} from "#core/types.js";
import { normalizeConfigDir, validateAccountLabel, validateAccountLogins } from "#core/accounts.js";
import {
  getProviderAccountIdentitySnapshot,
  getRegisteredProviders,
  probeProviderAccountIdentity,
} from "#core/provider-registry.js";
import { readJsonBody } from "#server/hono-utils.js";
import type { AppEnv, HttpDeps } from "#server/route-types.js";

/** Expand a leading `~` and make the path absolute. */
function expandConfigDir(dir: string): string {
  const trimmed = dir.trim();
  const expanded =
    trimmed === "~"
      ? homedir()
      : trimmed.startsWith("~/")
        ? resolve(homedir(), trimmed.slice(2))
        : trimmed;
  return normalizeConfigDir(resolve(expanded));
}

/**
 * Expand every absolute/`~` login dir in a request body. Anything else
 * (relative paths, non-strings, blanks) is passed through untouched so the
 * shared shape validator rejects it with its own message.
 */
function expandLogins(logins: unknown): unknown {
  if (!logins || typeof logins !== "object" || Array.isArray(logins)) return logins;
  const out: Record<string, unknown> = {};
  for (const [provider, login] of Object.entries(logins)) {
    const dir =
      login && typeof login === "object" ? (login as { configDir?: unknown }).configDir : undefined;
    const trimmed = typeof dir === "string" ? dir.trim() : "";
    out[provider] =
      trimmed.startsWith("/") || trimmed.startsWith("~")
        ? { configDir: expandConfigDir(trimmed) }
        : login;
  }
  return out;
}

class AccountRequestError extends Error {
  status: 400 | 404;

  constructor(message: string, status: 400 | 404 = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Accounts — named contexts owning one login (config dir) per provider. The
 * default account is implicit (the server's own dirs; only its label is
 * stored). Accounts are mutated only here: `PATCH /api/settings` ignores
 * them. Identity is probed through the provider driver and cached per dir.
 */
export function registerAccountRoutes(app: Hono<AppEnv>, deps: HttpDeps): void {
  const { instanceManager, config } = deps;
  const store = () => instanceManager.accounts;

  /** Providers an account other than the default may carry a login for. */
  const loginProviders = (): ProviderKind[] =>
    getRegisteredProviders().filter(
      (provider) => deps.getProviderCapabilities(provider)?.supportsAccountLogins === true,
    );

  const toStatus = (account: Account): AccountStatus => {
    const logins: Partial<Record<ProviderKind, AccountLoginStatus>> = {};
    for (const [provider, login] of Object.entries(account.logins)) {
      if (!login) continue;
      logins[provider as ProviderKind] = {
        configDir: login.configDir,
        ...getProviderAccountIdentitySnapshot(provider as ProviderKind, login.configDir),
      };
    }
    return {
      id: account.id,
      label: account.label,
      isDefault: account.id === DEFAULT_ACCOUNT_ID,
      logins,
    };
  };

  const probeAccount = (account: Account, force: boolean): Promise<unknown> =>
    Promise.all(
      Object.entries(account.logins).map(([provider, login]) =>
        login
          ? probeProviderAccountIdentity(provider as ProviderKind, login.configDir, config.logger, {
              force,
            }).catch(() => {})
          : undefined,
      ),
    );

  // Fire-and-forget: the driver dedupes in-flight probes and honours its own
  // TTL, so calling this on every list is a cache hit in the common case.
  const kickProbe = (account: Account, force: boolean) => {
    void probeAccount(account, force);
  };

  /** Shape checks (shared validators) then filesystem checks on every login dir. */
  const checkLogins = (logins: unknown, excludeId?: string): unknown => {
    const expanded = expandLogins(logins);
    const validated = validateAccountLogins(expanded, store().list(), {
      loginProviders: loginProviders(),
      excludeId,
    });
    for (const login of Object.values(validated)) {
      if (!login) continue;
      if (!existsSync(login.configDir))
        throw new AccountRequestError(`Config directory does not exist: ${login.configDir}`);
      if (!statSync(login.configDir).isDirectory())
        throw new AccountRequestError(`Config directory is not a directory: ${login.configDir}`);
    }
    return validated;
  };

  const readBody = async <T>(c: Parameters<typeof readJsonBody>[0]): Promise<T> => {
    let body: T | null = null;
    try {
      body = await readJsonBody<T>(c);
    } catch {
      body = null;
    }
    if (!body || typeof body !== "object") throw new AccountRequestError("Invalid JSON body");
    return body;
  };

  const fail = (err: unknown, fallback: string) => {
    const message = err instanceof Error ? err.message : fallback;
    const status = err instanceof AccountRequestError ? err.status : 400;
    return { body: { error: message }, status };
  };

  app.get("/api/accounts", (c) => {
    const force = c.req.query("probe") === "1";
    const accounts = store().list();
    const rows = accounts.map(toStatus);
    // Unknown or expired snapshots get a background probe; fresh ones are a
    // no-op inside the driver's TTL. `?probe=1` bypasses the TTL for all.
    for (const account of accounts) kickProbe(account, force);
    return c.json(rows);
  });

  app.post("/api/accounts", async (c) => {
    try {
      const body = await readBody<{ label?: unknown; logins?: unknown }>(c);
      // Label first so a nameless request isn't answered with a path error.
      validateAccountLabel(body.label, store().list());
      const logins = checkLogins(body.logins);
      const account = store().create(
        { label: body.label, logins },
        { loginProviders: loginProviders() },
      );
      kickProbe(account, true);
      return c.json(toStatus(account), 201);
    } catch (err) {
      const { body, status } = fail(err, "Invalid account");
      return c.json(body, status);
    }
  });

  app.patch("/api/accounts/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const body = await readBody<{ label?: unknown; logins?: unknown }>(c);
      const current = store().get(id);
      if (!current) throw new AccountRequestError("Account not found", 404);
      if (body.label !== undefined)
        validateAccountLabel(body.label, store().list(), { excludeId: id });
      if (id === DEFAULT_ACCOUNT_ID && body.logins !== undefined) {
        throw new AccountRequestError(
          "The default account's logins are the server's own and cannot be edited",
        );
      }
      const logins = body.logins !== undefined ? checkLogins(body.logins, id) : undefined;
      const account = store().update(
        id,
        {
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(logins !== undefined ? { logins } : {}),
        },
        { loginProviders: loginProviders() },
      );
      if (logins !== undefined) kickProbe(account, true);
      return c.json(toStatus(account));
    } catch (err) {
      const { body, status } = fail(err, "Invalid account");
      return c.json(body, status);
    }
  });

  app.delete("/api/accounts/:id", (c) => {
    const id = c.req.param("id");
    if (id === DEFAULT_ACCOUNT_ID) {
      return c.json({ error: "The default account cannot be removed" }, 400);
    }
    if (!store().remove(id)) return c.json({ error: "Account not found" }, 404);
    // Membership: drop the account from every project; a project left with no
    // accounts falls back to the default. Chats already bound to one of its
    // logins keep their `config_dir` — they still run, they just no longer
    // belong to a named account.
    instanceManager.projectManager.removeAccountFromProjects(id);
    return c.json({ ok: true });
  });

  app.post("/api/accounts/:id/probe", async (c) => {
    const account = store().get(c.req.param("id"));
    if (!account) return c.json({ error: "Account not found" }, 404);
    // Awaited: a forced probe spawns a provider process per login (30s worst case).
    await probeAccount(account, true);
    return c.json(toStatus(account));
  });
}
