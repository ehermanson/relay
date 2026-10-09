export type RemoteAccessEndpoint = {
  id: string;
  label: string;
  url: string;
  kind: "tailscale" | "lan" | "localhost" | "browser" | "tunnel";
};

export function isLocalhostUrl(url: string): boolean {
  return /\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/.test(url);
}

export function choosePreferredEndpoint(endpoints: RemoteAccessEndpoint[]): string {
  const browserRemote = endpoints.find(
    (endpoint) => endpoint.kind === "browser" && !isLocalhostUrl(endpoint.url),
  );
  if (browserRemote) return browserRemote.id;

  const tunnel = endpoints.find((endpoint) => endpoint.kind === "tunnel");
  if (tunnel) return tunnel.id;

  const tailscale = endpoints.find((endpoint) => endpoint.kind === "tailscale");
  if (tailscale) return tailscale.id;

  const lan = endpoints.find((endpoint) => endpoint.kind === "lan");
  if (lan) return lan.id;

  return endpoints[0]?.id ?? "";
}

export function resolveEndpointSelection(
  endpoints: RemoteAccessEndpoint[],
  storedId: string | null,
): string {
  if (storedId && endpoints.some((endpoint) => endpoint.id === storedId)) {
    return storedId;
  }
  return choosePreferredEndpoint(endpoints);
}

export function endpointHint(endpoint: Pick<RemoteAccessEndpoint, "url" | "kind"> | null): string {
  if (!endpoint) return "Waiting for Relay to report reachable addresses.";
  if (endpoint.kind === "localhost" || isLocalhostUrl(endpoint.url)) {
    return "Local only. This will not open from your phone unless the phone is on this same machine.";
  }
  if (endpoint.kind === "tunnel") {
    return "Works from any network while this machine is awake and Relay is running.";
  }
  if (endpoint.kind === "tailscale") {
    return "Works from any device on your tailnet, including cellular, as long as Tailscale is connected.";
  }
  if (endpoint.kind === "lan") {
    return "Works when your phone is on the same local network or Wi-Fi as this machine.";
  }
  return "Uses the address from your current browser session. This is usually the best option when you already opened Relay remotely.";
}
