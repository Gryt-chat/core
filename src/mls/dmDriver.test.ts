import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  asIdentityScope,
  createMlsDevice,
  decodeMlsGroupState,
  derivePersonKeyPair,
  generateMlsKeyPackage,
  mlsGroupMembers,
  openAttachment,
  sealAttachment,
  pinPeerKey,
  pinPersonKey,
  readMlsKeyPackage,
  type PeerPin,
  type VerifiedDmKeyBinding,
  type VerifiedPersonKeyBinding,
} from "@gryt/crypto";

import { FakeDeliveryService, MemoryMlsStore } from "./deliveryService.fake.ts";
import { decodeMlsDmContent, encodeMlsDmContent } from "./content.ts";
import { createMlsDmDriver, MlsDriverError } from "./dmDriver.ts";
import type { MlsDecryptedMessage, MlsServerCapability } from "./interfaces.ts";
import { mlsPinsFromPeerPins } from "./pins.ts";

const SCOPE = asIdentityScope("srv:driver-test");
const CAPABILITY: MlsServerCapability = { version: 1, ciphersuites: [1], retentionDays: 30 };
const DAY = 86_400;
const seedOf = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * n + n) % 251);
const SEEDS: Record<string, Uint8Array> = { kari: seedOf(3), ola: seedOf(5), mallory: seedOf(7) };
const text = (s: string) => new TextEncoder().encode(s);
const personKeyOf = (who: string) => derivePersonKeyPair(SEEDS[who], SCOPE).publicKey;

/* The pins evaluateMemberKeys would have written from the member list; bindings stand in as checked. */
function pinStore(people: string[], withPersonKey: string[]) {
  let pins: Record<string, PeerPin> = {};
  const store = { read: () => structuredClone(pins), write: (p: Record<string, PeerPin>) => void (pins = structuredClone(p)) };
  const pinPerson = (who: string) =>
    pinPersonKey(store, SCOPE, who, { personPublicKey: personKeyOf(who), identityThumbprint: `id-${who}`, scope: SCOPE, signedAt: 0 } as VerifiedPersonKeyBinding);
  for (const who of people) {
    pinPeerKey(store, SCOPE, who, { dmPublicKey: new Uint8Array(32), identityThumbprint: `id-${who}` } as VerifiedDmKeyBinding);
    if (withPersonKey.includes(who)) pinPerson(who);
  }
  return { store, pinPerson };
}

type DeviceOptions = {
  seed?: Uint8Array;
  capability?: MlsServerCapability | null;
  unpinned?: string[];
  store?: MemoryMlsStore;
  sendGiveUpMs?: number;
};

function device(fake: FakeDeliveryService, who: string, name: string, opts: DeviceOptions = {}) {
  const store = opts.store ?? new MemoryMlsStore();
  const removed: number[] = [];
  const waiting: boolean[] = [];
  const messages: MlsDecryptedMessage[] = [];
  const lost: { conversationId: string; reason: string }[] = [];
  const undecryptable: { conversationId: string; seq: number; reason: string }[] = [];
  const seen = new Set<string>();
  const others = Object.keys(SEEDS).filter((p) => p !== who);
  const pins = pinStore(others, others.filter((p) => !opts.unpinned?.includes(p)));
  const seed = opts.seed ?? SEEDS[who];
  const { transport, socket } = fake.connect(who);
  const driver = createMlsDmDriver({
    transport,
    store,
    scope: SCOPE,
    serverUserId: who,
    capability: opts.capability === undefined ? CAPABILITY : opts.capability,
    pins: mlsPinsFromPeerPins({
      store: pins.store,
      scope: SCOPE,
      serverUserId: who,
      ownPersonKey: derivePersonKeyPair(seed, SCOPE).publicKey,
      membersOf: (conversationId) => fake.conversations.get(conversationId) ?? [],
      seen,
    }),
    events: {
      onMessage: (m) => void messages.push(m),
      onGroupLost: (i) => void lost.push(i),
      onUndecryptable: (i) => void undecryptable.push(i),
      onDeviceRemoved: () => void removed.push(Date.now()),
      onWaiting: (w) => void waiting.push(w),
    },
    newDevice: () => createMlsDevice({ seed, scope: SCOPE, deviceName: name }),
    sendGiveUpMs: opts.sendGiveUpMs,
  });
  socket.driver = driver;
  const texts = () => messages.map((m) => `${m.senderServerUserId}: ${new TextDecoder().decode(m.plaintext)}`);
  return { driver, store, messages, lost, undecryptable, removed, waiting, seen, socket, texts, pinPerson: pins.pinPerson };
}

/* A package for `d` made as if the clock said `at`, put first in line for its device. */
async function stalePackage(fake: FakeDeliveryService, d: ReturnType<typeof device>, who: string, at: number) {
  const kp = await generateMlsKeyPackage(d.store.device!, at);
  const { ref } = await readMlsKeyPackage(kp.keyPackage, SCOPE, at);
  fake.keyPackages.unshift({ ref, serverUserId: who, deviceId: d.store.device!.deviceId, data: kp.keyPackage, lastResort: false, claimed: false });
}

