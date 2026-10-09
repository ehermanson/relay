import { describe, expect, it } from "vitest";
import {
  choosePreferredEndpoint,
  endpointHint,
  resolveEndpointSelection,
  type RemoteAccessEndpoint,
} from "./remote-access";

function endpoint(
  id: string,
  kind: RemoteAccessEndpoint["kind"],
  url: string,
): RemoteAccessEndpoint {
  return {
    id,
    kind,
    url,
    label: id,
  };
}

describe("remote access helpers", () => {
  it("prefers a non-local browser origin over tailscale and lan", () => {
    const endpoints = [
      endpoint("tailscale", "tailscale", "http://100.99.1.2:7777"),
      endpoint("browser", "browser", "https://relay.example.com"),
      endpoint("lan", "lan", "http://192.168.1.25:7777"),
    ];

    expect(choosePreferredEndpoint(endpoints)).toBe("browser");
  });

  it("prefers a tunnel when the current browser is local", () => {
    const endpoints = [
      endpoint("browser", "browser", "http://localhost:7777"),
      endpoint("tailscale", "tailscale", "http://100.99.1.2:7777"),
      endpoint("tunnel", "tunnel", "https://relay.example.com"),
    ];
    expect(choosePreferredEndpoint(endpoints)).toBe("tunnel");
    expect(endpointHint(endpoints[2])).toContain("any network");
  });

  it("restores a persisted endpoint choice when it is still available", () => {
    const endpoints = [
      endpoint("browser", "browser", "http://localhost:7777"),
      endpoint("lan", "lan", "http://192.168.1.25:7777"),
      endpoint("tailscale", "tailscale", "http://100.99.1.2:7777"),
    ];

    expect(resolveEndpointSelection(endpoints, "lan")).toBe("lan");
  });

  it("falls back to the best endpoint when the persisted choice is stale", () => {
    const endpoints = [
      endpoint("browser", "browser", "http://localhost:7777"),
      endpoint("tailscale", "tailscale", "http://100.99.1.2:7777"),
      endpoint("lan", "lan", "http://192.168.1.25:7777"),
    ];

    expect(resolveEndpointSelection(endpoints, "missing")).toBe("tailscale");
  });

  it("returns the expected hint text for localhost and reachable endpoints", () => {
    expect(endpointHint(endpoint("local", "localhost", "http://localhost:7777"))).toContain(
      "Local only",
    );
    expect(endpointHint(endpoint("lan", "lan", "http://192.168.1.25:7777"))).toContain(
      "same local network",
    );
    expect(endpointHint(endpoint("tailscale", "tailscale", "http://100.99.1.2:7777"))).toContain(
      "tailnet",
    );
  });
});
