import {
  addMlsMembers,
  asIdentityScope,
  base64UrlDecode,
  createMlsGroup,
  decodeMlsGroupState,
  encodeMlsGroupState,
  encryptMlsMessage,
  forgetMlsSecrets,
  generateMlsKeyPackage,
  joinMlsGroup,
  mlsGroupInfo,
  mlsGroupMembers,
  mlsWelcomeRefs,
  processMlsMessage,
  readMlsKeyPackage,
  removeMlsMembers,
  type DeviceCertificate,
  type MlsCommit,
  type MlsGroupState,
  type MlsTrust,
} from "@gryt/crypto";

import type {
  DmSealingMode,
  MlsClaimedKeyPackage,
  MlsDeviceRecord,
  MlsDeviceRef,
  MlsDmDriver,
  MlsDmDriverOptions,
  MlsGroupRecord,
  MlsKeyPackageRecord,
  MlsLogEntry,
  MlsRefusal,
  MlsWelcomeDelivery,
} from "./interfaces.js";

/** Five devices per person per server (design, section 1). The server holds the same line. */
const MLS_MAX_DEVICES_PER_PERSON = 5;
const COMMIT_ATTEMPTS = 5;
const LOG_PAGE = 200;
const WELCOME_WAIT_MS = 10_000;
/** The server keeps Welcomes 30 days; a last-resort package is replaced with a week to go. */
const WELCOME_KEEP_S = 30 * 86_400;
const RENEW_BEFORE_S = 7 * 86_400;

export type MlsDriverErrorCode =
  | "refused"
  | "no_device"
  | "waiting_for_welcome"
  | "not_in_group"
  | "unexpected_member"
  | "commit_retries";

export class MlsDriverError extends Error {
  code: MlsDriverErrorCode;
  /** The server's refusal, when there was one. */
  refusal?: MlsRefusal;

  constructor(code: MlsDriverErrorCode, message: string, refusal?: MlsRefusal) {
    super(message);
    this.name = "MlsDriverError";
    this.code = code;
    this.refusal = refusal;
  }
}

