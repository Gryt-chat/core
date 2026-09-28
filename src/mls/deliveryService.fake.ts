/* An in-memory stand-in for the delivery service in Gryt-chat/server#241, for tests only.
   Same answers and pushes; no auth, blocks, rate limits or member checks on adds. */

import { base64UrlDecode, inspectMlsMessage, mlsWelcomeRefs, readMlsKeyPackage, type IdentityScope } from "@gryt/crypto";

import type {
  MlsDeviceRef,
  MlsDmDriver,
  MlsGroupRecord,
  MlsKeyPackageRecord,
  MlsDeviceRecord,
  MlsLogEntry,
  MlsReply,
  MlsStateStore,
  MlsTransport,
  MlsWelcomeDelivery,
} from "./interfaces.ts";

const MAX_DEVICES = 5;
const MAX_KEY_PACKAGES = 20;
const MAX_LOG_PAGE = 200;
const DUPLICATE_WINDOW = 100;

const fail = (error: string, message: string, extra: Record<string, unknown> = {}) =>
  ({ ok: false as const, error, message, ...extra });

const hexOf = (b64: string) => Array.from(base64UrlDecode(b64), (b) => b.toString(16).padStart(2, "0")).join("");

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

interface KeyPackageRow {
  ref: string;
  serverUserId: string;
  deviceId: string;
  data: Uint8Array;
  lastResort: boolean;
  claimed: boolean;
}

interface GroupRow {
  conversationId: string;
  groupId: string;
  epoch: number;
  headSeq: number;
  log: MlsLogEntry[];
}

interface Socket {
  serverUserId: string;
  driver: MlsDmDriver | null;
  online: boolean;
}

export class FakeDeliveryService {
  scope: IdentityScope;
  conversations = new Map<string, string[]>();
  devices = new Map<string, string[]>();
  keyPackages: KeyPackageRow[] = [];
  groups = new Map<string, GroupRow>();
  welcomes: (MlsWelcomeDelivery & { serverUserId: string })[] = [];
  sockets: Socket[] = [];
  stats = { commits: 0, staleEpoch: 0, groupExists: 0, claims: 0, publishes: 0, mostBinaryParts: 0 };
  /** A cap on Welcomes per sync, for a server that pages them (GRYT-1528). server#241 has none. */
  syncWelcomeLimit = Infinity;
  /** What each `mls:send` said it carried, by seq. */
  attachmentIds = new Map<number, string[] | undefined>();
  private inFlight = new Set<Promise<unknown>>();
  private held: { count: number; waiting: (() => void)[] } | null = null;
  private nextWelcome = 1;

  constructor(scope: IdentityScope) {
    this.scope = scope;
  }

  dm(a: string, b: string): string {
    const id = `dm:${[a, b].sort().join(":")}`;
    this.conversations.set(id, [a, b]);
    return id;
  }

  /** Commits wait until `count` of them are in, then go through in the order they came. */
  holdCommits(count: number): void {
    this.held = { count, waiting: [] };
  }

  /** Waits until every push has been handled, including what those handlers set off. */
  async settle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  connect(serverUserId: string): { transport: MlsTransport; socket: Socket } {
    const socket: Socket = { serverUserId, driver: null, online: true };
    this.sockets.push(socket);
    return { transport: this.transportFor(socket), socket };
  }

  dropLogThrough(conversationId: string, seq: number): void {
    const g = this.groups.get(conversationId);
    if (g) g.log = g.log.filter((e) => e.seq > seq);
  }

