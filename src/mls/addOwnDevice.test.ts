import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  asIdentityScope,
  createMlsDevice,
  derivePersonKeyPair,
  pinPeerKey,
  pinPersonKey,
  type PeerPin,
  type VerifiedDmKeyBinding,
  type VerifiedPersonKeyBinding,
} from "@gryt/crypto";

import { FakeDeliveryService, MemoryMlsStore } from "./deliveryService.fake.ts";
import { createMlsDmDriver, MlsDriverError } from "./dmDriver.ts";
import type { MlsDecryptedMessage, MlsOwnDeviceAdd, MlsTransport } from "./interfaces.ts";
import { mlsPinsFromPeerPins } from "./pins.ts";

const SCOPE = asIdentityScope("srv:pairing-test");
const seedOf = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * n + n) % 251);
const SEEDS: Record<string, Uint8Array> = { kari: seedOf(3), ola: seedOf(5), mallory: seedOf(7), per: seedOf(11) };
const text = (s: string) => new TextEncoder().encode(s);
const read = (m: MlsDecryptedMessage) => new TextDecoder().decode(m.plaintext);

/* Holds the first call to one transport method until `release`, and says when it got there. */
function gate(transport: MlsTransport, method: "commit" | "send") {
  let reached!: () => void;
  let release!: () => void;
  const atGate = new Promise<void>((r) => (reached = r));
  const open = new Promise<void>((r) => (release = r));
  let first = true;
  const inner = transport[method].bind(transport) as (req: unknown) => Promise<unknown>;
  (transport as unknown as Record<string, (req: unknown) => Promise<unknown>>)[method] = async (req) => {
    if (first) {
      first = false;
      reached();
      await open;
    }
    return inner(req);
  };
  return { atGate, release };
}

function device(fake: FakeDeliveryService, who: string, name: string, seed = SEEDS[who]) {
  let pinned: Record<string, PeerPin> = {};
  const pinStore = { read: () => structuredClone(pinned), write: (p: Record<string, PeerPin>) => void (pinned = structuredClone(p)) };
  for (const other of Object.keys(SEEDS).filter((p) => p !== who)) {
    pinPeerKey(pinStore, SCOPE, other, { dmPublicKey: new Uint8Array(32), identityThumbprint: `id-${other}` } as VerifiedDmKeyBinding);
    const personPublicKey = derivePersonKeyPair(SEEDS[other], SCOPE).publicKey;
    pinPersonKey(pinStore, SCOPE, other, { personPublicKey, identityThumbprint: `id-${other}`, scope: SCOPE, signedAt: 0 } as VerifiedPersonKeyBinding);
  }
  const store = new MemoryMlsStore();
  const messages: MlsDecryptedMessage[] = [];
  const undecryptable: { conversationId: string; seq: number; reason: string }[] = [];
  const { transport, socket } = fake.connect(who);
  const driver = createMlsDmDriver({
    transport,
    store,
    scope: SCOPE,
    serverUserId: who,
    capability: { version: 1, ciphersuites: [1], retentionDays: 30 },
    pins: mlsPinsFromPeerPins({
      store: pinStore,
      scope: SCOPE,
      serverUserId: who,
      ownPersonKey: derivePersonKeyPair(seed, SCOPE).publicKey,
      membersOf: (conversationId) => fake.conversations.get(conversationId) ?? [],
      seen: new Set<string>(),
    }),
    events: {
      onMessage: (m) => void messages.push(m),
      onUndecryptable: (i) => void undecryptable.push(i),
    },
    newDevice: () => createMlsDevice({ seed, scope: SCOPE, deviceName: name }),
  });
  socket.driver = driver;
  const id = () => store.device!.deviceId;
  return { driver, store, messages, undecryptable, transport, socket, id, texts: () => messages.map(read) };
}