function refused(what: string, r: MlsRefusal): MlsDriverError {
  return new MlsDriverError("refused", `${what}: ${r.error} (${r.message})`, r);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const epochOf = (state: MlsGroupState) => Number(mlsGroupInfo(state).epoch);
const groupIdOf = (state: MlsGroupState) => toHex(base64UrlDecode(mlsGroupInfo(state).groupId));

/* One job at a time per key, in the order they were asked for. A job must never wait on
   another job with its own key. */
function keyedQueue() {
  const tails = new Map<string, Promise<void>>();
  return <T>(key: string, job: () => Promise<T>): Promise<T> => {
    const result = (tails.get(key) ?? Promise.resolve()).then(job);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}

/** A group in memory while one job works on it. `rec.state` is only rewritten on save. */
interface Open {
  rec: MlsGroupRecord;
  state: MlsGroupState;
}

export function createMlsDmDriver(options: MlsDmDriverOptions): MlsDmDriver {
  const { transport, store, pins, events, serverUserId: self, capability } = options;
  const scope = asIdentityScope(options.scope);
  const trusts = new Map<string, MlsTrust>();
  /** What the engine asks about every leaf: is it somebody in this conversation, by pin. */
  function trustFor(conversationId: string): MlsTrust {
    let t = trusts.get(conversationId);
    if (!t) {
      t = { scope, trustPersonKey: async (c) => (await pins.personOf(conversationId, c.personPublicKey)) !== null };
      trusts.set(conversationId, t);
    }
    return t;
  }
  const run = keyedQueue();

  let device: MlsDeviceRecord | null = null;
  let registered = false;
  /** Conversations whose device list was checked since the last `mls:devices:changed`. */
  const reconciled = new Set<string>();
  const seen = new Set<string>();
  const welcomeWaiters = new Map<string, (() => void)[]>();

  async function ownDevice(): Promise<MlsDeviceRecord> {
    if (device) return device;
    let d = await store.loadDevice();
    if (!d) {
      d = await options.newDevice();
      await store.saveDevice(d);
    }
    device = d;
    return d;
  }

  async function markSeen(serverUserId: string): Promise<void> {
    if (serverUserId === self || seen.has(serverUserId)) return;
    await pins.markSeenOnMls(serverUserId);
    seen.add(serverUserId);
  }

  /** Every person with a leaf in the group, by pin. Null for a leaf nobody's pin covers. */
  async function peopleIn(conversationId: string, state: MlsGroupState): Promise<(string | null)[]> {
    const members = mlsGroupMembers(state, scope);
    return Promise.all(members.map((m) => pins.personOf(conversationId, m.certificate.personPublicKey)));
  }

  async function notePeople(conversationId: string, state: MlsGroupState): Promise<void> {
    for (const person of await peopleIn(conversationId, state)) if (person) await markSeen(person);
  }

  async function save(open: Open, cursor = open.rec.cursor): Promise<void> {
    open.rec = { ...open.rec, state: encodeMlsGroupState(open.state), cursor };
    await store.saveGroup(open.rec);
  }

  async function load(conversationId: string): Promise<Open | null> {
    const rec = await store.loadGroup(conversationId);
    return rec ? { rec, state: decodeMlsGroupState(rec.state, trustFor(conversationId)) } : null;
  }

  // ── KeyPackages ─────────────────────────────────────────────────────

  async function topUp(counts: { unclaimed: number; lastResort: boolean; target: number }, forceLastResort = false) {
    const d = await ownDevice();
    const now = Math.floor(Date.now() / 1000);
    const held = await store.listKeyPackages();
    // A Welcome can still name a package for as long as the server keeps Welcomes.
    for (const k of held) if (k.expiresAt !== undefined && k.expiresAt < now - WELCOME_KEEP_S) await store.deleteKeyPackage(k.ref);
    const newestLast = held.filter((k) => k.lastResort).sort((a, b) => b.createdAt - a.createdAt)[0];
    const lastRunningOut = newestLast?.expiresAt !== undefined && newestLast.expiresAt - now < RENEW_BEFORE_S;

    const wanted = !registered || counts.unclaimed < counts.target / 2 ? counts.target - counts.unclaimed : 0;
    const needLastResort = !counts.lastResort || forceLastResort || lastRunningOut;
    if (wanted <= 0 && !needLastResort && registered) return;

    const make = async (lastResort: boolean): Promise<MlsKeyPackageRecord> => {
      const kp: { keyPackage: Uint8Array; privatePackage: Uint8Array; ref: string; expiresAt?: number } =
        await generateMlsKeyPackage(d);
      return { ...kp, lastResort, createdAt: Date.now() };
    };
    const fresh: MlsKeyPackageRecord[] = [];
    for (let i = 0; i < wanted; i++) fresh.push(await make(false));
    const last = needLastResort ? await make(true) : undefined;
    // The private halves are stored first, so a Welcome can never name one this device lost.
    await store.putKeyPackages(last ? [...fresh, last] : fresh);

    const r = await transport.publishKeyPackages({
      deviceId: d.deviceId,
      keyPackages: fresh.map((k) => k.keyPackage),
      lastResort: last?.keyPackage,
    });
    if (!r.ok) throw refused("Publishing KeyPackages", r);
    registered = true;
  }

  async function syncAndTopUp(forceLastResort = false): Promise<MlsWelcomeDelivery[]> {
    const d = await ownDevice();
    const r = await transport.sync({ deviceId: d.deviceId });
    if (!r.ok) throw refused("Sync", r);
    registered = r.registered;
    await topUp(r.keyPackages, forceLastResort);
    return r.welcomes;
  }

  // ── The log ─────────────────────────────────────────────────────────

  /** Returns false once the group can't go on from here; the state is kept, not dropped. */
  async function applyEntry(open: Open, e: MlsLogEntry): Promise<boolean> {
    if (e.seq <= open.rec.cursor) return true;
    const d = await ownDevice();
    const current = epochOf(open.state);

    if (e.kind === "commit") {
      const pending = open.rec.pending;
      if (pending && sameBytes(pending.commit, e.data)) {
        open.state = decodeMlsGroupState(pending.state, trustFor(open.rec.conversationId));
      } else if (e.epoch < current) {
        // Already in this state: our own commit, or one from before this device joined.
      } else if (e.epoch > current) {
        events.onGroupLost?.({ conversationId: open.rec.conversationId, reason: "out_of_sync" });
        return false;
      } else {
        try {
          const r = await processMlsMessage(open.state, e.data);
          if (r.kind === "handshake" && r.removed) {
            await store.deleteGroup(open.rec.conversationId);
            events.onGroupLost?.({ conversationId: open.rec.conversationId, reason: "removed" });
            return false;
          }
          open.state = r.state;
        } catch {
          events.onGroupLost?.({ conversationId: open.rec.conversationId, reason: "out_of_sync" });
          return false;
        }
      }
      open.rec = { ...open.rec, pending: undefined };
      await notePeople(open.rec.conversationId, open.state);
    } else if (e.kind === "proposal") {
      if (e.epoch === current) {
        try {
          open.state = (await processMlsMessage(open.state, e.data)).state;
        } catch {
          events.onUndecryptable?.({ conversationId: open.rec.conversationId, seq: e.seq, reason: "bad_proposal" });
        }
      }
    } else if (!(e.senderServerUserId === self && e.senderDeviceId === d.deviceId) && e.epoch >= open.rec.joinedEpoch) {
      let plaintext: Uint8Array | null = null;
      try {
        const r = await processMlsMessage(open.state, e.data);
        if (r.kind !== "application") throw new Error("Not an application message.");
        open.state = r.state;
        plaintext = r.plaintext;
      } catch {
        events.onUndecryptable?.({ conversationId: open.rec.conversationId, seq: e.seq, reason: "undecryptable" });
      }
      if (plaintext) {
        await events.onMessage({
          conversationId: open.rec.conversationId,
          seq: e.seq,
          senderServerUserId: e.senderServerUserId,
          senderDeviceId: e.senderDeviceId,
          plaintext,
          createdAt: e.createdAt,
        });
        await markSeen(e.senderServerUserId);
      }
    }
    await save(open, e.seq);
    return true;
  }

  /** Everything after the cursor, a page at a time. False when the group stopped. */
  async function catchUp(open: Open): Promise<boolean> {
    for (;;) {
      const r = await transport.fetchLog({ conversationId: open.rec.conversationId, after: open.rec.cursor, limit: LOG_PAGE });
      if (!r.ok) throw refused("Reading the group log", r);
      if (r.group && r.group.groupId !== open.rec.groupId) {
        events.onGroupLost?.({ conversationId: open.rec.conversationId, reason: "out_of_sync" });
        return false;
      }
      if (r.gap && open.rec.cursor > 0) {
        events.onUndecryptable?.({ conversationId: open.rec.conversationId, seq: open.rec.cursor + 1, reason: "gap" });
      }
      for (const e of r.entries) if (!(await applyEntry(open, e))) return false;
      if (r.nextCursor > open.rec.cursor) await save(open, r.nextCursor);
      if (!r.hasMore) return true;
    }
  }

  // ── Commits ─────────────────────────────────────────────────────────

  /** Builds on the latest state, and on stale_epoch catches up and builds again. */
  async function commitWithRetry(open: Open, build: (state: MlsGroupState) => Promise<MlsCommit | null>): Promise<void> {
    const d = await ownDevice();
    for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
      const c = await build(open.state);
      if (!c) return;
      open.rec = { ...open.rec, pending: { commit: c.commit, state: encodeMlsGroupState(c.state) } };
      await save(open);

      const r = await transport.commit({
        conversationId: open.rec.conversationId,
        deviceId: d.deviceId,
        commit: c.commit,
        welcome: c.welcome,
      });
      if (r.ok) {
        open.state = c.state;
        forgetMlsSecrets(c.consumed);
        open.rec = { ...open.rec, pending: undefined };
        await save(open);
        return;
      }
      open.rec = { ...open.rec, pending: undefined };
      await save(open);
      if (r.error === "stale_epoch") {
        if (!(await catchUp(open))) throw new MlsDriverError("not_in_group", "This device lost its place in the group.");
        continue;
      }
      if (r.error === "no_group") {
        // Saved locally but never registered, from a crash in between.
        const created = await transport.createGroup({ conversationId: open.rec.conversationId, groupId: open.rec.groupId });
        if (created.ok) continue;
        await store.deleteGroup(open.rec.conversationId);
        throw refused("Registering the group", created);
      }
      throw refused("Committing", r);
    }
    throw new MlsDriverError("commit_retries", "Other commits kept getting there first.");
  }

  /** Removes leaves for devices the server no longer lists, and with `adds` adds new ones. */
  async function reconcile(open: Open, peer: string, adds: boolean): Promise<void> {
    const d = await ownDevice();
    const conversationId = open.rec.conversationId;
    const r = await transport.listDevices({ conversationId });
    if (!r.ok) throw refused("Listing devices", r);
    const listed = r.devices.filter((x) => x.serverUserId === self || x.serverUserId === peer);
    if (!listed.some((x) => x.serverUserId === self && x.deviceId === d.deviceId)) return;
    const isListed = (id: string) => listed.some((x) => x.deviceId === id);
    const treeIds = (s: MlsGroupState) => new Set(mlsGroupMembers(s, scope).map((m) => m.certificate.deviceId));

    await commitWithRetry(open, async (s) => {
      const gone = [...treeIds(s)].filter((id) => id !== d.deviceId && !isListed(id));
      return gone.length ? removeMlsMembers(s, gone, scope) : null;
    });
    if (!adds) return;

    const inTree = treeIds(open.state);
    const wanted = listed.filter((x) => !inTree.has(x.deviceId) && x.deviceId !== d.deviceId);
    if (wanted.length === 0) return;
    const verified: MlsClaimedKeyPackage[] = [];
    let asking: MlsDeviceRef[] = wanted;
    // A package that won't read, say one past its lifetime, gets one more claim for that device.
    for (let round = 0; round < 2 && asking.length > 0; round++) {
      const claim = await transport.claimKeyPackages({ conversationId, deviceId: d.deviceId, devices: asking });
      if (!claim.ok) throw refused("Claiming KeyPackages", claim);
      asking = [];
      for (const kp of claim.keyPackages) {
        const verdict = await vouchedFor(conversationId, kp, peer);
        if (verdict === "ok") verified.push(kp);
        else if (verdict === "unreadable") asking.push({ serverUserId: kp.serverUserId, deviceId: kp.deviceId });
      }
    }

    await commitWithRetry(open, async (s) => {
      const tree = treeIds(s);
      const counts = new Map<string, number>();
      for (const person of await peopleIn(conversationId, s)) if (person) counts.set(person, (counts.get(person) ?? 0) + 1);
      const add: MlsClaimedKeyPackage[] = [];
      for (const kp of verified) {
        const n = counts.get(kp.serverUserId) ?? 0;
        if (tree.has(kp.deviceId) || n >= MLS_MAX_DEVICES_PER_PERSON) continue;
        counts.set(kp.serverUserId, n + 1);
        add.push(kp);
      }
      return add.length ? addMlsMembers(s, add.map((k) => k.keyPackage)) : null;
    });
    if (verified.some((k) => k.serverUserId === peer)) await markSeen(peer);
  }

  /** The certificate names the device the server said, under the person key pinned for that member. */
  async function vouchedFor(
    conversationId: string,
    kp: MlsClaimedKeyPackage,
    peer: string,
  ): Promise<"ok" | "unreadable" | "refused"> {
    if (kp.serverUserId !== self && kp.serverUserId !== peer) return "refused";
    let certificate: DeviceCertificate;
    try {
      ({ certificate } = await readMlsKeyPackage(kp.keyPackage, scope));
    } catch {
      return "unreadable";
    }
    if (certificate.deviceId !== kp.deviceId) return "refused";
    return (await pins.personOf(conversationId, certificate.personPublicKey)) === kp.serverUserId ? "ok" : "refused";
  }

  // ── Opening and joining ─────────────────────────────────────────────

  /** "open" when this device has the group, "exists" when somebody else made it first. */
  async function openGroup(conversationId: string): Promise<"open" | "exists"> {
    if (await store.loadGroup(conversationId)) return "open";
    const d = await ownDevice();
    const state = await createMlsGroup(d, trustFor(conversationId));
    const rec: MlsGroupRecord = {
      conversationId,
      groupId: groupIdOf(state),
      state: encodeMlsGroupState(state),
      cursor: 0,
      joinedEpoch: 0,
    };
    // Saved before the server hears of it, so a crash can't leave a group nobody holds.
    await store.saveGroup(rec);
    const r = await transport.createGroup({ conversationId, groupId: rec.groupId });
    if (r.ok) return "open";
    await store.deleteGroup(conversationId);
    if (r.error === "group_exists") return "exists";
    throw refused("Creating the group", r);
  }

  function waitForWelcome(conversationId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const list = welcomeWaiters.get(conversationId) ?? [];
        welcomeWaiters.set(conversationId, list.filter((w) => w !== done));
        reject(new MlsDriverError("waiting_for_welcome", "The group exists and this device hasn't been added yet."));
      }, WELCOME_WAIT_MS);
      welcomeWaiters.set(conversationId, [...(welcomeWaiters.get(conversationId) ?? []), done]);
    });
  }

  async function ensureOpen(conversationId: string): Promise<void> {
    if ((await run(conversationId, () => openGroup(conversationId))) === "open") return;
    for (const w of await syncAndTopUp()) await handleWelcome(w);
    if (!(await store.loadGroup(conversationId))) await waitForWelcome(conversationId);
  }

  /** "joined", "not_ours" (ack it and forget it), or "retry" (keep it for next time). */
  async function joinFrom(w: MlsWelcomeDelivery): Promise<{ result: "joined" | "not_ours" | "retry"; usedLastResort?: boolean }> {
    const conversationId = w.conversationId;
    if (!conversationId) return { result: "not_ours" };
    let kp: MlsKeyPackageRecord | null = null;
    try {
      for (const ref of mlsWelcomeRefs(w.data)) if ((kp = await store.getKeyPackage(ref))) break;
    } catch {
      return { result: "not_ours" };
    }
    if (!kp) return { result: "not_ours" };

    const existing = await store.loadGroup(conversationId);
    if (existing && existing.groupId === w.groupId) return { result: "not_ours" };

    let state: MlsGroupState;
    try {
      state = await joinMlsGroup(w.data, kp.keyPackage, kp.privatePackage, trustFor(conversationId));
    } catch {
      return { result: "retry" };
    }
    const people = new Set(await peopleIn(conversationId, state));
    if (groupIdOf(state) !== w.groupId || people.has(null) || people.size > 2 || !people.has(self)) {
      return { result: "not_ours" };
    }

    const open: Open = {
      rec: { conversationId, groupId: w.groupId, state: new Uint8Array(), cursor: 0, joinedEpoch: epochOf(state) },
      state,
    };
    await save(open);
    if (!kp.lastResort) await store.deleteKeyPackage(kp.ref);
    await notePeople(conversationId, state);
    await catchUp(open);
    return { result: "joined", usedLastResort: kp.lastResort };
  }

  async function handleWelcome(w: MlsWelcomeDelivery): Promise<void> {
    const d = await ownDevice();
    if (w.deviceId !== d.deviceId || !w.conversationId) return;
    const conversationId = w.conversationId;
    const { result, usedLastResort } = await run(conversationId, () => joinFrom(w));
    if (result === "retry") return;
    await transport.ackWelcomes({ deviceId: d.deviceId, welcomeIds: [w.welcomeId] });
    if (result !== "joined") return;
    reconciled.delete(conversationId);
    events.onJoined?.({ conversationId, groupId: w.groupId });
    for (const done of welcomeWaiters.get(conversationId) ?? []) done();
    welcomeWaiters.delete(conversationId);
    // One package was used up, and a used last-resort one gets replaced.
    await syncAndTopUp(usedLastResort);
  }

  // ── What the app calls ──────────────────────────────────────────────

  async function send(conversationId: string, peer: string, plaintext: Uint8Array): Promise<{ seq: number }> {
    if (!registered) throw new MlsDriverError("no_device", "This device isn't registered for MLS here. Call start() first.");
    await ensureOpen(conversationId);
    return run(conversationId, async () => {
      const d = await ownDevice();
      const open = await load(conversationId);
      if (!open || !(await catchUp(open))) throw new MlsDriverError("not_in_group", "This device isn't in that group.");
      if (!reconciled.has(conversationId)) {
        await reconcile(open, peer, true);
        reconciled.add(conversationId);
      }
      const people = await peopleIn(conversationId, open.state);
      if (people.some((p) => p !== self && p !== peer)) {
        throw new MlsDriverError("unexpected_member", "Somebody other than the two of you is in this group.");
      }

      const out = await encryptMlsMessage(open.state, plaintext);
      open.state = out.state;
      // The generation is used up whether or not the send arrives, so the state is saved first.
      await save(open);
      const r = await transport.send({ conversationId, deviceId: d.deviceId, message: out.message });
      if (!r.ok) throw refused("Sending", r);
      return { seq: r.seq };
    });
  }

  async function modeFor(conversationId: string, peer: string): Promise<DmSealingMode> {
    const wasSeen = seen.has(peer) || (await pins.seenOnMls(peer));
    if (wasSeen) seen.add(peer);
    if (!capability) {
      return wasSeen ? { kind: "refused", reason: "server_dropped_mls" } : { kind: "sealed-v1", reason: "server_without_mls" };
    }
    let peerOnMls = !!(await store.loadGroup(conversationId));
    if (!peerOnMls) {
      const r = await transport.listDevices({ conversationId });
      if (!r.ok) throw refused("Listing devices", r);
      peerOnMls = r.devices.some((x: MlsDeviceRef) => x.serverUserId === peer);
    }
    if (!peerOnMls) {
      return wasSeen ? { kind: "refused", reason: "peer_left_mls" } : { kind: "sealed-v1", reason: "peer_without_mls" };
    }
    await markSeen(peer);
    return registered ? { kind: "mls" } : { kind: "refused", reason: "no_own_device" };
  }

  async function handleMessage(entry: MlsLogEntry): Promise<void> {
    await run(entry.conversationId, async () => {
      const open = await load(entry.conversationId);
      if (!open || entry.seq <= open.rec.cursor) return;
      if (entry.seq === open.rec.cursor + 1 && entry.groupId === open.rec.groupId) await applyEntry(open, entry);
      else await catchUp(open);
    });
  }

  /** Adds wait for the next send; a device that's gone is removed straight away. */
  async function handleDevicesChanged(push: { serverUserId: string }): Promise<void> {
    reconciled.clear();
    for (const rec of await store.listGroups()) {
      await run(rec.conversationId, async () => {
        const open = await load(rec.conversationId);
        if (!open) return;
        const people = await peopleIn(rec.conversationId, open.state);
        const peer = people.find((p): p is string => !!p && p !== self);
        if (!peer || (push.serverUserId !== self && push.serverUserId !== peer)) return;
        if (await catchUp(open)) await reconcile(open, peer, false);
      });
    }
  }

  return {
    async start() {
      await ownDevice();
      if (!capability) return;
      for (const w of await syncAndTopUp()) await handleWelcome(w);
      reconciled.clear();
      for (const rec of await store.listGroups()) {
        await run(rec.conversationId, async () => {
          const open = await load(rec.conversationId);
          if (open) await catchUp(open);
        });
      }
    },
    modeFor,
    send,
    handleMessage,
    handleWelcome,
    handleDevicesChanged,
    async ownDevices() {
      const r = await transport.listDevices({});
      if (!r.ok) throw refused("Listing devices", r);
      return r.devices;
    },
    async removeOwnDevice(deviceId: string) {
      const r = await transport.removeDevice({ deviceId });
      if (!r.ok) throw refused("Removing the device", r);
      await handleDevicesChanged({ serverUserId: self });
    },
  };
}
