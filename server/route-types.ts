import type { HttpBindings } from "@hono/node-server";
import type { Session } from "#core/types.js";
import type { AuthManager } from "#server/auth.js";
import type { InstanceManager } from "#core/instance-manager.js";
import type { RelayConfig } from "#server/config.js";
import type { UpdateManager } from "#server/update-manager.js";
import type { PushNotifications } from "#server/push-notifications.js";
import type {
  NativeOpenRequest,
  NativeOpenTargetsResponse,
  ProviderCapabilities,
  ProviderDescriptor,
  ProviderKind,
  ProviderModelOption,
} from "#core/types.js";

export interface HttpDeps {
  config: RelayConfig;
  auth: AuthManager;
  instanceManager: InstanceManager;
  startedAt: number;
  packageVersion: string;
  selfGitInfo: { branch: string; isWorktree: boolean; worktreePath?: string } | null;
  uiDistDir: string;
  indexHtmlPath: string;
  getConnectionCount?: () => number;
  getProviderModels: (provider: ProviderKind) => Promise<ProviderModelOption[]>;
  getProviderCapabilities: (provider: ProviderKind) => ProviderCapabilities;
  getAvailableProviders: () => ProviderDescriptor[];
  getOpenTargets: (targetPath: string) => Promise<NativeOpenTargetsResponse>;
  openNativePath: (request: NativeOpenRequest) => Promise<void>;
  getGitRepos: () => Promise<string[]>;
  updateManager: UpdateManager;
  pushNotifications?: PushNotifications;
}

export interface ContextVariables {
  session: Session | null;
  isAuthenticated: boolean;
}

export interface AppEnv {
  Bindings: HttpBindings;
  Variables: ContextVariables;
}
