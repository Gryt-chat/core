import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MlsDmContent, MlsHistoryEntry } from "./content.ts";
import { reencryptedId, reencryptMine, type ReencryptCandidate, type ReencryptDeps } from "./reencrypt.ts";

const AT = "2024-03-12T10:00:00.000Z";
const row = (id: string, extra: Partial<ReencryptCandidate> = {}): ReencryptCandidate => ({
  message_id: id, sender_server_id: "kari", text: id, created_at: AT, ...extra,
});
const items = [
  row("a"),
  row("b", { reply_to_message_id: "a" }),
  row("c", { reply_to_message_id: "gone" }),
  row("file", { attachments: ["f"] }),
  row("liked", { reactions: [{}] }),
  row("pinned", { pinned_at: AT }),
  row("theirs", { sender_server_id: "sable" }),
  row("sealed", { sealed: "x", text: null }),
];

function harness(send: () => Promise<void> = async () => {}) {
  const sent: MlsDmContent[] = [];
  const removed: string[] = [];
  const kept: MlsHistoryEntry[] = [];
  const order: string[] = [];
  const deps: ReencryptDeps = {
    fetchOlder: async () => ({ items, hasMore: false }),
    send: async (c) => { await send(); sent.push(c); order.push("send"); },
    keep: async (e) => { kept.push(...e); order.push("keep"); },
    remove: (id) => { removed.push(id); order.push("remove"); },
    sleep: async () => {},
    now: () => 5000,
    newId: () => "batch",
    stopped: () => false,
    report: () => {},
  };
  return { deps, sent, removed, kept, order };
}

describe("reencryptMine (GRYT-1969)", () => {
  it("removes nothing when the send fails", async () => {
    const h = harness(async () => { throw new Error("offline"); });
    await assert.rejects(reencryptMine(h.deps, "kari"));
    assert.deepEqual(h.removed, []);
    assert.deepEqual(h.kept, []);
  });

  it("moves only your plain text, sends and keeps it before removing, and keeps its date", async () => {
    const h = harness();
    assert.equal(await reencryptMine(h.deps, "kari"), 3);
    assert.deepEqual([...h.removed].sort(), ["a", "b", "c"]);
    assert.deepEqual(h.order.slice(0, 3), ["send", "keep", "remove"]);
    assert.equal(h.kept[0].sentAt, Date.parse(AT));
    assert.equal(h.kept.find((e) => e.id === reencryptedId("b"))?.replyTo, reencryptedId("a"));
    assert.equal(h.kept.find((e) => e.id === reencryptedId("c"))?.replyTo, "gone");
  });

  it("pages back through everything older", async () => {
    const h = harness();
    const asked: (string | undefined)[] = [];
    h.deps.fetchOlder = async (before) => {
      asked.push(before);
      return before ? { items: [row("old", { created_at: "2020-01-01T00:00:00.000Z" })], hasMore: false } : { items: [row("new")], hasMore: true };
    };
    assert.equal(await reencryptMine(h.deps, "kari"), 2);
    assert.deepEqual(asked, [undefined, AT]);
  });

  it("stops between batches, and a stopped run removes nothing further", async () => {
    const h = harness();
    h.deps.stopped = () => true;
    assert.equal(await reencryptMine(h.deps, "kari"), 0);
    assert.deepEqual(h.removed, []);
  });
});
