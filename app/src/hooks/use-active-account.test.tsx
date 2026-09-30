import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus } from "@shared/types";

const fetchAccounts = vi.fn<() => Promise<AccountStatus[]>>();
vi.mock("@/lib/api", () => ({ fetchAccounts: () => fetchAccounts() }));

import { useActiveAccount, useActiveAccountStore } from "./use-active-account";

const defaultAccount: AccountStatus = {
  id: "default",
  label: "Personal",
  isDefault: true,
  logins: {
    claude: { configDir: "/Users/me/.claude", probeState: "ok" },
    codex: { configDir: "/Users/me/.codex", probeState: "ok" },
  },
};
const work: AccountStatus = {
  id: "work",
  label: "Work",
  isDefault: false,
  logins: { claude: { configDir: "/Users/me/.claude-work", probeState: "ok" } },
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  fetchAccounts.mockReset();
  useActiveAccountStore.setState({ storedId: null });
});

afterEach(() => {
  localStorage.clear();
});

describe("useActiveAccount", () => {
  it("changes nothing with a single account, even with a stale stored choice", async () => {
    fetchAccounts.mockResolvedValue([defaultAccount]);
    useActiveAccountStore.setState({ storedId: "work" });
    const { result } = renderHook(() => useActiveAccount(), { wrapper });
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));

    expect(result.current.isMulti).toBe(false);
    expect(result.current.activeId).toBe("default");
    expect(result.current.accountIdParam).toBeUndefined();
    expect(result.current.loginDirFor("claude")).toBeUndefined();
  });

  it("counts a failed accounts query as single-account", async () => {
    fetchAccounts.mockRejectedValue(new Error("nope"));
    useActiveAccountStore.setState({ storedId: "work" });
    const { result } = renderHook(() => useActiveAccount(), { wrapper });
    await waitFor(() => expect(fetchAccounts).toHaveBeenCalled());

    expect(result.current.isMulti).toBe(false);
    expect(result.current.accountIdParam).toBeUndefined();
    expect(result.current.loginDirFor("claude")).toBeUndefined();
  });

  it("keeps the default account's wire unchanged with several accounts", async () => {
    fetchAccounts.mockResolvedValue([defaultAccount, work]);
    const { result } = renderHook(() => useActiveAccount(), { wrapper });
    await waitFor(() => expect(result.current.isMulti).toBe(true));

    expect(result.current.activeId).toBe("default");
    expect(result.current.accountIdParam).toBeUndefined();
    expect(result.current.loginDirFor("claude")).toBeUndefined();
  });

  it("scopes to a non-default account and never borrows another account's login", async () => {
    fetchAccounts.mockResolvedValue([defaultAccount, work]);
    useActiveAccountStore.setState({ storedId: "work" });
    const { result } = renderHook(() => useActiveAccount(), { wrapper });
    await waitFor(() => expect(result.current.isMulti).toBe(true));

    expect(result.current.active?.label).toBe("Work");
    expect(result.current.accountIdParam).toBe("work");
    expect(result.current.loginDirFor("claude")).toBe("/Users/me/.claude-work");
    expect(result.current.loginDirFor("codex")).toBeUndefined();
  });
});
