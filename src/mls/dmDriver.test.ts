import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  asIdentityScope,
  createMlsDevice,
  derivePersonKeyPair,
  generateMlsKeyPackage,
  pinPeerKey,
  pinPersonKey,
  readMlsKeyPackage,
  type PeerPin,
  type VerifiedDmKeyBinding,
  type VerifiedPersonKeyBinding,
} from "@gryt/crypto";

import { FakeDeliveryService, MemoryMlsStore } from "./deliveryService.fake.ts";
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

type DeviceOptions = { seed?: Uint8Array; capability?: MlsServerCapability | null; unpinned?: string[] };

function device(fake: FakeDeliveryService, who: string, name: string, opts: DeviceOptions = {}) {
  const store = new MemoryMlsStore();
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
    },
    newDevice: () => createMlsDevice({ seed, scope: SCOPE, deviceName: name }),
  });
  socket.driver = driver;
  const texts = () => messages.map((m) => `${m.senderServerUserId}: ${new TextDecoder().decode(m.plaintext)}`);
  return { driver, store, messages, lost, undecryptable, seen, socket, texts, pinPerson: pins.pinPerson };
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

  it("says when a device is waiting to be added", async () => {
    const fake = new FakeDeliveryService(SCOPE);
    const dm = fake.dm("kari", "ola");
    const kari = device(fake, "kari", "laptop");
    await assert.rejects(kari.driver.send(dm, "ola", text("x")), (e: unknown) => e instanceof MlsDriverError && e.code === "no_device");
  });
});
