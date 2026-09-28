import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { asIdentityScope, base64Url, base64UrlDecode, type HistoryRecord, type PairingEnvelope } from "@gryt/crypto";

import type { MlsOwnDeviceAdd } from "../mls/interfaces.ts";
import { createApproverPairing, type ApproverPairing } from "./approver.ts";
import { archiveByDay } from "./historySnapshot.ts";
import type { HistoryArchive, HistoryProgress } from "./interfaces.ts";
import { createNewDevicePairing, type NewDevicePairing } from "./newDevice.ts";
import { FakeClock, FakeKeycloak, FakeRelay } from "./relay.fake.ts";
import { createPairingRelay } from "./relayClient.ts";

const HOST = "chat.example";
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

const record = (scope: string, conversationId: string, i: number, sentAt: number): HistoryRecord => ({
  scope,
  conversationId,
  messageId: `${conversationId}-${String(i).padStart(5, "0")}`,
  sentAt,
  message: { senderId: i % 2 ? "me" : "them", text: `message ${i} in ${conversationId}` },
});

/** 5,000 messages in three conversations on two servers, over about 600 days. */
function bigArchive(): HistoryRecord[] {
  const out: HistoryRecord[] = [];
  const convs = [["srv:a", "dm-1"], ["srv:a", "dm-2"], ["srv:b", "dm-3"]] as const;
  for (let i = 0; i < 5000; i++) {
    const [scope, conv] = convs[i % 3];
    out.push(record(scope, conv, i, NOW - Math.floor((i * 600 * DAY) / 5000) - (i % 7) * 60_000));
  }
  return out;
}

class FakeArchive implements HistoryArchive {
  pages = 0;
  records: HistoryRecord[];
  constructor(records: HistoryRecord[]) {
    this.records = records;
  }
  async conversations() {
    const seen = new Map<string, { scope: string; conversationId: string; count: number }>();
    for (const r of this.records) {
      const k = `${r.scope}\n${r.conversationId}`;
      const c = seen.get(k) ?? { scope: r.scope, conversationId: r.conversationId, count: 0 };
      c.count++;
      seen.set(k, c);
    }
    return [...seen.values()];
  }
  async page(scope: string, conversationId: string, { before, limit }: { before?: { sentAt: number; messageId: string }; limit: number }) {
    this.pages++;
    const older = (r: HistoryRecord) =>
      !before || r.sentAt < before.sentAt || (r.sentAt === before.sentAt && r.messageId < before.messageId);
    return this.records
      .filter((r) => r.scope === scope && r.conversationId === conversationId && older(r))
      .sort((a, b) => b.sentAt - a.sentAt || (a.messageId < b.messageId ? 1 : -1))
      .slice(0, limit)
      .reverse();
  }
}

const key = (r: HistoryRecord) => `${r.scope}/${r.conversationId}/${r.messageId}`;

interface Mls {
  snap: number;
  add: { seq: number; epoch: number };
  /** Runs inside addOwnDevice, before the add is reported. */
  duringAdd?: () => void;
}