describe("MLS DM driver", () => {
  it("opens a DM between two devices and carries messages both ways", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const kari = device(fake, "kari", "laptop");
    const ola = device(fake, "ola", "phone");

    await kari.driver.start();
    assert.deepEqual(await kari.driver.modeFor(dm, "ola"), { kind: "sealed-v1", reason: "peer_without_mls" });
    assert.equal(fake.keyPackages.filter((k) => !k.lastResort).length, 20);
    assert.equal(fake.keyPackages.filter((k) => k.lastResort).length, 1);

    await ola.driver.start();
    assert.deepEqual(await kari.driver.modeFor(dm, "ola"), { kind: "mls" });
    assert.ok(kari.seen.has("ola"), "seeing Ola's device is recorded through the pin hook");

    await kari.driver.send(dm, "ola", text("hei ola"));
    await fake.settle();
    await ola.driver.send(dm, "kari", text("hei kari"));
    await fake.settle();

    assert.deepEqual(ola.texts(), ["kari: hei ola"]);
    assert.deepEqual(kari.texts(), ["ola: hei kari"]);
    assert.ok(ola.seen.has("kari"));
    assert.equal(fake.groups.get(dm)!.epoch, 1, "one commit added Ola");
    assert.equal(ola.store.keyPackages.size, 20, "the private half of the used package is gone");
  });

  it("adds every device of both people, and each one reads the others", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const laptop = device(fake, "kari", "laptop");
    const phone = device(fake, "kari", "phone");
    const ola = device(fake, "ola", "phone");
    for (const d of [laptop, phone, ola]) await d.driver.start();

    await laptop.driver.send(dm, "ola", text("one"));
    await fake.settle();
    await phone.driver.send(dm, "ola", text("two"));
    await fake.settle();
    await ola.driver.send(dm, "kari", text("three"));
    await fake.settle();

    assert.deepEqual(laptop.texts(), ["kari: two", "ola: three"]);
    assert.deepEqual(phone.texts(), ["kari: one", "ola: three"]);
    assert.deepEqual(ola.texts(), ["kari: one", "kari: two"]);
    assert.equal(fake.stats.commits, 1, "both devices went in with one commit");
  });

  it("lets both sides open the DM at once, and one group wins", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const kari = device(fake, "kari", "laptop");
    const ola = device(fake, "ola", "phone");
    await kari.driver.start();
    await ola.driver.start();

    await Promise.all([kari.driver.send(dm, "ola", text("from kari")), ola.driver.send(dm, "kari", text("from ola"))]);
    await fake.settle();

    assert.equal(fake.stats.groupExists, 1);
    assert.deepEqual(kari.texts(), ["ola: from ola"]);
    assert.deepEqual(ola.texts(), ["kari: from kari"]);
    assert.equal(kari.store.groups.get(dm)!.groupId, ola.store.groups.get(dm)!.groupId);
  });

  it("retries a commit refused with stale_epoch after catching up", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const laptop = device(fake, "kari", "laptop");
    const ola = device(fake, "ola", "phone");
    await laptop.driver.start();
    await ola.driver.start();
    await laptop.driver.send(dm, "ola", text("before"));
    await fake.settle();

    // A new device for Kari: both sides will try to add it on their next send.
    const phone = device(fake, "kari", "phone");
    await phone.driver.start();
    await fake.settle();

    fake.holdCommits(2);
    await Promise.all([laptop.driver.send(dm, "ola", text("laptop")), ola.driver.send(dm, "kari", text("ola"))]);
    await fake.settle();

    assert.equal(fake.stats.staleEpoch, 1, "exactly one of the two commits lost");
    assert.equal(fake.groups.get(dm)!.epoch, 2, "the phone went in once");
    assert.deepEqual(phone.texts().sort(), ["kari: laptop", "ola: ola"]);
    assert.ok(laptop.texts().includes("ola: ola"));
    assert.ok(ola.texts().includes("kari: laptop"));
  });

  it("joins a second device of the same person from a Welcome", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const laptop = device(fake, "kari", "laptop");
    const ola = device(fake, "ola", "phone");
    await laptop.driver.start();
    await ola.driver.start();
    await laptop.driver.send(dm, "ola", text("old news"));
    await fake.settle();

    const phone = device(fake, "kari", "phone");
    await phone.driver.start();
    await fake.settle();
    await ola.driver.send(dm, "kari", text("welcome, phone"));
    await fake.settle();
    await phone.driver.send(dm, "ola", text("from the phone"));
    await fake.settle();

    assert.deepEqual(phone.texts(), ["ola: welcome, phone"], "nothing from before it joined, and no errors for it");
    assert.deepEqual(phone.undecryptable, []);
    assert.deepEqual(laptop.texts(), ["ola: welcome, phone", "kari: from the phone"]);
    assert.deepEqual(ola.texts(), ["kari: old news", "kari: from the phone"]);
  });

  it("catches a device up in order after it was away", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const kari = device(fake, "kari", "laptop");
    const ola = device(fake, "ola", "phone");
    await kari.driver.start();
    await ola.driver.start();
    await kari.driver.send(dm, "ola", text("0"));
    await fake.settle();

    ola.socket.online = false;
    for (let i = 1; i <= 120; i++) await kari.driver.send(dm, "ola", text(String(i)));
    const phone = device(fake, "kari", "phone");
    await phone.driver.start();
    await fake.settle();
    for (let i = 121; i <= 250; i++) await kari.driver.send(dm, "ola", text(String(i)));
    await fake.settle();
    assert.equal(ola.messages.length, 1);

    ola.socket.online = true;
    await ola.driver.start();
    await fake.settle();

    assert.deepEqual(
      ola.messages.map((m) => Number(new TextDecoder().decode(m.plaintext))),
      Array.from({ length: 251 }, (_, i) => i),
    );
    assert.deepEqual(ola.lost, []);
    await ola.driver.send(dm, "kari", text("back"));
    await fake.settle();
    assert.deepEqual(phone.texts(), [...Array.from({ length: 130 }, (_, i) => `kari: ${i + 121}`), "ola: back"]);
  });

  it("removes a device its owner removed, and that device learns it is out", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const laptop = device(fake, "kari", "laptop");
    const phone = device(fake, "kari", "phone");
    const ola = device(fake, "ola", "phone");
    for (const d of [laptop, phone, ola]) await d.driver.start();
    await laptop.driver.send(dm, "ola", text("all three"));
    await fake.settle();

    await laptop.driver.removeOwnDevice(phone.store.device!.deviceId);
    await fake.settle();
    await ola.driver.send(dm, "kari", text("two left"));
    await fake.settle();

    assert.deepEqual(phone.lost, [{ conversationId: dm, reason: "removed" }]);
    assert.equal(phone.store.groups.size, 0);
    assert.deepEqual(phone.texts(), ["kari: all three"]);
    assert.deepEqual(laptop.texts(), ["ola: two left"]);
  });

  it("has your other device take a removed one out, with the peer offline", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const laptop = device(fake, "kari", "laptop");
    const phone = device(fake, "kari", "phone");
    const ola = device(fake, "ola", "phone");
    for (const d of [laptop, phone, ola]) await d.driver.start();
    await laptop.driver.send(dm, "ola", text("all three"));
    await fake.settle();

    // A new desktop holds no group, so only the laptop can commit the Remove.
    const desk = device(fake, "kari", "desk");
    await desk.driver.start();
    ola.socket.online = false;
    await desk.driver.removeOwnDevice(phone.store.device!.deviceId);
    await fake.settle();

    assert.deepEqual(phone.lost, [{ conversationId: dm, reason: "removed" }]);
    assert.equal(fake.groups.get(dm)!.log.at(-1)!.senderDeviceId, laptop.store.device!.deviceId);
  });

  it("stops a stolen phone for good once it's removed, online or on reconnect (GRYT-1555)", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const laptop = device(fake, "kari", "laptop");
    const phone = device(fake, "kari", "phone");
    const ola = device(fake, "ola", "phone");
    for (const d of [laptop, phone, ola]) await d.driver.start();
    await laptop.driver.send(dm, "ola", text("before"));
    await fake.settle();
    const phoneId = phone.store.device!.deviceId;

    // Removed while it's online: the devices push is how it finds out.
    await laptop.driver.removeOwnDevice(phoneId);
    await fake.settle();
    assert.equal(phone.removed.length, 1);
    assert.deepEqual(phone.lost, [{ conversationId: dm, reason: "removed" }]);

    // The same driver asks nothing more of the server.
    const called = fake.callsBy.get(phoneId)!.length;
    await assert.rejects(phone.driver.start(), { code: "device_removed" });
    assert.equal(fake.callsBy.get(phoneId)!.length, called);

    // Reconnecting with its state still there gets one refused sync, and never publishes.
    const reconnected = device(fake, "kari", "phone", { store: phone.store });
    await assert.rejects(reconnected.driver.start(), { code: "device_removed" });
    assert.equal(reconnected.removed.length, 1);
    assert.deepEqual(fake.callsBy.get(phoneId)!.slice(called), ["sync"]);

    await ola.driver.send(dm, "kari", text("after"));
    await fake.settle();
    assert.deepEqual(laptop.texts(), ["ola: after"]);
    assert.deepEqual(phone.texts(), ["kari: before"]);
    assert.deepEqual(fake.welcomes.filter((w) => w.deviceId === phoneId), [], "and nobody adds it back");
  });

  it("lists your own devices with the names their certificates carry", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const laptop = device(fake, "kari", "laptop");
    const phone = device(fake, "kari", "phone");
    const ola = device(fake, "ola", "phone");
    for (const d of [laptop, phone, ola]) await d.driver.start();
    await laptop.driver.send(dm, "ola", text("hei"));
    await fake.settle();
    const tablet = device(fake, "kari", "tablet");
    await tablet.driver.start();

    const fromLaptop = await laptop.driver.ownDevices();
    assert.deepEqual(
      fromLaptop.map((d) => [d.name, d.thisDevice]),
      [["laptop", true], ["phone", false], ["tablet", false]],
      "the tablet is in no group yet, so its name comes from the last-resort package (GRYT-1764)",
    );
    assert.ok(fromLaptop.every((d) => d.serverUserId === "kari" && typeof d.addedAt === "string"));
    assert.deepEqual(
      (await tablet.driver.ownDevices()).map((d) => [d.name, d.thisDevice]),
      [["laptop", false], ["phone", false], ["tablet", true]],
    );
  });

  it("names nothing from a package under somebody else's person key (GRYT-1764)", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const laptop = device(fake, "kari", "laptop");
    const phone = device(fake, "kari", "phone");
    const intruder = device(fake, "ola", "ola-phone");
    for (const d of [laptop, phone, intruder]) await d.driver.start();
    const phoneId = (await phone.driver.ownDevices()).find((d) => d.thisDevice)!.deviceId;
    const olas = fake.keyPackages.filter((k) => k.serverUserId === "ola" && k.lastResort).at(-1)!;
    // The server swaps in ola's package for kari's phone: the name must not show.
    for (const k of fake.keyPackages) if (k.deviceId === phoneId && k.lastResort) k.data = olas.data;
    const listed = (await laptop.driver.ownDevices()).find((d) => d.deviceId === phoneId);
    assert.equal(listed?.name, null);
  });

  it("never drops back to version 1 once the peer was seen on MLS", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const kari = device(fake, "kari", "laptop");
    const ola = device(fake, "ola", "phone");
    await kari.driver.start();
    await ola.driver.start();
    assert.deepEqual(await kari.driver.modeFor(dm, "ola"), { kind: "mls" });

    // The server hides Ola's device, then stops advertising MLS altogether.
    fake.devices.set("ola", []);
    assert.deepEqual(await kari.driver.modeFor(dm, "ola"), { kind: "refused", reason: "peer_left_mls" });
    const again = device(fake, "kari", "laptop", { capability: null });
    again.seen.add("ola");
    assert.deepEqual(await again.driver.modeFor(dm, "ola"), { kind: "refused", reason: "server_dropped_mls" });
    const fresh = device(fake, "kari", "laptop", { capability: null });
    assert.deepEqual(await fresh.driver.modeFor(dm, "ola"), { kind: "sealed-v1", reason: "server_without_mls" });
  });

  it("won't add a device whose person key isn't the one pinned for that member", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const kari = device(fake, "kari", "laptop");
    const ola = device(fake, "ola", "phone");
    await kari.driver.start();
    await ola.driver.start();
    await kari.driver.send(dm, "ola", text("first"));
    await fake.settle();

    // The server slips in a device under Ola's name, certified by Mallory's person key.
    const fakeOla = device(fake, "ola", "not ola", { seed: SEEDS.mallory });
    await fakeOla.driver.start();
    await fake.settle();
    await kari.driver.send(dm, "ola", text("second"));
    await fake.settle();

    assert.equal(fake.groups.get(dm)!.epoch, 1, "no commit added it");
    assert.deepEqual(fakeOla.texts(), []);
    assert.deepEqual(ola.texts(), ["kari: first", "kari: second"]);
  });

  it("claims again for a device whose package won't read", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const kari = device(fake, "kari", "laptop");
    const ola = device(fake, "ola", "phone");
    await kari.driver.start();
    await ola.driver.start();
    const oldest = fake.keyPackages.find((k) => k.serverUserId === "ola" && !k.lastResort)!;
    oldest.data = oldest.data.slice(0, -1);

    await kari.driver.send(dm, "ola", text("second try"));
    await fake.settle();
    assert.equal(fake.stats.claims, 2);
    assert.deepEqual(ola.texts(), ["kari: second try"]);
  });

  for (const [label, offset] of [["expired", -40 * DAY], ["not valid yet", 2 * DAY]] as const) {
    it(`claims a fresh package when the first one is ${label}`, async () => {
      const fake = new FakeDeliveryService(SCOPE);
      const dm = fake.dm("kari", "ola");
      const kari = device(fake, "kari", "laptop");
      const ola = device(fake, "ola", "phone");
      await kari.driver.start();
      await ola.driver.start();
      await stalePackage(fake, ola, "ola", Math.floor(Date.now() / 1000) + offset);

      await kari.driver.send(dm, "ola", text("fresh one"));
      await fake.settle();
      assert.equal(fake.stats.claims, 2);
      assert.deepEqual(ola.texts(), ["kari: fresh one"]);
    });
  }

  it("stores each package's expiry and renews a last-resort one close to it", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const ola = device(fake, "ola", "phone");
    await ola.driver.start();
    const now = Math.floor(Date.now() / 1000);
    const records = [...ola.store.keyPackages.values()];
    assert.ok(records.every((k) => k.expiresAt !== undefined && Math.abs(k.expiresAt - (now + 30 * DAY)) < 2 * 3600));

    const last = records.find((k) => k.lastResort)!;
    last.expiresAt = now + 3 * DAY;
    await ola.driver.start();
    const lastResorts = fake.keyPackages.filter((k) => k.lastResort && !k.claimed);
    assert.equal(lastResorts.length, 1);
    assert.notEqual(lastResorts[0].ref, last.ref, "a new last-resort package replaced the old one");
    assert.ok(ola.store.keyPackages.has(last.ref), "the old private half stays for Welcomes already on their way");
  });

  it("won't add a peer whose person key isn't pinned, and will once it is", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const kari = device(fake, "kari", "laptop", { unpinned: ["ola"] });
    const ola = device(fake, "ola", "phone");
    await kari.driver.start();
    await ola.driver.start();

    await assert.rejects(kari.driver.send(dm, "ola", text("x")), (e: unknown) => e instanceof MlsDriverError && e.code === "peer_unverified");
    assert.equal(fake.groups.get(dm)!.epoch, 0);

    kari.pinPerson("ola");
    await kari.driver.send(dm, "ola", text("now pinned"));
    await fake.settle();
    assert.deepEqual(ola.texts(), ["kari: now pinned"]);
  });

  it("keeps a Welcome from a peer it hasn't pinned yet, and joins once it has", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const kari = device(fake, "kari", "laptop", { unpinned: ["ola"] });
    const ola = device(fake, "ola", "phone");
    await kari.driver.start();
    await ola.driver.start();

    await ola.driver.send(dm, "kari", text("hei"));
    await fake.settle();
    assert.equal(kari.store.groups.size, 0);
    assert.equal(fake.welcomes.length, 1, "the Welcome stays on the server");

    kari.pinPerson("ola");
    await kari.driver.start();
    await fake.settle();
    assert.deepEqual(kari.texts(), ["ola: hei"]);
    assert.equal(fake.welcomes.length, 0);
  });

  it("tops KeyPackages back up once fewer than half are left", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const ola = device(fake, "ola", "phone");
    await ola.driver.start();
    fake.keyPackages.filter((k) => !k.lastResort).slice(0, 11).forEach((k) => (k.claimed = true));
    await ola.driver.start();
    assert.equal(fake.keyPackages.filter((k) => !k.lastResort && !k.claimed).length, 20);
    assert.equal(ola.store.keyPackages.size, 32, "claimed packages keep their private half until a Welcome uses it");
  });

  it("reports a gap when the server swept entries this device never read", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const kari = device(fake, "kari", "laptop");
    const ola = device(fake, "ola", "phone");
    await kari.driver.start();
    await ola.driver.start();
    await kari.driver.send(dm, "ola", text("seen"));
    await fake.settle();

    ola.socket.online = false;
    await kari.driver.send(dm, "ola", text("swept"));
    await kari.driver.send(dm, "ola", text("kept"));
    fake.dropLogThrough(dm, 3);
    ola.socket.online = true;
    await ola.driver.start();

    assert.deepEqual(ola.texts(), ["kari: seen", "kari: kept"]);
    assert.deepEqual(ola.undecryptable, [{ conversationId: dm, seq: 3, reason: "gap" }]);
  });

  it("keeps every packet to ten binary parts, which is all socket.io takes", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const { transport } = fake.connect("nobody");
    await assert.rejects(
      transport.publishKeyPackages({ deviceId: "d", keyPackages: Array.from({ length: 11 }, () => new Uint8Array(1)) }),
      /too many attachments/,
    );
    fake.stats.mostBinaryParts = 0;

    const ola = device(fake, "ola", "phone");
    await ola.driver.start();
    assert.equal(fake.stats.publishes, 3, "20 packages and a last-resort one, nine at a time");
    assert.equal(fake.keyPackages.length, 21);
    assert.ok(fake.stats.mostBinaryParts <= 10);
  });

  it("sends the upload ids with the message, and the keys inside it", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const kari = device(fake, "kari", "laptop");
    const ola = device(fake, "ola", "phone");
    await kari.driver.start();
    await ola.driver.start();

    const file = new TextEncoder().encode("a small file");
    const sealed = sealAttachment({ bytes: file, conversationId: dm, name: "notes.txt", mime: "text/plain" });
    const content = encodeMlsDmContent({ type: "message", id: "m-1", text: "here", attachments: { "upload-1": sealed.meta } });
    const { seq } = await kari.driver.send(dm, "ola", content, { attachmentIds: ["upload-1"] });
    await fake.settle();

    assert.deepEqual(fake.attachmentIds.get(seq), ["upload-1"]);
    const read = decodeMlsDmContent(ola.messages[0].plaintext);
    assert.ok(read?.type === "message" && read.attachments);
    const opened = openAttachment({ ciphertext: sealed.ciphertext, conversationId: dm, meta: read.attachments["upload-1"] });
    assert.deepEqual(opened, file);

    const eleven = Array.from({ length: 11 }, (_, i) => `u${i}`);
    await assert.rejects(kari.driver.send(dm, "ola", content, { attachmentIds: eleven }), (e: unknown) => e instanceof MlsDriverError && e.code === "too_many_attachments");
  });

  it("keeps syncing while a server hands Welcomes out a few at a time", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    fake.syncWelcomeLimit = 1;
    const withKari = fake.dm("kari", "ola");
    const withMallory = fake.dm("mallory", "ola");
    const kari = device(fake, "kari", "laptop");
    const mallory = device(fake, "mallory", "laptop");
    const ola = device(fake, "ola", "phone");
    for (const d of [kari, mallory, ola]) await d.driver.start();
    ola.socket.online = false;
    await kari.driver.send(withKari, "ola", text("from kari"));
    await mallory.driver.send(withMallory, "ola", text("from mallory"));
    assert.equal(fake.welcomes.length, 2);

    ola.socket.online = true;
    await ola.driver.start();
    assert.deepEqual(ola.texts().sort(), ["kari: from kari", "mallory: from mallory"]);
    assert.equal(fake.welcomes.length, 0);
  });

  it("says when a device is waiting to be added", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const kari = device(fake, "kari", "laptop");
    await assert.rejects(kari.driver.send(dm, "ola", text("x")), (e: unknown) => e instanceof MlsDriverError && e.code === "no_device");
  });
});

