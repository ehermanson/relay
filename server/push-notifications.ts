import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import webpush from "web-push";
import type { AuthManager } from "#server/auth.js";
import type { InstanceManager } from "#core/instance-manager.js";
import type { InstanceInfo, UserMessage } from "#core/types.js";
import type { RelayConfig } from "#server/config.js";

interface SubscriptionRecord {
  owner: string;
  subscription: webpush.PushSubscription;
}
interface State {
  publicKey: string;
  privateKey: string;
  subscriptions: SubscriptionRecord[];
}

/** VAPID `sub` claim: a contact for push-service operators, never verified or
 * mailed. Apple rejects `localhost` subjects with 403 BadJwtToken. */
const DEFAULT_PUSH_CONTACT = "https://github.com/ehermanson/relay";

export function resolvePushContact(value = process.env.RELAY_PUSH_CONTACT): string {
  const contact = value?.trim();
  return contact && /^(mailto:|https:\/\/)/.test(contact) ? contact : DEFAULT_PUSH_CONTACT;
}

function allowedEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (host === "fcm.googleapis.com" ||
        host === "updates.push.services.mozilla.com" ||
        host === "web.push.apple.com" ||
        host.endsWith(".push.apple.com") ||
        host.endsWith(".notify.windows.com"))
    );
  } catch {
    return false;
  }
}

function chatPath(instance: InstanceInfo): string {
  const project = encodeURIComponent(
    instance.projectSlug ??
      instance.projectId ??
      (instance.originalDirectory ?? instance.workingDirectory).split("/").pop() ??
      "",
  );
  const chat = encodeURIComponent(instance.id);
  return instance.spaceId
    ? `/projects/${project}/spaces/${encodeURIComponent(instance.spaceId)}/${chat}`
    : `/projects/${project}/chats/${chat}`;
}

export class PushNotifications {
  private readonly auth: AuthManager;
  private readonly path: string;
  private state: State;
  private readonly awaiting = new Set<string>();
  private readonly previous = new Map<string, { status: string; attention?: string }>();
  private readonly presence = new Map<string, { instanceId: string; expiresAt: number }>();

  constructor(auth: AuthManager, manager: InstanceManager, config: RelayConfig) {
    this.auth = auth;
    this.path = join(dirname(config.dbPath), "push-notifications.json");
    if (existsSync(this.path)) {
      this.state = JSON.parse(readFileSync(this.path, "utf8")) as State;
    } else {
      const keys = webpush.generateVAPIDKeys();
      this.state = { publicKey: keys.publicKey, privateKey: keys.privateKey, subscriptions: [] };
      this.persist();
    }

    manager.on("instance:user", (id: string, message: UserMessage) => {
      if (!message.internal && !message.queued && !manager.getInstance(id)?.external)
        this.awaiting.add(id);
    });
    manager.on("instance:status", (id: string, instance: InstanceInfo) => {
      const attention =
        instance.pendingPermission?.requestId ??
        instance.pendingTool ??
        (instance.pendingPlan ? "plan" : undefined);
      const previous = this.previous.get(id);
      this.previous.set(id, { status: instance.status, attention });
      if (instance.external) return;
      if (instance.status === "stopped") this.awaiting.delete(id);
      if (attention && attention !== previous?.attention) {
        void this.notify(
          instance,
          "Needs input",
          `${instance.name} needs your input`,
          `attention:${id}:${attention}`,
        );
      } else if (
        previous?.status === "processing" &&
        (instance.status === "idle" || instance.status === "error") &&
        !attention &&
        this.awaiting.delete(id)
      ) {
        void this.notify(
          instance,
          instance.status === "error" ? "Needs attention" : "Ready",
          instance.status === "error"
            ? `${instance.name} stopped with an error`
            : `${instance.name} finished responding`,
          `done:${id}:${instance.lastActivityAt}`,
        );
      }
    });
    manager.on("instance:removed", (id: string) => {
      this.awaiting.delete(id);
      this.previous.delete(id);
    });
  }

  get publicKey(): string {
    return this.state.publicKey;
  }

  has(owner: string, endpoint: string): boolean {
    return this.state.subscriptions.some(
      (entry) => entry.owner === owner && entry.subscription.endpoint === endpoint,
    );
  }

  subscribe(owner: string, subscription: webpush.PushSubscription): void {
    if (
      !allowedEndpoint(subscription.endpoint) ||
      !subscription.keys?.p256dh ||
      !subscription.keys?.auth
    ) {
      throw new Error("Unsupported push subscription");
    }
    if (
      subscription.endpoint.length > 2048 ||
      subscription.keys.p256dh.length > 512 ||
      subscription.keys.auth.length > 512
    ) {
      throw new Error("Invalid push subscription");
    }
    this.state.subscriptions = this.state.subscriptions.filter(
      (entry) => entry.subscription.endpoint !== subscription.endpoint,
    );
    this.state.subscriptions.push({ owner, subscription });
    this.persist();
  }

  unsubscribe(owner: string, endpoint: string): void {
    this.state.subscriptions = this.state.subscriptions.filter(
      (entry) => entry.owner !== owner || entry.subscription.endpoint !== endpoint,
    );
    this.presence.delete(endpoint);
    this.persist();
  }

  setPresence(owner: string, endpoint: string, instanceId: string | null): void {
    if (!this.has(owner, endpoint)) return;
    if (instanceId) this.presence.set(endpoint, { instanceId, expiresAt: Date.now() + 45_000 });
    else this.presence.delete(endpoint);
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  private async notify(
    instance: InstanceInfo,
    title: string,
    body: string,
    tag: string,
  ): Promise<void> {
    const payload = JSON.stringify({ title, body, url: chatPath(instance), tag });
    for (const entry of this.state.subscriptions) {
      const presence = this.presence.get(entry.subscription.endpoint);
      if (
        (presence?.instanceId === "*" || presence?.instanceId === instance.id) &&
        presence.expiresAt > Date.now()
      )
        continue;
      if (this.auth.authRequired && !this.auth.validateSession(entry.owner)) {
        try {
          this.unsubscribe(entry.owner, entry.subscription.endpoint);
        } catch {
          /* retry cleanup on next event */
        }
        continue;
      }
      try {
        await webpush.sendNotification(entry.subscription, payload, {
          vapidDetails: {
            subject: resolvePushContact(),
            publicKey: this.state.publicKey,
            privateKey: this.state.privateKey,
          },
          TTL: 3600,
        });
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          try {
            this.unsubscribe(entry.owner, entry.subscription.endpoint);
          } catch {
            /* retry later */
          }
        }
        // Network/provider errors are transient. Never log endpoint or keys.
      }
    }
  }
}
