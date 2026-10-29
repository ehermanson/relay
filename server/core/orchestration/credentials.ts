import { createHash, randomBytes } from "node:crypto";

/**
 * Bearer tokens for Relay's `/mcp` endpoint, one per chat.
 *
 * `/mcp` sits outside the browser's cookie auth: the token *is* the auth, and
 * it identifies the calling chat. Only a hash is kept; the raw token lives in
 * the provider process (Claude: request header, Codex: env var) and is never
 * persisted. Issuing a new token for a chat revokes its previous one, so a
 * resumed or restarted session can't be impersonated with a stale token.
 * Tokens die with the server: a restart kills every provider process anyway,
 * and the next spawn issues a fresh one.
 */
export class OrchestrationCredentials {
  private byHash = new Map<string, string>();
  private hashByInstance = new Map<string, string>();

  /** Issue a token for `instanceId`, revoking any token it held before. */
  issue(instanceId: string): string {
    this.revoke(instanceId);
    const token = randomBytes(32).toString("base64url");
    const hash = hashToken(token);
    this.byHash.set(hash, instanceId);
    this.hashByInstance.set(instanceId, hash);
    return token;
  }

  /** The chat a token was issued to, or undefined for unknown/revoked tokens. */
  resolve(token: string | undefined | null): string | undefined {
    if (!token) return undefined;
    return this.byHash.get(hashToken(token));
  }

  revoke(instanceId: string): void {
    const hash = this.hashByInstance.get(instanceId);
    if (hash === undefined) return;
    this.byHash.delete(hash);
    this.hashByInstance.delete(instanceId);
  }

  revokeAll(): void {
    this.byHash.clear();
    this.hashByInstance.clear();
  }

  get size(): number {
    return this.byHash.size;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Extract the token from an `Authorization: Bearer <token>` header value. */
export function parseBearerToken(header: string | undefined | null): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1];
}