  private push(to: string[], deliver: (d: MlsDmDriver) => Promise<void>): void {
    for (const s of this.sockets) {
      if (!s.online || !s.driver || !to.includes(s.serverUserId)) continue;
      const driver = s.driver;
      const p = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => deliver(driver));
      const tracked = p.catch(() => undefined).finally(() => this.inFlight.delete(tracked));
      this.inFlight.add(tracked);
    }
  }

  private peopleSharing(serverUserId: string): string[] {
    const out = new Set([serverUserId]);
    for (const members of this.conversations.values()) if (members.includes(serverUserId)) members.forEach((m) => out.add(m));
    return [...out];
  }

  private devicesOf(ids: string[]): MlsDeviceRef[] {
    return ids.flatMap((serverUserId) => (this.devices.get(serverUserId) ?? []).map((deviceId) => ({ serverUserId, deviceId })));
  }

  private isDevice(serverUserId: string, deviceId: string): boolean {
    return (this.devices.get(serverUserId) ?? []).includes(deviceId);
  }

  private groupView(g: GroupRow) {
    return { conversationId: g.conversationId, groupId: g.groupId, epoch: g.epoch, headSeq: g.headSeq };
  }

  private transportFor(socket: Socket): MlsTransport {
    const me = socket.serverUserId;
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const member = (conversationId: string) => this.conversations.get(conversationId)?.includes(me) ?? false;

    const methods: MlsTransport = {
      publishKeyPackages: async ({ deviceId, keyPackages, lastResort }) => {
        await tick();
        this.stats.publishes += 1;
        const isNew = !this.isDevice(me, deviceId);
        if (isNew && (this.devices.get(me) ?? []).length >= MAX_DEVICES) {
          return fail("too_many_devices", "You have five devices using encrypted messages here.");
        }
        const raw = [...keyPackages.map((b) => ({ b, lastResort: false }))];
        if (lastResort) raw.push({ b: lastResort, lastResort: true });
        const rows: KeyPackageRow[] = [];
        for (const { b, lastResort: lr } of raw) {
          const { ref } = await readMlsKeyPackage(b, this.scope);
          rows.push({ ref, serverUserId: me, deviceId, data: b.slice(), lastResort: lr, claimed: false });
        }
        if (isNew) this.devices.set(me, [...(this.devices.get(me) ?? []), deviceId]);
        let stored = 0;
        for (const row of rows) {
          const unclaimed = this.keyPackages.filter((k) => k.deviceId === deviceId && !k.lastResort && !k.claimed).length;
          if (!row.lastResort && unclaimed >= MAX_KEY_PACKAGES) continue;
          if (row.lastResort) {
            for (const k of this.keyPackages) if (k.deviceId === deviceId && k.lastResort) k.claimed = true;
          }
          this.keyPackages.push(row);
          stored += 1;
        }
        if (isNew) this.push(this.peopleSharing(me), (d) => d.handleDevicesChanged({ serverUserId: me }));
        return { ok: true, stored, ...this.counts(me, deviceId) };
      },

      claimKeyPackages: async ({ conversationId, deviceId, devices }) => {
        await tick();
        if (!member(conversationId)) return fail("not_found", "No such conversation.");
        this.stats.claims += 1;
        let targets = this.devicesOf(this.conversations.get(conversationId)!).filter(
          (d) => !(d.serverUserId === me && d.deviceId === deviceId),
        );
        if (devices) targets = targets.filter((t) => devices.some((d) => d.serverUserId === t.serverUserId && d.deviceId === t.deviceId));
        const keyPackages = [];
        const missing = [];
        for (const t of targets) {
          const mine = this.keyPackages.filter((k) => k.serverUserId === t.serverUserId && k.deviceId === t.deviceId && !k.claimed);
          const fresh = mine.find((k) => !k.lastResort);
          const kp = fresh ?? mine.find((k) => k.lastResort);
          if (!kp) {
            missing.push(t);
            continue;
          }
          if (fresh) fresh.claimed = true;
          keyPackages.push({ ...t, keyPackage: kp.data.slice(), lastResort: kp.lastResort });
        }
        return { ok: true, keyPackages, missing };
      },

      listDevices: async ({ conversationId }) => {
        await tick();
        if (conversationId === undefined) return { ok: true, devices: this.devicesOf([me]) };
        if (!member(conversationId)) return fail("not_found", "No such conversation.");
        return { ok: true, devices: this.devicesOf(this.conversations.get(conversationId)!) };
      },

      removeDevice: async ({ deviceId }) => {
        await tick();
        if (!this.isDevice(me, deviceId)) return fail("unknown_device", "Publish KeyPackages from this device first.");
        this.devices.set(me, (this.devices.get(me) ?? []).filter((d) => d !== deviceId));
        this.keyPackages = this.keyPackages.filter((k) => !(k.serverUserId === me && k.deviceId === deviceId));
        this.welcomes = this.welcomes.filter((w) => !(w.serverUserId === me && w.deviceId === deviceId));
        this.push(this.peopleSharing(me), (d) => d.handleDevicesChanged({ serverUserId: me }));
        return { ok: true };
      },

      createGroup: async ({ conversationId, groupId }) => {
        await tick();
        if (!member(conversationId)) return fail("not_found", "No such conversation.");
        const existing = this.groups.get(conversationId);
        if (existing) {
          this.stats.groupExists += 1;
          return fail("group_exists", "This conversation already has a group.", { group: this.groupView(existing) });
        }
        const g: GroupRow = { conversationId, groupId, epoch: 0, headSeq: 0, log: [] };
        this.groups.set(conversationId, g);
        return { ok: true, group: this.groupView(g) };
      },

      commit: async ({ conversationId, deviceId, commit, welcome }) => {
        await tick();
        if (this.held) {
          const held = this.held;
          await new Promise<void>((resolve) => {
            held.waiting.push(resolve);
            if (held.waiting.length >= held.count) {
              this.held = null;
              held.waiting.forEach((go) => go());
            }
          });
        }
        return this.commit(me, conversationId, deviceId, commit, welcome);
      },

      send: async ({ conversationId, deviceId, message, attachmentIds }) => {
        await tick();
        if (!member(conversationId)) return fail("not_found", "No such conversation.");
        const g = this.groups.get(conversationId);
        if (!g) return fail("no_group", "This conversation has no group yet.");
        const info = inspectMlsMessage(message);
        if (info.contentType === "commit") return fail("use_commit", "Send commits with mls:commit.");
        if (hexOf(info.groupId!) !== g.groupId) return fail("wrong_group", "That message is for another group.");
        const epoch = Number(info.epoch);
        if (epoch > g.epoch) return fail("future_epoch", "That epoch hasn't happened yet.", { epoch: g.epoch });
        const dup = g.log.find((e) => e.seq > g.headSeq - DUPLICATE_WINDOW && same(e.data, message));
        if (dup) return { ok: true, seq: dup.seq };
        const kind = info.contentType === "application" ? "application" : "proposal";
        const entry = this.append(g, kind, epoch, me, deviceId, message);
        this.attachmentIds.set(entry.seq, attachmentIds);
        this.push(this.conversations.get(conversationId)!, (d) => d.handleMessage(entry));
        return { ok: true, seq: entry.seq };
      },

      fetchLog: async ({ conversationId, after, limit }) => {
        await tick();
        if (!member(conversationId)) return fail("not_found", "No such conversation.");
        const g = this.groups.get(conversationId);
        if (!g) return { ok: true, group: null, entries: [], nextCursor: after, hasMore: false, gap: false };
        const n = Math.min(limit ?? 100, MAX_LOG_PAGE);
        const rows = g.log.filter((e) => e.seq > after).slice(0, n + 1);
        const page = rows.slice(0, n);
        const oldest = g.log.length ? g.log[0].seq : null;
        const gap = after < g.headSeq && (oldest === null || oldest > after + 1);
        return {
          ok: true,
          group: this.groupView(g),
          entries: page.map((e) => ({ ...e, data: e.data.slice() })),
          nextCursor: page.length ? page[page.length - 1].seq : Math.max(after, gap ? g.headSeq : after),
          hasMore: rows.length > n,
          gap,
        };
      },

      sync: async ({ deviceId }) => {
        await tick();
        const registered = this.isDevice(me, deviceId);
        const groups = [...this.groups.values()]
          .filter((g) => member(g.conversationId))
          .map((g) => ({ ...this.groupView(g), oldestSeq: g.log.length ? g.log[0].seq : null }));
        const welcomes = registered
          ? this.welcomes.filter((w) => w.serverUserId === me && w.deviceId === deviceId).slice(0, this.syncWelcomeLimit)
          : [];
        return { ok: true, registered, groups, welcomes, keyPackages: { ...this.counts(me, deviceId), target: MAX_KEY_PACKAGES } };
      },

      ackWelcomes: async ({ deviceId, welcomeIds }) => {
        await tick();
        const before = this.welcomes.length;
        this.welcomes = this.welcomes.filter((w) => !(w.serverUserId === me && w.deviceId === deviceId && welcomeIds.includes(w.welcomeId)));
        return { ok: true, deleted: before - this.welcomes.length };
      },
    };

    // socket.io-parser closes the connection on a packet with more than ten binary parts.
    const guarded = {} as Record<string, (req: unknown) => Promise<unknown>>;
    for (const [name, method] of Object.entries(methods) as [string, (req: unknown) => Promise<unknown>][]) {
      guarded[name] = async (req) => {
        this.checkParts(socket, name, req);
        const reply = await method(req);
        this.checkParts(socket, name, reply);
        return reply;
      };
    }
    return guarded as unknown as MlsTransport;
  }

  private checkParts(socket: Socket, event: string, value: unknown): void {
    const count = (v: unknown): number =>
      v instanceof Uint8Array ? 1 : Array.isArray(v) ? v.reduce((n: number, x) => n + count(x), 0)
        : v && typeof v === "object" ? Object.values(v).reduce((n: number, x) => n + count(x), 0) : 0;
    const parts = count(value);
    this.stats.mostBinaryParts = Math.max(this.stats.mostBinaryParts, parts);
    if (parts > 10) {
      socket.online = false;
      throw new Error(`${event}: ${parts} binary parts, so the socket was closed ("too many attachments").`);
    }
  }

  private counts(serverUserId: string, deviceId: string) {
    const mine = this.keyPackages.filter((k) => k.serverUserId === serverUserId && k.deviceId === deviceId && !k.claimed);
    return { unclaimed: mine.filter((k) => !k.lastResort).length, lastResort: mine.some((k) => k.lastResort) };
  }

  private append(g: GroupRow, kind: MlsLogEntry["kind"], epoch: number, sender: string, deviceId: string, data: Uint8Array): MlsLogEntry {
    g.headSeq += 1;
    const entry: MlsLogEntry = {
      conversationId: g.conversationId,
      groupId: g.groupId,
      seq: g.headSeq,
      kind,
      epoch,
      senderServerUserId: sender,
      senderDeviceId: deviceId,
      data: data.slice(),
      createdAt: new Date().toISOString(),
    };
    g.log.push(entry);
    return entry;
  }

  private async commit(
    me: string,
    conversationId: string,
    deviceId: string,
    commit: Uint8Array,
    welcome: Uint8Array | undefined,
  ): Promise<MlsReply<{ seq: number; epoch: number }>> {
    if (!this.conversations.get(conversationId)?.includes(me)) return fail("not_found", "No such conversation.");
    if (!this.isDevice(me, deviceId)) return fail("unknown_device", "Publish KeyPackages from this device first.");
    const g = this.groups.get(conversationId);
    if (!g) return fail("no_group", "This conversation has no group yet.");
    const info = inspectMlsMessage(commit);
    if (info.wireformat !== "mls_public_message" || info.contentType !== "commit") return fail("not_a_commit", "Not a commit.");
    if (hexOf(info.groupId!) !== g.groupId) return fail("wrong_group", "That commit is for another group.");
    const dup = g.log.find((e) => e.seq > g.headSeq - DUPLICATE_WINDOW && same(e.data, commit));
    if (dup) return { ok: true, seq: dup.seq, epoch: dup.epoch + 1 };
    const epoch = Number(info.epoch);
    if (epoch !== g.epoch) {
      this.stats.staleEpoch += 1;
      return fail("stale_epoch", "Another commit got there first.", { epoch: g.epoch, headSeq: g.headSeq });
    }

    const recipients: MlsDeviceRef[] = [];
    if (welcome) {
      for (const ref of mlsWelcomeRefs(welcome)) {
        const owner = this.keyPackages.find((k) => k.ref === ref);
        if (!owner) return fail("not_a_member_device", "That Welcome is for somebody outside the conversation.");
        recipients.push({ serverUserId: owner.serverUserId, deviceId: owner.deviceId });
      }
    }
    this.stats.commits += 1;
    const entry = this.append(g, "commit", epoch, me, deviceId, commit);
    g.epoch += 1;
    this.push(this.conversations.get(conversationId)!, (d) => d.handleMessage(entry));
    for (const r of recipients) {
      const w = {
        welcomeId: `w${this.nextWelcome++}`,
        conversationId,
        groupId: g.groupId,
        deviceId: r.deviceId,
        data: welcome!.slice(),
        createdAt: entry.createdAt,
      };
      this.welcomes.push({ ...w, serverUserId: r.serverUserId });
      this.push([r.serverUserId], (d) => d.handleWelcome(w));
    }
    return { ok: true, seq: entry.seq, epoch: g.epoch };
  }
}