function setup(records: HistoryRecord[], mls: Mls = { snap: 0, add: { seq: 1, epoch: 1 } }, withSink = true) {
  const clock = new FakeClock();
  const relay = new FakeRelay(clock);
  const keycloak = new FakeKeycloak();
  const archive = new FakeArchive(records);
  const sink: HistoryRecord[] = [];
  const puts: HistoryRecord[][] = [];

  const newDevice = () =>
    createNewDevicePairing({
      relay: createPairingRelay(relay.origin, relay.fetch),
      device: { name: "MacBook Air", app: "Gryt desktop", platform: "macOS" },
      storage: { commit: async () => undefined },
      oidc: keycloak.oidc,
      clock,
      history: withSink ? { put: async (batch) => void (sink.push(...batch), puts.push(batch)) } : undefined,
    });
  const approver = () =>
    createApproverPairing({
      relay: createPairingRelay(relay.origin, relay.fetch),
      relayOrigin: relay.origin,
      fetch: keycloak.fetch,
      clock,
      history: archive,
      lateWindowMs: 5000,
      devices: () => ({
        groupPositions: async () => [{ conversationId: "dm-1", groupId: "ab", seq: mls.snap, epoch: 2 }],
        addOwnDevice: async () => {
          mls.duringAdd?.();
          const result: MlsOwnDeviceAdd = { conversationId: "dm-1", groupId: "ab", outcome: "added", add: mls.add };
          return [result];
        },
      }),
    });

  async function until(done: () => boolean, maxSeconds = 600) {
    for (let s = 0; ; s++) {
      for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
      if (done()) return;
      if (s >= maxSeconds) assert.fail("never got there");
      clock.advance(1000);
    }
  }

  const envelope: PairingEnvelope = {
    seed: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
    keys: [],
    servers: [{ host: HOST, name: "Example", scope: asIdentityScope("srv:a") }],
    pins: {},
    from: "Sivert's iPhone",
  };

  /** Pairs as a guest up to N's "ready"; returns both sides. */
  async function pair(beforeApprove?: (a: ApproverPairing) => void) {
    const n = newDevice();
    const a = approver();
    n.start();
    await until(() => n.state.phase === "showing");
    a.claim({ qr: (n.state as { qr: string }).qr });
    await until(() => a.state.phase === "confirming");
    a.approve(envelope);
    beforeApprove?.(a);
    await until(() => n.state.phase === "joining");
    await n.ready([{ host: HOST, deviceId: "dev-n" }]);
    return { n, a };
  }

  return { clock, relay, archive, sink, puts, pair, until };
}

const phase = (p: NewDevicePairing | ApproverPairing) => p.state.phase;
const progressOf = (p: NewDevicePairing | ApproverPairing): HistoryProgress => p.history!;

describe("archiveByDay", () => {
  it("walks every conversation newest day first, one UTC day per batch", async () => {
    const records = bigArchive();
    const days: HistoryRecord[][] = [];
    for await (const day of archiveByDay(new FakeArchive(records), 50)) days.push(day);
    assert.equal(days.flat().length, records.length);
    const dayOf = (r: HistoryRecord) => Math.floor(r.sentAt / DAY);
    for (const d of days) assert.equal(new Set(d.map(dayOf)).size, 1);
    const order = days.map((d) => dayOf(d[0]));
    assert.deepEqual(order, [...order].sort((x, y) => y - x));
    assert.equal(new Set(order).size, order.length);
  });
});

