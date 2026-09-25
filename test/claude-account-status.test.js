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
      }),
      { plan: "max", email: "me@example.com", label: "Acme" },
    );
  });

  it("treats an enterprise gateway login as signed in", () => {
    assert.deepEqual(accountInfoToStatus({ apiProvider: "gateway" }), {
      label: "Enterprise gateway",
    });
  });

  it("treats an API key / helper login as signed in", () => {
    assert.deepEqual(
      accountInfoToStatus({ apiProvider: "firstParty", apiKeySource: "apiKeyHelper" }),
      { label: "API key (apiKeyHelper)" },
    );
  });

  it("labels third-party backends by name and keeps the org when known", () => {
    assert.deepEqual(accountInfoToStatus({ apiProvider: "bedrock" }), { label: "Amazon Bedrock" });
    assert.deepEqual(accountInfoToStatus({ apiProvider: "vertex", organization: "Acme" }), {
      label: "Acme",
    });
  });

  it("falls back to the token source when nothing else is reported", () => {
    assert.deepEqual(accountInfoToStatus({ tokenSource: "claude.ai" }), {
      label: "Signed in via claude.ai",
    });
  });

  it("reports nothing for a logged-out CLI", () => {
    assert.equal(accountInfoToStatus({ apiProvider: "firstParty" }), undefined);
    assert.equal(accountInfoToStatus({}), undefined);
    assert.equal(accountInfoToStatus(undefined), undefined);
  });
});
