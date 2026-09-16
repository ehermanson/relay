import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityGroup } from "./activity-group";

vi.mock("@/components/chat/markdown-content", () => ({ ImageThumbnail: () => null }));
afterEach(cleanup);

describe("custom tool activity visibility", () => {
  it("expands code-mode calls to show their script and output", () => {
    const view = render(
      <ActivityGroup
        activities={[
          {
            type: "activity",
            activity: "tool_use",
            tool: "ExecuteCode",
            description: "Run code",
            input: { code: 'text(await tools.exec_command({cmd: "ls"}));' },
            mergedResultDetail: "file.ts",
            mergedResultStatus: "success",
          },
        ]}
      />,
    );
    fireEvent.click(view.getByText("Run code"));
    expect(view.getByText("Code")).toBeTruthy();
    expect(view.container.textContent).toContain("tools.exec_command");
    expect(view.getByText("file.ts")).toBeTruthy();
  });
  it("keeps legacy freeform calls visible while hiding actual progress updates", () => {
    const view = render(
      <ActivityGroup
        activities={[
          {
            type: "activity",
            activity: "tool_use",
            tool: "exec",
            description: "Using exec",
            detail: "text(42)",
          },
          { type: "activity", activity: "tool_use", tool: "Bash", description: "Running... 2s" },
        ]}
      />,
    );
    fireEvent.click(view.getByText("Using exec"));
    expect(view.container.textContent).toContain("text(42)");
    expect(view.queryByText("Running... 2s")).toBeNull();
  });
});

describe("readable command rows", () => {
  it("shows the label first and the exact command and output only on expansion", () => {
    const command =
      "/bin/zsh -lc 'PATH=\"/tools/bin:$PATH\" git push origin main > /tmp/push.log 2>&1'";
    const view = render(
      <ActivityGroup
        activities={[
          {
            type: "activity",
            activity: "tool_use",
            tool: "Bash",
            description: "Push changes",
            detail: command,
            input: { command },
            inputDescription: "Push changes",
            mergedResultDetail: "Everything up-to-date",
            mergedResultStatus: "success",
          },
        ]}
      />,
    );
    expect(view.getByText("Push changes")).toBeTruthy();
    expect(view.container.textContent).not.toContain(command);
    expect(view.queryByText("Everything up-to-date")).toBeNull();
    fireEvent.click(view.getByText("Push changes"));
    expect(view.container.textContent).toContain(command);
    expect(view.getByText("Everything up-to-date")).toBeTruthy();
  });
});
