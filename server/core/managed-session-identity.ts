import type { InstanceInfo, ProviderRuntimeBinding } from "#core/types.js";

export interface ManagedSessionKeys {
  providerSessionIds: Set<string>;
  transcriptPaths: Set<string>;
}

export interface ManagedSessionRowIdentity {
  provider_session_id: string | null;
  transcript_path: string | null;
}

export interface ExternalSessionRowIdentity {
  session_id: string;
  jsonl_path: string;
}

export interface ManagedShadowInstanceIdentity {
  external?: boolean;
  providerBinding?: ProviderRuntimeBinding;
  processBinding?: ProviderRuntimeBinding;
  sessionId?: string;
  infoSessionId?: string;
  jsonlPath?: string;
  externalJsonlPath?: string;
}

export function mergeProviderBinding(
  existing: ProviderRuntimeBinding | undefined,
  next: ProviderRuntimeBinding | undefined,
): ProviderRuntimeBinding | undefined {
  if (!existing) return next;
  if (!next) return existing;
  return {
    ...existing,
    ...next,
    runtimePayload: {
      ...(existing.runtimePayload ?? {}),
      ...(next.runtimePayload ?? {}),
    },
  };
}

export function buildPersistedRuntimePayload(
  runtimePayload: Record<string, unknown> | undefined,
  info: InstanceInfo,
): Record<string, unknown> | undefined {
  const next = { ...(runtimePayload ?? {}) };

  if (info.sessionContext) {
    next.sessionContext = info.sessionContext;
  } else {
    delete next.sessionContext;
  }

  if (info.review) {
    next.review = info.review;
  } else {
    delete next.review;
  }

  if (info.aside) {
    next.aside = info.aside;
  } else {
    delete next.aside;
  }

  if (info.reviewInstanceId) {
    next.reviewInstanceId = info.reviewInstanceId;
  } else {
    delete next.reviewInstanceId;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

export function collectManagedSessionKeys(options: {
  persistedRows?: ManagedSessionRowIdentity[];
  liveInstances: ManagedShadowInstanceIdentity[];
}): ManagedSessionKeys {
  const providerSessionIds = new Set<string>();
  const transcriptPaths = new Set<string>();

  for (const row of options.persistedRows ?? []) {
    if (row.provider_session_id) providerSessionIds.add(row.provider_session_id);
    if (row.transcript_path) transcriptPaths.add(row.transcript_path);
  }

  for (const instance of options.liveInstances) {
    if (instance.external) continue;
    const binding = instance.providerBinding ?? instance.processBinding;
    const providerSessionId =
      binding?.providerSessionId ?? instance.sessionId ?? instance.infoSessionId;
    const transcriptPath = binding?.transcriptPath ?? instance.jsonlPath;
    if (providerSessionId) providerSessionIds.add(providerSessionId);
    if (transcriptPath) transcriptPaths.add(transcriptPath);
  }

  return { providerSessionIds, transcriptPaths };
}

export function isManagedShadowSessionRow(
  row: ExternalSessionRowIdentity,
  keys: ManagedSessionKeys,
): boolean {
  return keys.providerSessionIds.has(row.session_id) || keys.transcriptPaths.has(row.jsonl_path);
}

export function isManagedShadowInstance(
  instance: ManagedShadowInstanceIdentity,
  keys: ManagedSessionKeys,
): boolean {
  if (!instance.external) return false;
  const binding = instance.providerBinding ?? instance.processBinding;
  const providerSessionId =
    binding?.providerSessionId ?? instance.sessionId ?? instance.infoSessionId;
  const transcriptPath =
    binding?.transcriptPath ?? instance.externalJsonlPath ?? instance.jsonlPath;
  return Boolean(
    (providerSessionId && keys.providerSessionIds.has(providerSessionId)) ||
    (transcriptPath && keys.transcriptPaths.has(transcriptPath)),
  );
}
