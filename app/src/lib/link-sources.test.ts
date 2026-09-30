import { describe, expect, it } from "vitest";
import { isBareLink, matchLinkSource } from "./link-sources";

function identify(href: string): [string, string] | null {
  const match = matchLinkSource(href);
  return match ? [match.source.id, match.identifier] : null;
}

describe("matchLinkSource", () => {
  it.each([
    ["https://github.com/acme/relay/pull/482", "github", "relay#482"],
    ["https://github.com/acme/relay/pull/482/files#diff-1", "github", "relay#482"],
    ["https://github.com/acme/relay/issues/12", "github", "relay#12"],
    ["https://github.com/acme/relay/commit/abcdef1234567890", "github", "relay@abcdef1"],
    ["https://github.com/acme/relay", "github", "acme/relay"],
    ["https://github.com/acme/relay/blob/main/src/index.ts#L10", "github", "index.ts"],
    ["https://github.com/acme/relay/actions/runs/99", "github", "relay run 99"],
    ["https://gitlab.com/group/sub/api/-/merge_requests/7", "gitlab", "api!7"],
    ["https://gitlab.example.com/team/api/-/issues/3", "gitlab", "api#3"],
    ["https://gitlab.com/group/api/-/pipelines/1234", "gitlab", "api pipeline 1234"],
    ["https://gitlab.com/group/api/-/jobs/5678", "gitlab", "api job 5678"],
    ["https://bitbucket.org/ws/repo/pull-requests/5", "bitbucket", "repo#5"],
    ["https://acme.atlassian.net/browse/PROJ-123", "jira", "PROJ-123"],
    ["https://jira.acme.com/browse/OPS-9", "jira", "OPS-9"],
    [
      "https://acme.atlassian.net/jira/software/projects/P/boards/1?selectedIssue=PR-4",
      "jira",
      "PR-4",
    ],
    [
      "https://acme.atlassian.net/wiki/spaces/ENG/pages/123/Release+Process",
      "confluence",
      "Release Process",
    ],
    ["https://acme.sentry.io/issues/4412/?project=1", "sentry", "Issue 4412"],
    ["https://sentry.io/organizations/acme/issues/4412/", "sentry", "Issue 4412"],
    ["https://linear.app/acme/issue/ENG-42/fix-login", "linear", "ENG-42"],
    ["https://www.figma.com/design/AbC123/Checkout-Flow?node-id=1", "figma", "Checkout Flow"],
    [
      "https://www.notion.so/acme/Q3-Roadmap-0123456789abcdef0123456789abcdef",
      "notion",
      "Q3 Roadmap",
    ],
    ["https://www.npmjs.com/package/@scope/pkg", "npm", "@scope/pkg"],
    [
      "https://abc12345.apps.dynatrace.com/ui/apps/dynatrace.dashboards/dashboard/9f8e7d6c-1234-4abc-9def-0123456789ab",
      "dynatrace",
      "Dashboard 9f8e7d6c",
    ],
    [
      "https://abc12345.live.dynatrace.com/#dashboard;gtf=-2h;gf=all;id=0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "dynatrace",
      "Dashboard 0a1b2c3d",
    ],
  ])("%s", (href, source, identifier) => {
    expect(identify(href)).toEqual([source, identifier]);
  });

  it.each([
    "https://example.com/browse/PROJ-1",
    "https://github.com/settings/profile",
    "https://github.com/acme/relay/pulls",
    "https://acme.atlassian.net/browse/not-a-key",
    "https://acme.sentry.io/issues/",
    "https://abc12345.live.dynatrace.com/#services",
    "https://www.dynatrace.com/platform/dashboards/",
    "relay-file-mention:foo.ts",
    "/local/path",
    "not a url",
  ])("ignores %s", (href) => {
    expect(identify(href)).toBeNull();
  });
});

describe("isBareLink", () => {
  it("treats autolinked URLs as bare", () => {
    expect(isBareLink("https://github.com/a/b/pull/1", "https://github.com/a/b/pull/1")).toBe(true);
    expect(isBareLink("www.github.com/a/b/", "http://www.github.com/a/b")).toBe(true);
  });

  it("keeps author labels", () => {
    expect(isBareLink("the fix", "https://github.com/a/b/pull/1")).toBe(false);
    expect(isBareLink("", "https://github.com/a/b/pull/1")).toBe(false);
  });
});