describe("MLS DM driver, sending across a lost connection (GRYT-1584)", () => {
  const isCode = (code: string) => (e: unknown) => e instanceof MlsDriverError && e.code === code;
  const turn = () => new Promise((resolve) => setTimeout(resolve, 5));
  const logOf = (fake: FakeDeliveryService, dm: string) => fake.groups.get(dm)!.log.filter((e) => e.kind === "application");

  async function pair() {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const kari = device(fake, "kari", "laptop");
    const ola = device(fake, "ola", "phone");
    await kari.driver.start();
    await ola.driver.start();
    await kari.driver.send(dm, "ola", text("before"));
    await fake.settle();
    return { fake, dm, kari, ola };
  }

  it("waits while offline, then sends once start() has caught up", async () => {
    const { fake, dm, kari, ola } = await pair();
    kari.socket.reachable = false;
    let settled = false;
    const sending = kari.driver.send(dm, "ola", text("while down")).finally(() => (settled = true));
    await turn();
    assert.deepEqual(kari.waiting, [true]);
    assert.equal(settled, false, "it waits rather than failing");

    kari.socket.reachable = true;
    await kari.driver.start();
    const { seq } = await sending;
    await fake.settle();
    assert.deepEqual(kari.waiting, [true, false]);
    assert.deepEqual(ola.texts(), ["kari: before", "kari: while down"]);
    assert.equal(logOf(fake, dm).at(-1)!.seq, seq);
  });

  it("encrypts after the catch-up, so a device added while it waited can read it", async () => {
    const { fake, dm, kari, ola } = await pair();
    kari.socket.reachable = false;
    const sending = kari.driver.send(dm, "ola", text("while away"));
    await turn();

    // Ola's new tablet goes in while Kari is away, so the group moves on an epoch.
    const tablet = device(fake, "ola", "tablet");
    await tablet.driver.start();
    await ola.driver.send(dm, "kari", text("hi from ola"));
    await fake.settle();
    assert.equal(fake.groups.get(dm)!.epoch, 2);

    kari.socket.reachable = true;
    await kari.driver.start();
    await sending;
    await fake.settle();
    assert.equal(logOf(fake, dm).at(-1)!.epoch, 2, "encrypted in the epoch it went out in");
    assert.deepEqual(tablet.texts(), ["ola: hi from ola", "kari: while away"]);
    assert.deepEqual(tablet.undecryptable, []);
  });

  it("sends the same bytes again when an answer was lost, and the log holds it once", async () => {
    const { fake, dm, kari, ola } = await pair();
    kari.socket.lose.set("send", "answer");
    const { seq } = await kari.driver.send(dm, "ola", text("answer lost"));
    await fake.settle();
    assert.equal(logOf(fake, dm).filter((e) => e.seq === seq).length, 1);
    assert.equal(logOf(fake, dm).length, 2);
    assert.deepEqual(ola.texts(), ["kari: before", "kari: answer lost"]);
    assert.deepEqual(ola.undecryptable, []);
    assert.deepEqual(kari.waiting, [], "a lost answer isn't a lost connection");
  });

  it("goes again after a request that never arrived, and lands once", async () => {
    const { fake, dm, kari, ola } = await pair();
    kari.socket.lose.set("send", "request");
    await kari.driver.send(dm, "ola", text("request lost"));
    await fake.settle();
    assert.equal(logOf(fake, dm).length, 2);
    assert.deepEqual(ola.texts(), ["kari: before", "kari: request lost"]);
  });

  it("knows its own message in the log after a reconnect, and doesn't send it again", async () => {
    const { fake, dm, kari, ola } = await pair();
    const sendsBy = () => (fake.callsBy.get(kari.store.device!.deviceId) ?? []).filter((c) => c === "send").length;
    kari.socket.lose.set("send", "answer");
    const sending = kari.driver.send(dm, "ola", text("landed"));
    await turn();
    // Reconnected before the resend: the catch-up finds it, and the log is the answer.
    await kari.driver.start();
    const { seq } = await sending;
    assert.equal(sendsBy(), 2, "the one before, and this one once");
    assert.equal(logOf(fake, dm).filter((e) => e.seq === seq).length, 1);
    await fake.settle();
    assert.deepEqual(ola.texts(), ["kari: before", "kari: landed"]);
  });

  it("keeps its place when a commit's answer was lost, and adds the peer once", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const kari = device(fake, "kari", "laptop");
    const ola = device(fake, "ola", "phone");
    await kari.driver.start();
    await ola.driver.start();
    kari.socket.lose.set("commit", "answer");
    await kari.driver.send(dm, "ola", text("first"));
    await fake.settle();
    assert.deepEqual(kari.lost, []);
    assert.equal(fake.groups.get(dm)!.epoch, 1, "the add went in once");
    assert.deepEqual(ola.texts(), ["kari: first"]);
    await ola.driver.send(dm, "kari", text("and back"));
    await fake.settle();
    assert.deepEqual(kari.texts(), ["ola: and back"]);
  });

  it("sends in the order they were typed once it's back", async () => {
    const { fake, dm, kari, ola } = await pair();
    kari.socket.reachable = false;
    const sends = ["one", "two", "three"].map((t) => kari.driver.send(dm, "ola", text(t)));
    await turn();
    kari.socket.reachable = true;
    await kari.driver.start();
    await Promise.all(sends);
    await fake.settle();
    assert.deepEqual(ola.texts(), ["kari: before", "kari: one", "kari: two", "kari: three"]);
  });

  it("gives up after the cap, and says offline", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const kari = device(fake, "kari", "laptop", { sendGiveUpMs: 30 });
    const ola = device(fake, "ola", "phone");
    await kari.driver.start();
    await ola.driver.start();
    kari.socket.reachable = false;
    await assert.rejects(kari.driver.send(dm, "ola", text("never")), isCode("offline"));
    kari.socket.reachable = true;
    await kari.driver.start();
    await fake.settle();
    assert.deepEqual(ola.texts(), []);
  });

  it("fails what's waiting on stop(), and takes nothing after", async () => {
    const { dm, kari } = await pair();
    kari.socket.reachable = false;
    const sending = kari.driver.send(dm, "ola", text("stopped"));
    await turn();
    kari.driver.stop();
    await assert.rejects(sending, isCode("stopped"));
    await assert.rejects(kari.driver.send(dm, "ola", text("after")), isCode("stopped"));
  });

  it("still fails straight away on a refusal", async () => {
    const { fake, dm, kari } = await pair();
    fake.groups.get(dm)!.epoch = 0;
    await assert.rejects(kari.driver.send(dm, "ola", text("future")), isCode("refused"));
  });
});

