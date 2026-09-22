import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProviderVersionAdvisory } from "@shared/types";
import { ProviderVersionAdvisoryCard } from "./global-settings-page";
import { runProviderUpdate } from "@/lib/api";
import { toast } from "sonner";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  runProviderUpdate: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
const advisory: ProviderVersionAdvisory = {
  status: "behind_latest",
  currentVersion: "0.155.1",
  latestVersion: "0.156.0",
  availableVersion: "0.156.0",
  installMethod: "brew",
  updateCommand: "brew upgrade codex",
  checkedAt: null,
  packageName: "@openai/codex",
};
function setup(value = advisory) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (next: ProviderVersionAdvisory) => (
    <QueryClientProvider client={client}>
      <ProviderVersionAdvisoryCard provider="codex" advisory={next} />
    </QueryClientProvider>
  );
  return { ...render(view(value)), view };
}
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("provider version settings", () => {
  it("explains Homebrew lag without an update button", () => {
    setup({ ...advisory, availableVersion: "0.155.1" });
    expect(screen.queryByRole("button", { name: "Update now" })).toBeNull();
    expect(screen.getByText(/No newer Homebrew version/)).toBeTruthy();
  });
  it.each(["unchanged", "unverified", "failed"] as const)(
    "shows %s diagnostics without a success toast",
    async (status) => {
      vi.mocked(runProviderUpdate).mockResolvedValue({
        providers: [],
        result: {
          status,
          command: "brew upgrade codex",
          output: "Homebrew diagnostic",
          message: "No upgrade verified",
        },
      });
      const result = setup();
      fireEvent.click(screen.getByRole("button", { name: "Update now" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
      expect(await screen.findByText(/Homebrew diagnostic/)).toBeTruthy();
      expect(screen.getByText("Command output").closest("details")?.open).toBe(true);
      expect(toast.success).not.toHaveBeenCalled();
      // Re-probing must not make the diagnostics disappear.
      result.rerender(result.view({ ...advisory, status: "unknown" }));
      expect(screen.getByText(/Homebrew diagnostic/)).toBeTruthy();
    },
  );
  it("retains successful command output after the advisory becomes current", async () => {
    vi.mocked(runProviderUpdate).mockResolvedValue({
      providers: [],
      result: {
        status: "updated",
        command: "brew upgrade codex",
        output: "Installed 0.156.0",
        message: "Updated to v0.156.0",
      },
    });
    const result = setup();
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByText("Updated to v0.156.0");
    expect(toast.success).toHaveBeenCalledWith("Updated to v0.156.0");
    result.rerender(result.view({ ...advisory, status: "current", currentVersion: "0.156.0" }));
    expect(screen.getByText(/Installed 0.156.0/)).toBeTruthy();
  });
});
