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
  readDeviceCertificate,
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
  MlsOwnDevice,
  MlsRefusal,
  MlsReply,
  MlsTransport,
  MlsWelcomeDelivery,
} from "./interfaces.js";
import type { MlsAddOwnDeviceOptions, MlsGroupPosition, MlsOwnDeviceAdd } from "./interfaces.js";

/** Five devices per person per server (design, section 1). The server holds the same line. */
const MLS_MAX_DEVICES_PER_PERSON = 5;
const COMMIT_ATTEMPTS = 5;
/** socket.io closes the connection on a packet with more than 10 binary parts (GRYT-1522). */
const MAX_BINARY_PARTS = 10;
const LOG_PAGE = MAX_BINARY_PARTS;
const PUBLISH_BATCH = MAX_BINARY_PARTS - 1;
/** The server's cap on files in one message. */
const MAX_ATTACHMENT_IDS = 10;
const WELCOME_WAIT_MS = 10_000;
/** The same cap as a message that isn't MLS: after this a send fails and the text goes back. */
const SEND_GIVE_UP_MS = 5 * 60_000;
/** A send with no answer goes again after this, or sooner if the connection comes back. */
const RESEND_AFTER_MS = 2_000;
/** The server keeps Welcomes 30 days; a last-resort package is replaced with a week to go. */
const WELCOME_KEEP_S = 30 * 86_400;
const RENEW_BEFORE_S = 7 * 86_400;

export type MlsDriverErrorCode =
  | "refused"
  | "not_own_device"
  | "no_device"
  | "waiting_for_welcome"
  | "not_in_group"
  | "unexpected_member"
  | "peer_unverified"
  | "too_many_attachments"
  | "commit_retries"
  | "device_removed"
  | "offline"
  | "stopped";

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