describe("history transfer", () => {
  it("moves 5,000 messages in three conversations, newest first", async () => {
    const records = bigArchive();
    const env = setup(records);
    const { n, a } = await env.pair();
    await env.until(() => phase(a) === "done" && phase(n) === "done");

    assert.equal(env.sink.length, records.length);
    assert.deepEqual(new Set(env.sink.map(key)), new Set(records.map(key)));
    assert.deepEqual(env.sink.find((r) => r.messageId === "dm-2-04000"), records[4000]);

    // Each batch N stores is no newer than the one before it.
    const newest = env.puts.map((b) => Math.max(...b.map((r) => r.sentAt)));
    assert.deepEqual(newest, [...newest].sort((x, y) => y - x));
    assert.equal(newest[0], NOW);

    for (const p of [progressOf(a), progressOf(n)]) {
      assert.equal(p.messages, 5000);
      assert.equal(p.total, 5000);
      assert.equal(p.complete, true);
      assert.equal(p.chunks, p.listed);
    }
    assert.ok(progressOf(n).listed > 400, "some chunks came after the envelope");
    assert.equal(progressOf(n).missing, 0);
    assert.equal(env.relay.sessions.size, 0, "N closed the session");
  });

  it("refuses a chunk the relay changed and keeps the rest", async () => {
    const records = bigArchive();
    const env = setup(records);
    let changed = 0;
    env.relay.serveChunk = (slot, body) => {
      if (slot !== 3) return body;
      changed++;
      const bytes = base64UrlDecode(body);
      bytes[bytes.length - 1] ^= 1;
      return base64Url(bytes);
    };
    const { n, a } = await env.pair();
    await env.until(() => phase(a) === "done" && phase(n) === "done");
    assert.equal(changed, 1);
    const p = progressOf(n);
    assert.equal(p.refused, 1);
    assert.equal(p.complete, true);
    assert.ok(env.sink.length < records.length && env.sink.length > records.length - 1000);
    assert.equal(new Set(env.sink.map(key)).size, env.sink.length);
  });

  it("reports a chunk the relay lost", async () => {
    const records = bigArchive();
    const env = setup(records);
    env.relay.serveChunk = (slot, body) => (slot === 5 ? null : body);
    const { n, a } = await env.pair();
    await env.until(() => phase(a) === "done" && phase(n) === "done");
    const p = progressOf(n);
    assert.equal(p.missing, 1);
    assert.equal(p.refused, 0);
    assert.equal(p.complete, true);
    assert.equal(p.chunks, p.listed - 1);
  });

  it("sends the tail with no gaps and no repeats while messages keep landing", async () => {
    const t = (seq: number) => NOW + seq * 1000;
    const dm = (seq: number) => record("srv:a", "dm-1", seq, t(seq));
    // Up to the snapshot at seq 100, A has every message archived.
    const records = Array.from({ length: 100 }, (_, i) => dm(i + 1));
    const mls: Mls = { snap: 100, add: { seq: 103, epoch: 3 } };
    const env = setup(records, mls);
    const live = new Set<string>();

    let a!: ApproverPairing;
    // A archives and notes each message as its driver hands it over.
    const arrive = (seq: number, epoch: number) => {
      env.archive.records.push(dm(seq));
      a.noteMessage({ host: HOST, conversationId: "dm-1", seq, epoch, record: dm(seq) });
    };
    // 101 lands just after Approve: in the archive before the snapshot reads it, and in the tail too.
    mls.duringAdd = () => arrive(102, 2);
    const paired = await env.pair((approver) => ((a = approver), arrive(101, 2)));
    const { n } = paired;

    await env.until(() => phase(a) === "sending");
    // After the add at 103: 104 was sent in the old epoch, so only A can read it. 105 N reads itself.
    arrive(104, 2);
    arrive(105, 3);
    live.add(key(dm(105)));
    await env.until(() => phase(a) === "done" && phase(n) === "done");

    const got = env.sink.map(key);
    assert.equal(new Set(got).size, got.length, "no message stored twice");
    for (const seq of [101, 102, 104]) assert.ok(got.includes(key(dm(seq))), `tail has ${seq}`);
    assert.ok(!got.includes(key(dm(105))), "N got 105 live, not from the tail");
    const all = new Set([...got, ...live]);
    for (const seq of [...Array(102).keys()].map((i) => i + 1).concat(104, 105)) {
      assert.ok(all.has(key(dm(seq))), `nothing missing at ${seq}`);
    }
    assert.equal(progressOf(n).complete, true);
  });

  it("finishes on A's last message when N has nowhere to put history", async () => {
    const env = setup(bigArchive(), undefined, false);
    const { n, a } = await env.pair();
    await env.until(() => phase(a) === "done" && phase(n) === "done");
    assert.equal(n.history, null);
    assert.equal(env.relay.chunkGets, 0);
    assert.equal(env.relay.sessions.size, 0);
  });

  it("stops both sides when N cancels partway", async () => {
    const env = setup(bigArchive());
    const { n, a } = await env.pair();
    await env.until(() => (progressOf(n)?.chunks ?? 0) > 0);
    await n.cancel();
    assert.deepEqual(n.state, { phase: "ended", reason: "cancelled" });
    await env.until(() => phase(a) === "ended");
    assert.deepEqual(a.state, { phase: "ended", reason: "cancelled_by_other" });
    assert.equal(progressOf(n).complete, false);
  });
});