/* Kari's laptop in a DM with Ola, one message each way. `publishDesk` starts her new desktop. */
async function pairingSetup() {
  const fake = new FakeDeliveryService(SCOPE);
  const dm = fake.dm("kari", "ola");
  const laptop = device(fake, "kari", "laptop");
  const ola = device(fake, "ola", "phone");
  await laptop.driver.start();
  await ola.driver.start();
  await laptop.driver.send(dm, "ola", text("hei"));
  await fake.settle();
  await ola.driver.send(dm, "kari", text("hei selv"));
  await fake.settle();
  const desk = device(fake, "kari", "desk");
  const publishDesk = async () => {
    await desk.driver.start();
    await fake.settle();
  };
  return { fake, dm, laptop, ola, desk, publishDesk };
}

const addFor = (results: MlsOwnDeviceAdd[], conversationId: string) => results.find((r) => r.conversationId === conversationId)!;

describe("adding your own new device (pairing)", () => {
  it("adds the new device to all three DMs, with progress for each", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const laptop = device(fake, "kari", "laptop");
    const peers = ["ola", "mallory", "per"].map((who) => ({ who, dm: fake.dm("kari", who), d: device(fake, who, "phone") }));
    await laptop.driver.start();
    for (const p of peers) await p.d.driver.start();
    for (const p of peers) await laptop.driver.send(p.dm, p.who, text(`hei ${p.who}`));
    await fake.settle();
    const desk = device(fake, "kari", "desk");
    await desk.driver.start();
    await fake.settle();
    const commitsBefore = fake.stats.commits;

    const progress: [number, number][] = [];
    const order = [peers[2].dm, peers[0].dm];
    const results = await laptop.driver.addOwnDevice(desk.id(), { order, onProgress: (p) => void progress.push([p.done, p.total]) });
    await fake.settle();

    assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
    assert.deepEqual(results.map((r) => r.conversationId), [peers[2].dm, peers[0].dm, peers[1].dm], "the order asked for, then the rest");
    assert.ok(results.every((r) => r.outcome === "added" && r.add !== null));
    assert.equal(fake.stats.commits - commitsBefore, 3, "one commit per group, with nothing waiting for a send");
    assert.equal(desk.store.groups.size, 3);

    for (const p of peers) await p.d.driver.send(p.dm, "kari", text(`from ${p.who}`));
    await fake.settle();
    assert.deepEqual(desk.texts().sort(), ["from mallory", "from ola", "from per"]);
    assert.deepEqual(desk.undecryptable, []);

    const again = await laptop.driver.addOwnDevice(desk.id(), { order: results.map((r) => r.conversationId) });
    assert.deepEqual(again, results, "a second call adds nothing and reports the same places");
    assert.equal(fake.stats.commits - commitsBefore, 3);
  });

  it("records exactly where the device went in, for the snapshot, the tail and the late ones", async () => {
    const { fake, dm, laptop, ola, desk, publishDesk } = await pairingSetup();
    const [snap] = await laptop.driver.groupPositions();
    assert.deepEqual(snap, { conversationId: dm, groupId: fake.groups.get(dm)!.groupId, seq: fake.groups.get(dm)!.headSeq, epoch: 1 });

    // Two messages between the snapshot and the add: the tail.
    await ola.driver.send(dm, "kari", text("tail 1"));
    await ola.driver.send(dm, "kari", text("tail 2"));
    await fake.settle();
    // Ola misses the desk's arrival, so her next send won't add it herself.
    ola.socket.online = false;
    await publishDesk();

    // Ola encrypts one more in the old epoch; it reaches the server only after the add.
    const late = gate(ola.transport, "send");
    const lateSend = ola.driver.send(dm, "kari", text("late"));
    await late.atGate;
    const [result] = await laptop.driver.addOwnDevice(desk.id());
    late.release();
    await lateSend;
    await fake.settle();

    const log = fake.groups.get(dm)!.log;
    const addEntry = log.find((e) => e.seq === result.add!.seq)!;
    assert.equal(result.outcome, "added");
    assert.equal(addEntry.kind, "commit");
    assert.equal(addEntry.senderDeviceId, laptop.id());
    assert.equal(result.add!.epoch, addEntry.epoch + 1);
    assert.equal(desk.store.groups.get(dm)!.joinedEpoch, result.add!.epoch, "the epoch the new device starts in");

    const tail = laptop.messages.filter((m) => m.seq > snap.seq && m.seq < result.add!.seq).map(read);
    assert.deepEqual(tail, ["tail 1", "tail 2"]);
    const lateOnes = laptop.messages.filter((m) => m.seq > result.add!.seq && m.epoch < result.add!.epoch);
    assert.deepEqual(lateOnes.map(read), ["late"]);
    assert.equal(lateOnes[0].seq, result.add!.seq + 1);
    assert.deepEqual(desk.texts(), [], "none of it is readable on the new device");
  });

  it("catches up and adds again after a stale_epoch race", async () => {
    const { fake, dm, laptop, ola, desk, publishDesk } = await pairingSetup();
    const tablet = device(fake, "ola", "tablet");
    await tablet.driver.start();
    await fake.settle();
    await ola.driver.send(dm, "kari", text("tablet in"));
    await fake.settle();
    await publishDesk();

    // Ola takes her tablet out while Kari's add is on its way.
    const held = gate(laptop.transport, "commit");
    const adding = laptop.driver.addOwnDevice(desk.id());
    await held.atGate;
    await ola.driver.removeOwnDevice(tablet.id());
    const removal = fake.groups.get(dm)!.log.at(-1)!;
    held.release();
    const [result] = await adding;
    await fake.settle();

    assert.equal(removal.kind, "commit");
    assert.equal(fake.stats.staleEpoch, 1);
    assert.equal(result.outcome, "added");
    assert.deepEqual(result.add, { seq: removal.seq + 1, epoch: removal.epoch + 2 });
    await ola.driver.send(dm, "kari", text("after"));
    await fake.settle();
    assert.deepEqual(desk.texts(), ["after"]);
  });

  it("takes a peer's commit as the add when it lands at the same moment", async () => {
    const { fake, dm, laptop, ola, desk, publishDesk } = await pairingSetup();
    await publishDesk();
    const commitsBefore = fake.stats.commits;

    const held = gate(laptop.transport, "commit");
    const adding = laptop.driver.addOwnDevice(desk.id());
    await held.atGate;
    // Ola's next send adds every device it finds, the desk included.
    await ola.driver.send(dm, "kari", text("hei desk"));
    const olaCommit = fake.groups.get(dm)!.log.findLast((e) => e.kind === "commit")!;
    held.release();
    const [result] = await adding;
    await fake.settle();

    assert.equal(olaCommit.senderServerUserId, "ola");
    assert.equal(fake.stats.staleEpoch, 1);
    assert.equal(fake.stats.commits - commitsBefore, 1, "the desk went in once");
    assert.deepEqual(result, {
      conversationId: dm,
      groupId: fake.groups.get(dm)!.groupId,
      outcome: "added_by_other",
      add: { seq: olaCommit.seq, epoch: olaCommit.epoch + 1 },
    });
    assert.deepEqual(desk.texts(), ["hei desk"]);
  });

  it("refuses a device under somebody else's person key, and one the server doesn't list", async () => {
    const { fake, dm, laptop } = await pairingSetup();
    // The server slips in a device under Kari's name, certified by Mallory's person key.
    const planted = device(fake, "kari", "desk", SEEDS.mallory);
    await planted.driver.start();
    await fake.settle();
    const epoch = fake.groups.get(dm)!.epoch;
    const progress: unknown[] = [];

    const notOwn = (e: unknown) => e instanceof MlsDriverError && e.code === "not_own_device";
    await assert.rejects(laptop.driver.addOwnDevice(planted.id(), { onProgress: (p) => void progress.push(p) }), notOwn);
    await assert.rejects(laptop.driver.addOwnDevice("no-such-device"), notOwn);
    await assert.rejects(laptop.driver.addOwnDevice(laptop.id()), notOwn);

    assert.equal(fake.groups.get(dm)!.epoch, epoch, "no commit");
    assert.deepEqual(progress, []);
    assert.equal(planted.store.groups.size, 0);
    assert.deepEqual(fake.welcomes.filter((w) => w.deviceId === planted.id()), []);
  });
});