describe("MLS DM driver, a device nobody added (GRYT-1858)", () => {
  const isCode = (code: string) => (e: unknown) => e instanceof MlsDriverError && e.code === code;

  /* Kari's phone and Ola have a group; Kari's laptop registers after, and nobody has sent since. */
  async function lateLaptop() {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const phone = device(fake, "kari", "phone");
    const ola = device(fake, "ola", "phone");
    await phone.driver.start();
    await ola.driver.start();
    await phone.driver.send(dm, "ola", text("hei"));
    await fake.settle();
    const laptop = device(fake, "kari", "laptop");
    await laptop.driver.start();
    await fake.settle();
    return { fake, dm, phone, ola, laptop };
  }

  it("asks to be added on its first send, and the send goes through", async () => {
    const { fake, dm, ola, laptop } = await lateLaptop();
    await laptop.driver.send(dm, "ola", text("from the laptop"));
    await fake.settle();
    assert.ok(ola.texts().includes("kari: from the laptop"));
  });

  it("says it isn't in the group when a message comes for it, and joins once asked again", async () => {
    const { fake, dm, ola, laptop } = await lateLaptop();
    // No GroupInfo, so the laptop can't join by itself and has to ask.
    fake.groups.get(dm)!.info = undefined;
    const laptopId = laptop.store.device!.deviceId;
    for (const k of fake.keyPackages) if (k.deviceId === laptopId) k.claimed = true;

    await ola.driver.send(dm, "kari", text("one"));
    await fake.settle();
    await new Promise((resolve) => setTimeout(resolve, 3_100));
    assert.equal(laptop.store.groups.size, 0, "Ola had no package to add it with");
    assert.deepEqual(laptop.lost.at(-1), { conversationId: dm, reason: "not_added" });

    await laptop.driver.start();
    await laptop.driver.requestAdd(dm);
    await fake.settle();
    await ola.driver.send(dm, "kari", text("two"));
    await fake.settle();
    assert.deepEqual(laptop.texts(), ["ola: two"]);
  });

  it("says the peer's key isn't checked when it holds a Welcome it can't join", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const kari = device(fake, "kari", "laptop", { unpinned: ["ola"] });
    const ola = device(fake, "ola", "phone");
    await kari.driver.start();
    await ola.driver.start();
    await ola.driver.send(dm, "kari", text("hei"));
    await fake.settle();
    await assert.rejects(kari.driver.send(dm, "ola", text("x")), isCode("peer_unverified"));
  });
});