/** A refusal that says nothing about the request, only that the server couldn't be reached. */
function unreachable(r: MlsRefusal | unknown): "offline" | "timeout" | null {
  const error = r instanceof MlsDriverError ? r.refusal?.error : (r as MlsRefusal | undefined)?.error;
  return error === "offline" || error === "timeout" ? error : null;
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
  const { store, pins, events, serverUserId: self, capability } = options;

  /* Once the server says `device_removed`, nothing goes to it again from this driver:
     no sync, and above all no publish that could register this device back. */
  let removed = false;
  const removedError = (r?: MlsRefusal) =>
    new MlsDriverError("device_removed", "This device was removed from encrypted messages on this server.", r);
  function stopOnRemoval<Req, Res extends object>(call: (req: Req) => Promise<MlsReply<Res>>) {
    return async (req: Req): Promise<MlsReply<Res>> => {
      if (removed) throw removedError();
      const r = await call(req);
      if (!r.ok && r.error === "device_removed") {
        if (!removed) {
          removed = true;
          events.onDeviceRemoved?.();
        }
        throw removedError(r);
      }
      return r;
    };
  }
  const raw = options.transport;
  const transport: MlsTransport = {
    publishKeyPackages: stopOnRemoval((req) => raw.publishKeyPackages(req)),
    claimKeyPackages: stopOnRemoval((req) => raw.claimKeyPackages(req)),
    listDevices: stopOnRemoval((req) => raw.listDevices(req)),
    removeDevice: stopOnRemoval((req) => raw.removeDevice(req)),
    createGroup: stopOnRemoval((req) => raw.createGroup(req)),
    commit: stopOnRemoval((req) => raw.commit(req)),
    send: stopOnRemoval((req) => raw.send(req)),
    fetchLog: stopOnRemoval((req) => raw.fetchLog(req)),
    sync: stopOnRemoval((req) => raw.sync(req)),
    ackWelcomes: stopOnRemoval((req) => raw.ackWelcomes(req)),
  };
  const scope = asIdentityScope(options.scope);
  const trusts = new Map<string, MlsTrust>();
  /** What the engine asks about every leaf: is it somebody in this conversation, by pin. */
  function trustFor(conversationId: string): MlsTrust {
    let t = trusts.get(conversationId);
    if (!t) {
      const trustPersonKey = pins.trustFor?.(conversationId) ?? (async (c) => (await pins.personOf(conversationId, c.personPublicKey)) !== null);
      t = { scope, trustPersonKey };
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

  /** A send's ciphertext once it has been on the wire, and its seq once the log shows it. */
  interface Flight {
    conversationId: string;
    message: Uint8Array | null;
    seq: number | null;
  }
  const flights = new Set<Flight>();
  let waitingForServer = false;
  let stopped = false;
  const paused = new Set<{ resume(): void; fail(e: Error): void }>();
  const giveUpMs = options.sendGiveUpMs ?? SEND_GIVE_UP_MS;

  function setWaiting(next: boolean): void {
    if (waitingForServer === next) return;
    waitingForServer = next;
    events.onWaiting?.(next);
  }

  /** Until `start()` has caught up again, or `ms`. Fails at the deadline or on `stop()`. */
  function pause(deadline: number, ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const left = deadline - Date.now();
      if (stopped || left <= 0) return reject(stopped ? stoppedError() : gaveUpError());
      const done = (then: () => void) => {
        clearTimeout(timer);
        paused.delete(entry);
        then();
      };
      const entry = { resume: () => done(resolve), fail: (e: Error) => done(() => reject(e)) };
      const timer = setTimeout(() => (Date.now() >= deadline ? entry.fail(gaveUpError()) : entry.resume()), Math.min(left, ms));
      paused.add(entry);
    });
  }
  const gaveUpError = () => new MlsDriverError("offline", "The server didn't answer in time, so the message wasn't sent.");
  const stoppedError = () => new MlsDriverError("stopped", "This connection has closed.");

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

  /** Where each device went into each group, as this driver saw it happen. Memory only. */
  const joins = new Map<string, Map<string, { seq: number; epoch: number; byThisDevice: boolean }>>();

  function noteJoins(conversationId: string, before: MlsGroupState, after: MlsGroupState, seq: number, byThisDevice: boolean) {
    if (before === after) return;
    const had = new Set(mlsGroupMembers(before, scope).map((m) => m.certificate.deviceId));
    const here = joins.get(conversationId) ?? new Map();
    for (const { certificate } of mlsGroupMembers(after, scope)) {
      if (!had.has(certificate.deviceId)) here.set(certificate.deviceId, { seq, epoch: epochOf(after), byThisDevice });
    }
    if (here.size) joins.set(conversationId, here);
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
    // One with no expiresAt predates lifetimes, and readers now refuse it.
    const lastRunningOut = !!newestLast && (newestLast.expiresAt === undefined || newestLast.expiresAt - now < RENEW_BEFORE_S);

    const wanted = !registered || counts.unclaimed < counts.target / 2 ? counts.target - counts.unclaimed : 0;
    const needLastResort = !counts.lastResort || forceLastResort || lastRunningOut;
    if (wanted <= 0 && !needLastResort && registered) return;

    const make = async (lastResort: boolean): Promise<MlsKeyPackageRecord> => {
      const kp = await generateMlsKeyPackage(d);
      return { ...kp, lastResort, createdAt: Date.now() };
    };
    const fresh: MlsKeyPackageRecord[] = [];
    for (let i = 0; i < wanted; i++) fresh.push(await make(false));
    const last = needLastResort ? await make(true) : undefined;
    // The private halves are stored first, so a Welcome can never name one this device lost.
    await store.putKeyPackages(last ? [...fresh, last] : fresh);

    // Nine at a time, and the last-resort one rides with the last batch.
    const all = fresh.map((k) => k.keyPackage);
    for (let i = 0; i === 0 || i < all.length; i += PUBLISH_BATCH) {
      const keyPackages = all.slice(i, i + PUBLISH_BATCH);
      const final = i + PUBLISH_BATCH >= all.length;
      const r = await transport.publishKeyPackages({
        deviceId: d.deviceId,
        keyPackages,
        lastResort: final ? last?.keyPackage : undefined,
      });
      if (!r.ok) throw refused("Publishing KeyPackages", r);
      registered = true;
    }
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
      const before = open.state;
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
      noteJoins(open.rec.conversationId, before, open.state, e.seq, !!pending && sameBytes(pending.commit, e.data));
      await notePeople(open.rec.conversationId, open.state);
    } else if (e.kind === "proposal") {
      if (e.epoch === current) {
        try {
          open.state = (await processMlsMessage(open.state, e.data)).state;
        } catch {
          events.onUndecryptable?.({ conversationId: open.rec.conversationId, seq: e.seq, reason: "bad_proposal" });
        }
      }
    } else if (e.senderServerUserId === self && e.senderDeviceId === d.deviceId) {
      // A send whose answer never came: the log says it landed, so it isn't sent again.
      for (const f of flights) {
        if (f.conversationId === open.rec.conversationId && f.seq === null && f.message && sameBytes(f.message, e.data)) f.seq = e.seq;
      }
    } else if (e.epoch >= open.rec.joinedEpoch) {
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
          epoch: e.epoch,
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
        noteJoins(open.rec.conversationId, open.state, c.state, r.seq, true);
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
    let asking: MlsDeviceRef[] = wanted;
    let addedPeer = false;
    // A package out of date, by the reader or by addMlsMembers, gets one fresh claim for that device.
    for (let round = 0; round < 2 && asking.length > 0; round++) {
      const claim = await transport.claimKeyPackages({ conversationId, deviceId: d.deviceId, devices: asking });
      if (!claim.ok) throw refused("Claiming KeyPackages", claim);
      asking = [];
      const verified: MlsClaimedKeyPackage[] = [];
      for (const kp of claim.keyPackages) {
        const verdict = await vouchedFor(conversationId, kp, peer);
        if (verdict === "ok") verified.push(kp);
        else if (verdict === "unreadable") asking.push({ serverUserId: kp.serverUserId, deviceId: kp.deviceId });
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
        if (add.length === 0) return null;
        try {
          const c = await addMlsMembers(s, add.map((k) => k.keyPackage));
          addedPeer ||= add.some((k) => k.serverUserId === peer);
          return c;
        } catch {
          asking.push(...add.map((k) => ({ serverUserId: k.serverUserId, deviceId: k.deviceId })));
          return null;
        }
      });
    }
    if (addedPeer) await markSeen(peer);
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
    await takeWaitingWelcomes();
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

  /** "retry" when it's kept for later, else whether it used a last-resort package. */
  async function takeWelcome(w: MlsWelcomeDelivery): Promise<"retry" | "done" | "used_last_resort"> {
    const d = await ownDevice();
    if (w.deviceId !== d.deviceId || !w.conversationId) return "retry";
    const conversationId = w.conversationId;
    const { result, usedLastResort } = await run(conversationId, () => joinFrom(w));
    if (result === "retry") return "retry";
    await transport.ackWelcomes({ deviceId: d.deviceId, welcomeIds: [w.welcomeId] });
    if (result !== "joined") return "done";
    reconciled.delete(conversationId);
    events.onJoined?.({ conversationId, groupId: w.groupId });
    for (const done of welcomeWaiters.get(conversationId) ?? []) done();
    welcomeWaiters.delete(conversationId);
    return usedLastResort ? "used_last_resort" : "done";
  }

  async function handleWelcome(w: MlsWelcomeDelivery): Promise<void> {
    // One package was used up, and a used last-resort one gets replaced.
    const outcome = await takeWelcome(w);
    if (outcome !== "retry") await syncAndTopUp(outcome === "used_last_resort");
  }

  /* Sync until nothing waiting can be acted on: a server may hand out ten Welcomes a time,
     and each one taken is acked, so the next sync brings the rest (GRYT-1528). */
  async function takeWaitingWelcomes(): Promise<void> {
    let lastResortUsed = false;
    for (let round = 0; round < 20; round++) {
      const welcomes = await syncAndTopUp(lastResortUsed);
      lastResortUsed = false;
      let taken = 0;
      for (const w of welcomes) {
        const outcome = await takeWelcome(w);
        if (outcome !== "retry") taken += 1;
        if (outcome === "used_last_resort") lastResortUsed = true;
      }
      if (taken === 0) return;
    }
  }

  // ── What the app calls ──────────────────────────────────────────────

  async function send(
    conversationId: string,
    peer: string,
    plaintext: Uint8Array,
    options: { attachmentIds?: readonly string[] } = {},
  ): Promise<{ seq: number }> {
    const attachmentIds: string[] | undefined = options.attachmentIds?.length ? [...options.attachmentIds] : undefined;
    if (attachmentIds && attachmentIds.length > MAX_ATTACHMENT_IDS) {
      throw new MlsDriverError("too_many_attachments", `At most ${MAX_ATTACHMENT_IDS} files go with one message.`);
    }
    if (!registered) throw new MlsDriverError("no_device", "This device isn't registered for MLS here. Call start() first.");
    if (stopped) throw stoppedError();
    const deadline = Date.now() + giveUpMs;
    const flight: Flight = { conversationId, message: null, seq: null };
    flights.add(flight);
    try {
      for (;;) {
        try {
          return await sendOnce(flight, peer, plaintext, attachmentIds);
        } catch (e) {
          const why = unreachable(e);
          if (!why || stopped) throw e;
          // Offline waits for the next start(). A timeout goes again soon, as the same bytes.
          if (why === "offline") setWaiting(true);
          await pause(deadline, why === "offline" ? Infinity : RESEND_AFTER_MS);
        }
      }
    } finally {
      flights.delete(flight);
    }
  }

  /* Encrypted at most once, and only once the group is caught up. Every later attempt sends
     the same bytes, which the server takes as a repeat rather than a second message. */
  async function sendOnce(flight: Flight, peer: string, plaintext: Uint8Array, attachmentIds?: string[]): Promise<{ seq: number }> {
    const { conversationId } = flight;
    if (!flight.message) await ensureOpen(conversationId);
    return run(conversationId, async () => {
      const d = await ownDevice();
      const open = await load(conversationId);
      if (!open || !(await catchUp(open))) throw new MlsDriverError("not_in_group", "This device isn't in that group.");
      if (flight.seq !== null) return { seq: flight.seq };
      if (flight.message) {
        const r = await transport.send({ conversationId, deviceId: d.deviceId, message: flight.message, attachmentIds });
        if (!r.ok) throw refused("Sending", r);
        return { seq: r.seq };
      }
      if (!reconciled.has(conversationId)) await reconcile(open, peer, true);
      const people = await peopleIn(conversationId, open.state);
      if (people.some((p) => p !== self && p !== peer)) {
        throw new MlsDriverError("unexpected_member", "Somebody other than the two of you is in this group.");
      }
      if (!people.includes(peer)) {
        throw new MlsDriverError("peer_unverified", "None of their devices could be added. Is their person key pinned?");
      }
      reconciled.add(conversationId);

      const out = await encryptMlsMessage(open.state, plaintext);
      open.state = out.state;
      // The generation is used up whether or not the send arrives, so the state is saved first.
      await save(open);
      flight.message = out.message;
      const r = await transport.send({ conversationId, deviceId: d.deviceId, message: out.message, attachmentIds });
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
    // One of yours changed, and it may be this one: a sync is how the server says so.
    if (push.serverUserId === self && registered) await transport.sync({ deviceId: (await ownDevice()).deviceId });
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

  /** Names from certificates under your own person key: this device's, then your leaves in each group. */
  async function ownDeviceNames(d: MlsDeviceRecord, wanted: Set<string>): Promise<Map<string, string>> {
    const mine = readDeviceCertificate(d.certificate, scope);
    const names = new Map([[mine.deviceId, mine.deviceName]]);
    const unnamed = () => [...wanted].some((id) => !names.has(id));
    for (const rec of await store.listGroups()) {
      if (!unnamed()) break;
      let members: ReturnType<typeof mlsGroupMembers>;
      try {
        members = mlsGroupMembers(decodeMlsGroupState(rec.state, trustFor(rec.conversationId)), scope);
      } catch {
        continue;
      }
      for (const { certificate: c } of members) {
        if (wanted.has(c.deviceId) && !names.has(c.deviceId) && sameBytes(c.personPublicKey, mine.personPublicKey)) {
          names.set(c.deviceId, c.deviceName);
        }
      }
    }
    return names;
  }

  async function ownDevices(): Promise<MlsOwnDevice[]> {
    const r = await transport.listDevices({});
    if (!r.ok) throw refused("Listing devices", r);
    const d = await ownDevice();
    const listed = r.devices.filter((x) => x.serverUserId === self);
    const names = await ownDeviceNames(d, new Set(listed.map((x) => x.deviceId)));
    return listed.map((x) => ({
      serverUserId: x.serverUserId,
      deviceId: x.deviceId,
      name: names.get(x.deviceId) ?? null,
      addedAt: x.createdAt ?? null,
      lastSeenAt: x.lastSeenAt ?? null,
      thisDevice: x.deviceId === d.deviceId,
    }));
  }

  // ── Pairing ─────────────────────────────────────────────────────────

  async function groupPositions(): Promise<MlsGroupPosition[]> {
    const out: MlsGroupPosition[] = [];
    for (const rec of await store.listGroups()) {
      const pos = await run(rec.conversationId, async () => {
        const open = await load(rec.conversationId);
        return open && { conversationId: open.rec.conversationId, groupId: open.rec.groupId, seq: open.rec.cursor, epoch: epochOf(open.state) };
      });
      if (pos) out.push(pos);
    }
    return out;
  }

  /** A claimed package for `deviceId`, checked to be yours under your own person key. Null when the server has none. */
  async function claimOwn(conversationId: string, deviceId: string, ownPersonKey: Uint8Array): Promise<Uint8Array | null> {
    const d = await ownDevice();
    // One more claim when the first package won't read, as with a peer's.
    for (let round = 0; round < 2; round++) {
      const claim = await transport.claimKeyPackages({ conversationId, deviceId: d.deviceId, devices: [{ serverUserId: self, deviceId }] });
      if (!claim.ok) throw refused("Claiming KeyPackages", claim);
      const kp = claim.keyPackages.find((k) => k.serverUserId === self && k.deviceId === deviceId);
      if (!kp) return null;
      let certificate: DeviceCertificate;
      try {
        ({ certificate } = await readMlsKeyPackage(kp.keyPackage, scope));
      } catch {
        continue;
      }
      if (certificate.deviceId !== deviceId || !sameBytes(certificate.personPublicKey, ownPersonKey)) {
        throw new MlsDriverError("not_own_device", "That device's certificate isn't signed by your person key.");
      }
      return kp.keyPackage;
    }
    return null;
  }

  async function addOwnDeviceTo(conversationId: string, deviceId: string, ownPersonKey: Uint8Array): Promise<MlsOwnDeviceAdd> {
    const open = await load(conversationId);
    const result = (outcome: MlsOwnDeviceAdd["outcome"], error?: string): MlsOwnDeviceAdd => {
      const j = joins.get(conversationId)?.get(deviceId);
      const add = outcome === "failed" || !j ? null : { seq: j.seq, epoch: j.epoch };
      return { conversationId, groupId: open?.rec.groupId ?? "", outcome, add, ...(error ? { error } : {}) };
    };
    if (!open || !(await catchUp(open))) return result("failed", "not_in_group");
    const inTree = (s: MlsGroupState) => mlsGroupMembers(s, scope).some((m) => m.certificate.deviceId === deviceId);
    const settled = () => result(joins.get(conversationId)?.get(deviceId)?.byThisDevice ? "added" : "added_by_other");
    if (inTree(open.state)) return settled();

    let full = false;
    for (let round = 0; round < 2 && !inTree(open.state); round++) {
      const keyPackage = await claimOwn(conversationId, deviceId, ownPersonKey);
      if (!keyPackage) return result("failed", "no_key_package");
      let stale = false;
      await commitWithRetry(open, async (s) => {
        if (inTree(s)) return null;
        const mine = mlsGroupMembers(s, scope).filter((m) => sameBytes(m.certificate.personPublicKey, ownPersonKey));
        if ((full = mine.length >= MLS_MAX_DEVICES_PER_PERSON)) return null;
        try {
          return await addMlsMembers(s, [keyPackage]);
        } catch {
          stale = true;
          return null;
        }
      });
      if (!stale) break;
    }
    if (inTree(open.state)) return settled();
    return result("failed", full ? "too_many_devices" : "no_key_package");
  }

  async function addOwnDevice(deviceId: string, options: MlsAddOwnDeviceOptions = {}): Promise<MlsOwnDeviceAdd[]> {
    const d = await ownDevice();
    const listed = await transport.listDevices({});
    if (!listed.ok) throw refused("Listing devices", listed);
    if (deviceId === d.deviceId || !listed.devices.some((x) => x.serverUserId === self && x.deviceId === deviceId)) {
      throw new MlsDriverError("not_own_device", "The server doesn't list that device as one of yours.");
    }
    const ownPersonKey = readDeviceCertificate(d.certificate, scope).personPublicKey;

    const ids = (await store.listGroups()).map((r) => r.conversationId);
    const first = (options.order ?? []).filter((id) => ids.includes(id));
    const ordered = [...new Set([...first, ...ids])];
    const results: MlsOwnDeviceAdd[] = [];
    for (const conversationId of ordered) {
      let result: MlsOwnDeviceAdd;
      try {
        result = await run(conversationId, () => addOwnDeviceTo(conversationId, deviceId, ownPersonKey));
      } catch (e) {
        if (e instanceof MlsDriverError && e.code === "not_own_device") throw e;
        const groupId = (await store.loadGroup(conversationId))?.groupId ?? "";
        result = { conversationId, groupId, outcome: "failed", add: null, error: e instanceof MlsDriverError ? e.code : "error" };
      }
      results.push(result);
      options.onProgress?.({ done: results.length, total: ordered.length, result });
    }
    return results;
  }

  return {
    async start() {
      await ownDevice();
      if (!capability) return;
      await takeWaitingWelcomes();
      reconciled.clear();
      for (const rec of await store.listGroups()) {
        await run(rec.conversationId, async () => {
          const open = await load(rec.conversationId);
          if (open) await catchUp(open);
        });
      }
      // Caught up, so the sends that waited go now, on top of that.
      setWaiting(false);
      for (const p of [...paused]) p.resume();
    },
    stop() {
      stopped = true;
      for (const p of [...paused]) p.fail(stoppedError());
    },
    modeFor,
    send,
    handleMessage,
    handleWelcome,
    handleDevicesChanged,
    ownDevices,
    async removeOwnDevice(deviceId: string) {
      const r = await transport.removeDevice({ deviceId });
      if (!r.ok) throw refused("Removing the device", r);
      await handleDevicesChanged({ serverUserId: self });
    },
    groupPositions,
    addOwnDevice,
  };
}
