import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentInfo } from "@shared/types";
import { AgentStopButton } from "@/components/chat/agent-stop-button";

const running: AgentInfo = {
  agentId: "toolu_1",
  providerAgentId: "task-1",
  status: "running",
};

describe("AgentStopButton", () => {
  it("stops a running provider agent by its task id", () => {
    const onStop = vi.fn();
    const view = render(<AgentStopButton agent={running} onStop={onStop} />);
    fireEvent.click(view.getByLabelText("Stop this agent"));
    expect(onStop).toHaveBeenCalledWith("task-1");
  });

  it("renders nothing when it can't or shouldn't stop", () => {
    const onStop = vi.fn();
    const cases: Array<[AgentInfo, typeof onStop | undefined]> = [
      [running, undefined], // provider can't stop one agent
      [{ ...running, status: "completed" }, onStop],
      [{ ...running, providerAgentId: undefined }, onStop],
      [{ ...running, origin: "relay" }, onStop], // Relay tasks have their own Stop
    ];
    for (const [agent, handler] of cases) {
      const view = render(<AgentStopButton agent={agent} onStop={handler} />);
      expect(view.container.innerHTML).toBe("");
      view.unmount();
    }
  });
});
