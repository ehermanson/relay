import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { beforeEach, describe, expect, it } from "vitest";
import {
  claimOutbox,
  deleteOutbox,
  discardOutbox,
  listOutbox,
  newOutboxId,
  releaseOutboxLease,
  replaceOutbox,
  saveLeasedOutbox,
  saveOutbox,
  type OutboxMessage,
} from "./outbox-store";

beforeEach(async () => {
  for (const row of await listOutbox()) await deleteOutbox(row.id);
});

describe("durable outbox", () => {
  it("retains attachment bytes and message text until acknowledged", async () => {
    const id = newOutboxId();
    const message: OutboxMessage = {
      id,
      instanceId: "chat-1",
      owner: "user-1",
      text: "Review this image",
      attachments: [
        {
          name: "image.png",
          type: "image/png",
          kind: "image",
          blob: new NodeBlob(["image bytes"], { type: "image/png" }) as Blob,
        },
      ],
      createdAt: Date.now(),
      status: "queued",
    };
    await saveOutbox(message);
    const saved = (await listOutbox())[0]!;
    expect(saved.text).toBe("Review this image");
    expect(saved.attachments[0]?.name).toBe("image.png");
    expect(await saved.attachments[0]!.blob.text()).toBe("image bytes");
    await deleteOutbox(id);
    expect(await listOutbox()).toEqual([]);
  });

  it("claims once across tabs and atomically changes ID for an explicit retry", async () => {
    const id = newOutboxId();
    await saveOutbox({
      id,
      instanceId: "chat-1",
      owner: "user-1",
      text: "hello",
      attachments: [],
      createdAt: 1,
      status: "uncertain",
    });
    expect(await claimOutbox(id, "tab-a")).toMatchObject({ leaseOwner: "tab-a" });
    expect(await claimOutbox(id, "tab-b")).toBeNull();
    await releaseOutboxLease(id, "tab-a");
    expect(await claimOutbox(id, "tab-b")).toMatchObject({ leaseOwner: "tab-b" });
    const newId = newOutboxId();
    await replaceOutbox(id, {
      id: newId,
      instanceId: "chat-1",
      owner: "user-2",
      text: "hello",
      attachments: [],
      createdAt: 1,
      status: "queued",
    });
    expect((await listOutbox()).map((row) => row.id)).toEqual([newId]);
  });

  it("refuses to discard an in-flight send and never resurrects a discarded row", async () => {
    const id = newOutboxId();
    const message: OutboxMessage = {
      id,
      instanceId: "chat-1",
      owner: "user-1",
      text: "hello",
      attachments: [],
      createdAt: 1,
      status: "queued",
    };
    await saveOutbox(message);
    const claimed = (await claimOutbox(id, "tab-a"))!;
    expect(await discardOutbox(id)).toBe(false);
    expect(await saveLeasedOutbox({ ...claimed, status: "sending" }, "tab-a")).toBe(true);
    expect((await listOutbox())[0]).toMatchObject({ status: "sending", leaseOwner: "tab-a" });

    // Lease expired (e.g. frozen tab): discard wins and a late drain write is dropped.
    await saveOutbox({ ...claimed, leaseUntil: Date.now() - 1 });
    expect(await discardOutbox(id)).toBe(true);
    expect(await saveLeasedOutbox({ ...claimed, status: "queued" }, "tab-a")).toBe(false);
    expect(await listOutbox()).toEqual([]);
  });
});
