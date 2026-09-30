import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderGlobalState, ProviderKind } from "@shared/types";
import { useProviderRuntimeStore } from "@/stores/provider-runtime-store";
import { stateKeyFor } from "@/lib/account-scope";
import { resetRateLimitWarningState, useRateLimitWarning } from "./use-rate-limit-warning";

const toastWarning = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    warning: (...args: unknown[]) => toastWarning(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

const provider = "claude" as ProviderKind;

function setStatus(status: "allowed" | "allowed_warning" | "rejected") {
  const state = {
    account: {
      rateLimits: [{ scope: "five_hour", windows: [{ status }] }],
    },
  } as ProviderGlobalState;
  act(() =>
    useProviderRuntimeStore.setState({
      providerGlobalState: { [stateKeyFor(provider)]: state },
    }),
  );
}

beforeEach(() => {
  resetRateLimitWarningState();
  toastWarning.mockReset();
  toastError.mockReset();
  useProviderRuntimeStore.setState({ providerGlobalState: {} });
});

describe("useRateLimitWarning", () => {
  it("does not repeat an unchanged warning after switching chats", () => {
    setStatus("allowed_warning");
    const first = renderHook(() => useRateLimitWarning(provider, vi.fn()));
    expect(toastWarning).toHaveBeenCalledTimes(1);
    first.unmount();

    renderHook(() => useRateLimitWarning(provider, vi.fn()));
    expect(toastWarning).toHaveBeenCalledTimes(1);
  });

  it("notifies again after the limit recovers and later re-enters warning", () => {
    setStatus("allowed_warning");
    const { rerender } = renderHook(() => useRateLimitWarning(provider, vi.fn()));
    expect(toastWarning).toHaveBeenCalledTimes(1);

    setStatus("allowed");
    rerender();
    setStatus("allowed_warning");
    rerender();

    expect(toastWarning).toHaveBeenCalledTimes(2);
  });
});