describe("MLS DM driver, more than five devices (GRYT-1872)", () => {
  it("adds every one of somebody's six devices to a DM", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const ola = device(fake, "ola", "phone");
    const karis = Array.from({ length: 6 }, (_, i) => device(fake, "kari", `device ${i + 1}`));
    for (const d of [ola, ...karis]) await d.driver.start();

    await ola.driver.send(dm, "kari", text("hei alle"));
    await fake.settle();
    for (const d of karis) assert.deepEqual(d.texts(), ["ola: hei alle"]);
  });
});

describe("MLS DM driver, joining by itself (GRYT-1859)", () => {
  it("lets a new device in from the GroupInfo while every other device is closed", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const phone = device(fake, "kari", "phone");
    const ola = device(fake, "ola", "phone");
    await phone.driver.start();
    await ola.driver.start();
    await phone.driver.send(dm, "ola", text("hei"));
    await fake.settle();

    phone.socket.online = false;
    ola.socket.online = false;
    const laptop = device(fake, "kari", "laptop");
    await laptop.driver.start();
    await laptop.driver.send(dm, "ola", text("fra laptopen"));
    assert.equal(fake.welcomes.length, 0, "nobody had to add it");

    ola.socket.online = true;
    phone.socket.online = true;
    await ola.driver.start();
    await phone.driver.start();
    await fake.settle();
    assert.ok(ola.texts().includes("kari: fra laptopen"));
    assert.ok(phone.texts().includes("kari: fra laptopen"));

    await ola.driver.send(dm, "kari", text("hei laptop"));
    await fake.settle();
    assert.deepEqual(laptop.texts(), ["ola: hei laptop"]);
  });

  it("takes back its own leaf when it lost the group but kept its device (GRYT-1862)", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const phone = device(fake, "kari", "phone");
    const ola = device(fake, "ola", "phone");
    await phone.driver.start();
    await ola.driver.start();
    await phone.driver.send(dm, "ola", text("hei"));
    await fake.settle();

    phone.socket.online = false;
    const kept = new MemoryMlsStore();
    kept.device = phone.store.device;
    const again = device(fake, "kari", "phone", { store: kept });
    await again.driver.start();
    await again.driver.send(dm, "ola", text("tilbake"));
    await fake.settle();
    assert.ok(ola.texts().includes("kari: tilbake"));

    const rec = ola.store.groups.get(dm)!;
    const state = decodeMlsGroupState(rec.state, { scope: SCOPE, trustPersonKey: async () => true });
    assert.equal(mlsGroupMembers(state, SCOPE).length, 2, "its old leaf went instead of staying beside the new one");
  });

  it("drops a copy that can't follow the log and joins again, so it can still send (GRYT-1862)", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const laptop = device(fake, "kari", "laptop");
    const ola = device(fake, "ola", "phone");
    await laptop.driver.start();
    await ola.driver.start();
    await laptop.driver.send(dm, "ola", text("hei"));
    await fake.settle();

    laptop.socket.online = false;
    for (const name of ["phone", "tablet"]) {
      const d = device(fake, "kari", name);
      await d.driver.start();
      await d.driver.send(dm, "ola", text(`fra ${name}`));
      await fake.settle();
    }
    // The laptop's copy skips the phone's join, so the tablet's commit is one epoch ahead of it.
    const rec = laptop.store.groups.get(dm)!;
    rec.cursor = fake.groups.get(dm)!.log.find((e) => e.seq > rec.cursor && e.kind === "commit")!.seq;

    laptop.socket.online = true;
    await laptop.driver.start();
    await laptop.driver.send(dm, "ola", text("tilbake"));
    await fake.settle();
    assert.ok(laptop.lost.some((l) => l.reason === "out_of_sync"));
    assert.ok(ola.texts().includes("kari: tilbake"));
  });

  it("lets a device back in after the server expired it, once it registers again (GRYT-1872)", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const phone = device(fake, "kari", "phone");
    const tablet = device(fake, "kari", "tablet");
    const ola = device(fake, "ola", "phone");
    for (const d of [phone, tablet, ola]) await d.driver.start();
    await phone.driver.send(dm, "ola", text("hei"));
    await fake.settle();
    assert.ok(tablet.texts().includes("kari: hei"));

    tablet.socket.online = false;
    fake.expire("kari", tablet.store.device!.deviceId);
    await ola.driver.send(dm, "kari", text("tablet is out"));
    await fake.settle();

    tablet.socket.online = true;
    await tablet.driver.start();
    await fake.settle();
    assert.ok(tablet.lost.some((l) => l.reason === "removed"));
    await ola.driver.send(dm, "kari", text("welcome back"));
    await fake.settle();
    assert.ok(tablet.texts().includes("ola: welcome back"));
  });

  it("describes a DM for support without creating anything (GRYT-1864)", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const phone = device(fake, "kari", "phone");
    const ola = device(fake, "ola", "phone");
    await phone.driver.start();
    await ola.driver.start();
    await phone.driver.send(dm, "ola", text("hei"));
    await fake.settle();
    const fresh = device(fake, "kari", "tablet");

    const d = await phone.driver.diagnose(dm);
    assert.equal(d.deviceId, phone.store.device!.deviceId);
    assert.equal(d.group?.epoch, 1);
    assert.deepEqual(new Set(d.inGroup?.map((m) => m.name)), new Set(["phone"]));
    assert.equal(d.inGroup?.find((m) => m.thisDevice)?.name, "phone");
    assert.equal(d.listed?.length, 2);

    const none = await fresh.driver.diagnose(dm);
    assert.equal(none.deviceId, null);
    assert.equal(fresh.store.device, null, "looking made no device record");
  });

  it("asks to be added when there's no GroupInfo to join from", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const phone = device(fake, "kari", "phone");
    const ola = device(fake, "ola", "phone");
    await phone.driver.start();
    await ola.driver.start();
    await phone.driver.send(dm, "ola", text("hei"));
    await fake.settle();
    fake.groups.get(dm)!.info = undefined;

    const laptop = device(fake, "kari", "laptop");
    await laptop.driver.start();
    await laptop.driver.send(dm, "ola", text("via a request"));
    await fake.settle();
    assert.ok(ola.texts().includes("kari: via a request"));
  });
});
