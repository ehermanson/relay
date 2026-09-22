import { afterEach, expect, it, vi } from "vitest";
import { runProviderUpdate } from "./api";

afterEach(() => vi.unstubAllGlobals());
it.each(["updated", "unchanged", "unverified", "failed", "no_update"])(
  "preserves %s result and command output",
  async (status) => {
    const response = {
      result: {
        status,
        output: "brew diagnostic",
        command: "brew upgrade codex",
        message: "result",
      },
      providers: [],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(response)));
    expect(await runProviderUpdate("codex")).toEqual(response);
  },
);
it("rejects a response without verification instead of implying success", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ providers: [] })));
  await expect(runProviderUpdate("codex")).rejects.toThrow("missing verification details");
});
