import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { accountInfoToStatus } from "../dist/server/core/providers/claude-sdk.js";

describe("accountInfoToStatus", () => {
  it("maps a claude.ai OAuth login to email/org/plan", () => {
    assert.deepEqual(
      accountInfoToStatus({
        email: "me@example.com",
        organization: "Acme",
        subscriptionType: "max",
        apiProvider: "firstParty",
        tokenSource: "none",
        apiKeySource: "none",
      }),
      { plan: "max", email: "me@example.com", label: "Acme" },
    );
  });

  it("describes an enterprise gateway login as status, never as the label", () => {
    assert.deepEqual(accountInfoToStatus({ apiProvider: "gateway" }), {
      status: "Enterprise gateway",
    });
    assert.deepEqual(accountInfoToStatus({ apiProvider: "gateway", organization: "Acme" }), {
      label: "Acme",
      status: "Enterprise gateway",
    });
  });

  it("describes API key / auth token logins by source", () => {
    assert.deepEqual(
      accountInfoToStatus({ apiProvider: "firstParty", apiKeySource: "apiKeyHelper" }),
      { status: "API key (apiKeyHelper)" },
    );
    assert.deepEqual(accountInfoToStatus({ tokenSource: "ANTHROPIC_AUTH_TOKEN" }), {
      status: "Auth token (ANTHROPIC_AUTH_TOKEN)",
    });
    assert.deepEqual(accountInfoToStatus({ apiProvider: "bedrock" }), {
      status: "Amazon Bedrock",
    });
  });

  it('ignores the CLI\'s literal "none" sources and a logged-out CLI', () => {
    assert.equal(
      accountInfoToStatus({ apiProvider: "firstParty", tokenSource: "none", apiKeySource: "none" }),
      undefined,
    );
    assert.equal(accountInfoToStatus({ apiProvider: "firstParty" }), undefined);
    assert.equal(accountInfoToStatus({}), undefined);
    assert.equal(accountInfoToStatus(undefined), undefined);
  });
});
