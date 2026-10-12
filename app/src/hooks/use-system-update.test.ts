import { describe, expect, it } from "vitest";
import { describeUpdateStage } from "./use-system-update";

describe("desktop update stages", () => {
  it("distinguishes release downloads from source builds", () => {
    expect(describeUpdateStage("updating", "downloading")).toBe("Downloading Relay…");
    expect(describeUpdateStage("updating", "building")).toBe("Building Relay…");
  });
  it("explains deferred installation while chats are active", () => {
    expect(describeUpdateStage("available", "waiting")).toBe("Waiting for active chats to finish…");
    expect(describeUpdateStage("restart_pending", "restarting")).toBe("Restarting Relay…");
  });
});
