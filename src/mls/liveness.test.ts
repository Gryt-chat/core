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
import { createMlsDmDriver } from "./dmDriver.ts";
import type { MlsDmDriver } from "./interfaces.ts";
import { mlsPinsFromPeerPins } from "./pins.ts";

/* The promise (GRYT-1860): once everything is back online and has started, every device the
   server lists can send in the DM, and every other listed device reads it. Random runs, by seed. */

const SCOPE = asIdentityScope("srv:liveness");
const CAPABILITY = { version: 1, ciphersuites: [1], retentionDays: 30 };
const PEOPLE = ["kari", "mia"] as const;
const seedOf = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * n + n) % 251);
const SEEDS = { kari: seedOf(3), mia: seedOf(5) };
const RUNS = Number(process.env.MLS_LIVENESS_RUNS ?? 25);
const STEPS = 14;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

interface Device {
  who: (typeof PEOPLE)[number];
  name: string;
  driver: MlsDmDriver;
  socket: { online: boolean; reachable: boolean };
  store: MemoryMlsStore;
  received: string[];
  gone: boolean;
}

function newDevice(fake: FakeDeliveryService, who: Device["who"], name: string): Device {
  const other = who === "kari" ? "mia" : "kari";
  let pins: Record<string, PeerPin> = {};
  const pinStore = { read: () => structuredClone(pins), write: (p: Record<string, PeerPin>) => void (pins = structuredClone(p)) };
  pinPeerKey(pinStore, SCOPE, other, { dmPublicKey: new Uint8Array(32), identityThumbprint: `id-${other}` } as VerifiedDmKeyBinding);
  pinPersonKey(pinStore, SCOPE, other, {
    personPublicKey: derivePersonKeyPair(SEEDS[other], SCOPE).publicKey,
    identityThumbprint: `id-${other}`,
    scope: SCOPE,
    signedAt: 0,
  } as VerifiedPersonKeyBinding);
  const store = new MemoryMlsStore();
  const received: string[] = [];
  const { transport, socket } = fake.connect(who);
  const driver = createMlsDmDriver({
    transport,
    store,
    scope: SCOPE,
    serverUserId: who,
    capability: CAPABILITY,
    pins: mlsPinsFromPeerPins({
      store: pinStore,
      scope: SCOPE,
      serverUserId: who,
      ownPersonKey: derivePersonKeyPair(SEEDS[who], SCOPE).publicKey,
      membersOf: (c) => fake.conversations.get(c) ?? [],
      seen: new Set(),
    }),
    events: { onMessage: (m) => void received.push(new TextDecoder().decode(m.plaintext)) },
    newDevice: () => createMlsDevice({ seed: SEEDS[who], scope: SCOPE, deviceName: name }),
    sendGiveUpMs: 200,
    welcomeWaitMs: 200,
  });
  socket.driver = driver;
  return { who, name, driver, socket, store, received, gone: false };
}

const peerOf = (who: Device["who"]) => (who === "kari" ? "mia" : "kari");
const text = (s: string) => new TextEncoder().encode(s);

async function run(seed: number): Promise<{ log: string[]; stuck: string[] }> {
  const random = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)];
  const fake = new FakeDeliveryService(SCOPE);
  const dm = fake.dm("kari", "mia");
  const log: string[] = [];
  let n = 0;
  const devices: Device[] = [];
  const live = () => devices.filter((d) => !d.gone);
  const online = () => live().filter((d) => d.socket.online);

  const add = async (who: Device["who"]) => {
    const d = newDevice(fake, who, `${who}-${++n}`);
    devices.push(d);
    await d.driver.start().catch(() => undefined);
    log.push(`${d.name} registers`);
  };
  await add("kari");
  await add("mia");

  for (let step = 0; step < STEPS; step++) {
    const r = random();
    if (r < 0.35 && online().length) {
      const d = pick(online());
      const body = `${d.name}#${step}`;
      const outcome = await d.driver.send(dm, peerOf(d.who), text(body)).then(() => "sent", (e: { code?: string }) => e.code ?? "error");
      log.push(`${d.name} sends ${body}: ${outcome}`);
    } else if (r < 0.55 && online().length > 1) {
      const d = pick(online());
      d.socket.online = d.socket.reachable = false;
      log.push(`${d.name} goes offline`);
    } else if (r < 0.75 && live().some((d) => !d.socket.online)) {
      const d = pick(live().filter((x) => !x.socket.online));
      d.socket.online = d.socket.reachable = true;
      await d.driver.start().catch(() => undefined);
      log.push(`${d.name} comes back`);
    } else if (r < 0.9) {
      // Three each, under the server's five, so a wipe's new device always fits.
      const room = PEOPLE.filter((who) => live().filter((d) => d.who === who).length < 3);
      if (room.length) await add(pick(room));
    } else if (live().length > 2) {
      // A wipe: the app retires the old device and makes a new one, as the client does.
      const old = pick(live());
      const keeper = live().find((d) => d !== old && d.who === old.who && d.socket.online);
      if (keeper) {
        old.gone = true;
        old.socket.online = old.socket.reachable = false;
        await keeper.driver.removeOwnDevice(fake.devices.get(old.who)?.find((id) => id === old.store.device?.deviceId) ?? "").catch(() => undefined);
        log.push(`${old.name} is wiped and retired by ${keeper.name}`);
        await add(old.who);
      }
    }
    await fake.settle();
  }

  // Everything back, the way an app comes back: online, then start().
  for (const d of live()) d.socket.online = d.socket.reachable = true;
  for (let round = 0; round < 2; round++) {
    for (const d of live()) await d.driver.start().catch(() => undefined);
    await fake.settle();
  }

  const stuck: string[] = [];
  for (const d of live()) {
    const body = `final from ${d.name}`;
    let outcome = "";
    // "Try again in a bit" is the promise's whole allowance: two tries, with the server settled between.
    for (let attempt = 0; attempt < 2 && outcome !== "sent"; attempt++) {
      outcome = await d.driver.send(dm, peerOf(d.who), text(body)).then(() => "sent", (e: { code?: string }) => e.code ?? "error");
      await fake.settle();
    }
    if (outcome !== "sent") stuck.push(`${d.name} can't send: ${outcome}`);
  }
  await fake.settle();
  for (const reader of live()) {
    for (const writer of live()) {
      if (writer === reader) continue;
      if (!reader.received.includes(`final from ${writer.name}`)) stuck.push(`${reader.name} didn't read ${writer.name}`);
    }
  }
  return { log, stuck };
}

describe("MLS DM liveness (GRYT-1860)", () => {
  it(`every listed device can send and read once everything is back, over ${RUNS} random runs`, async () => {
    const base = Number(process.env.MLS_LIVENESS_SEED ?? 1);
    const failures: string[] = [];
    for (let i = 0; i < RUNS; i++) {
      const { log, stuck } = await run(base + i);
      if (stuck.length) failures.push(`seed ${base + i}:\n  ${log.join("\n  ")}\n  -> ${stuck.join("\n  -> ")}`);
    }
    if (failures.length) console.log(failures.join("\n\n"));
    assert.deepEqual(failures, [], `${failures.length} of ${RUNS} runs left a device stuck`);
  });
});