/** What an app's store does, kept in maps and copied on the way in and out. */
export class MemoryMlsStore implements MlsStateStore {
  device: MlsDeviceRecord | null = null;
  keyPackages = new Map<string, MlsKeyPackageRecord>();
  groups = new Map<string, MlsGroupRecord>();

  async loadDevice() {
    return this.device;
  }
  async saveDevice(device: MlsDeviceRecord) {
    this.device = device;
  }
  async putKeyPackages(records: MlsKeyPackageRecord[]) {
    for (const r of records) this.keyPackages.set(r.ref, r);
  }
  async listKeyPackages() {
    return [...this.keyPackages.values()];
  }
  async getKeyPackage(ref: string) {
    return this.keyPackages.get(ref) ?? null;
  }
  async deleteKeyPackage(ref: string) {
    this.keyPackages.delete(ref);
  }
  async loadGroup(conversationId: string) {
    const r = this.groups.get(conversationId);
    return r ? structuredClone(r) : null;
  }
  async listGroups() {
    return [...this.groups.values()].map((r) => structuredClone(r));
  }
  async saveGroup(record: MlsGroupRecord) {
    this.groups.set(record.conversationId, structuredClone(record));
  }
  async deleteGroup(conversationId: string) {
    this.groups.delete(conversationId);
  }
}
