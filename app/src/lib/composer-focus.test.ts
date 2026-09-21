import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldAutoFocusComposer } from "./composer-focus";

function stubPointer(coarse: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: coarse)" ? coarse : false,
  }));
}

describe("shouldAutoFocusComposer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows auto-focus on fine-pointer devices", () => {
    stubPointer(false);
    expect(shouldAutoFocusComposer()).toBe(true);
  });

  it("suppresses auto-focus on touch devices", () => {
    stubPointer(true);
    expect(shouldAutoFocusComposer()).toBe(false);
  });

  it("allows auto-focus when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(shouldAutoFocusComposer()).toBe(true);
  });
});
