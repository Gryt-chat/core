import type { TrustPersonKey } from "@gryt/crypto";

/* What each app implements for the MLS DM driver: the socket, the storage and the pins.
   Shapes follow the mls:* events in Gryt-chat/server#241. Bytes are always Uint8Array. */

// ── Transport ──────────────────────────────────────────────────────────

/** A refusal, exactly as the server's ack sends it. Extra fields ride along. */
export interface MlsRefusal {
  ok: false;
  error: string;
  message: string;
  [extra: string]: unknown;
}

export type MlsReply<T> = ({ ok: true } & T) | MlsRefusal;

export interface MlsDeviceRef {
  serverUserId: string;
  deviceId: string;
}

/** The server's view of a group. `groupId` is lower-case hex. */
export interface MlsGroupView {
  conversationId: string;
  groupId: string;
  epoch: number;
  headSeq: number;
}

/** One entry of a group's log, from `mls:log:fetch` or the `mls:message` push. */
export interface MlsLogEntry {
  conversationId: string;
  groupId: string;
  seq: number;
  kind: "commit" | "proposal" | "application";
  epoch: number;
  senderServerUserId: string;
  senderDeviceId: string;
  data: Uint8Array;
  createdAt: string;
}

/** A Welcome, from `mls:sync` or the `mls:welcome` push. Pushes go to every device of a person. */
export interface MlsWelcomeDelivery {
  welcomeId: string;
  conversationId: string | null;
  groupId: string;
  deviceId: string;
  data: Uint8Array;
  createdAt: string;
}

export interface MlsClaimedKeyPackage extends MlsDeviceRef {
  keyPackage: Uint8Array;
  lastResort: boolean;
}

/**
 * One method per mls:* request. The app adds `accessToken`, emits, and resolves with the ack,
 * turning ArrayBuffers into Uint8Arrays. Pushes go to the driver's `handle*` methods instead.
 */
export interface MlsTransport {
  publishKeyPackages(req: {
    deviceId: string;
    keyPackages: Uint8Array[];
    lastResort?: Uint8Array;
  }): Promise<MlsReply<{ stored: number; unclaimed: number; lastResort: boolean }>>;

  claimKeyPackages(req: {
    conversationId: string;
    deviceId: string;
    devices?: MlsDeviceRef[];
  }): Promise<MlsReply<{ keyPackages: MlsClaimedKeyPackage[]; missing: MlsDeviceRef[] }>>;

  /** Your own devices with no conversation, or every member's with one. */
  listDevices(req: { conversationId?: string }): Promise<MlsReply<{ devices: MlsDeviceRef[] }>>;

  removeDevice(req: { deviceId: string }): Promise<MlsReply<object>>;

  /** The loser gets `error: "group_exists"` with the winner's `group`. */
  createGroup(req: { conversationId: string; groupId: string }): Promise<MlsReply<{ group: MlsGroupView }>>;

  /** `error: "stale_epoch"` carries `epoch` and `headSeq`. */
  commit(req: {
    conversationId: string;
    deviceId: string;
    commit: Uint8Array;
    welcome?: Uint8Array;
  }): Promise<MlsReply<{ seq: number; epoch: number }>>;

  send(req: { conversationId: string; deviceId: string; message: Uint8Array }): Promise<MlsReply<{ seq: number }>>;

  fetchLog(req: { conversationId: string; after: number; limit?: number }): Promise<
    MlsReply<{
      group: MlsGroupView | null;
      entries: MlsLogEntry[];
      nextCursor: number;
      hasMore: boolean;
      gap: boolean;
    }>
  >;

  sync(req: { deviceId: string }): Promise<
    MlsReply<{
      registered: boolean;
      groups: (MlsGroupView & { oldestSeq: number | null })[];
      welcomes: MlsWelcomeDelivery[];
      keyPackages: { unclaimed: number; lastResort: boolean; target: number };
    }>
  >;

  ackWelcomes(req: { deviceId: string; welcomeIds: string[] }): Promise<MlsReply<{ deleted: number }>>;
}

/** `server:info.mls`. Absent means the server can't do MLS. */
export interface MlsServerCapability {
  version: number;
  ciphersuites: number[];
  retentionDays: number;
}

// ── State store ────────────────────────────────────────────────────────

/** This device's leaf key and certificate, from `createMlsDevice` in @gryt/crypto. */
export interface MlsDeviceRecord {
  deviceId: string;
  signKey: Uint8Array;
  publicKey: Uint8Array;
  certificate: Uint8Array;
}

/** The private half of a published KeyPackage, found again by the ref a Welcome names. */
export interface MlsKeyPackageRecord {
  ref: string;
  keyPackage: Uint8Array;
  privatePackage: Uint8Array;
  lastResort: boolean;
  /** Milliseconds. */
  createdAt: number;
  /** Seconds, from `generateMlsKeyPackage`. Absent on records written before 0.7.0. */
  expiresAt?: number;
}

/**
 * One group. `state` and `cursor` are always written together (design, section 2).
 * `pending` is a commit sent but not yet seen accepted, so a crash can't strand it.
 */
export interface MlsGroupRecord {
  conversationId: string;
  groupId: string;
  state: Uint8Array;
  cursor: number;
  /** Entries from before this epoch were never meant for this device. */
  joinedEpoch: number;
  pending?: { commit: Uint8Array; state: Uint8Array };
}

/**
 * One store per server. Keep it out of OS backups: restored MLS state is out of sync. On the
 * web, only the tab holding the Web Lock may write.
 */
export interface MlsStateStore {
  loadDevice(): Promise<MlsDeviceRecord | null>;
  saveDevice(device: MlsDeviceRecord): Promise<void>;

  putKeyPackages(records: MlsKeyPackageRecord[]): Promise<void>;
  getKeyPackage(ref: string): Promise<MlsKeyPackageRecord | null>;
  listKeyPackages(): Promise<MlsKeyPackageRecord[]>;
  deleteKeyPackage(ref: string): Promise<void>;

  loadGroup(conversationId: string): Promise<MlsGroupRecord | null>;
  listGroups(): Promise<MlsGroupRecord[]>;
  saveGroup(record: MlsGroupRecord): Promise<void>;
  deleteGroup(conversationId: string): Promise<void>;
}

// ── Pins ───────────────────────────────────────────────────────────────

/**
 * The person-key pin (design, section 1). The app verifies each member's person key binding
 * and pins it on first sight, before the driver meets their leaves; the driver only asks.
 */
export interface MlsPins {
  /** Which member of this conversation holds this person key by pin, you included, or null. */
  personOf(conversationId: string, personPublicKey: Uint8Array): string | null | Promise<string | null>;
  /** The engine's check for every leaf. Without it, any leaf `personOf` names passes. */
  trustFor?(conversationId: string): TrustPersonKey;
  /** Decision 4: once a peer is seen on MLS, never seal to them with version 1 again. */
  seenOnMls(serverUserId: string): boolean | Promise<boolean>;
  markSeenOnMls(serverUserId: string): void | Promise<void>;
}

// ── What the driver reports ────────────────────────────────────────────

export interface MlsDecryptedMessage {
  conversationId: string;
  seq: number;
  senderServerUserId: string;
  senderDeviceId: string;
  plaintext: Uint8Array;
  createdAt: string;
}

/**
 * `onMessage` must have stored the message before it resolves: the key is gone once the
 * cursor moves. It may see the same seq twice after a crash.
 */
export interface MlsDmEvents {
  onMessage(message: MlsDecryptedMessage): void | Promise<void>;
  /** "Some messages couldn't be decrypted on this device" (design, section 2). */
  onUndecryptable?(info: { conversationId: string; seq: number; reason: string }): void;
  /** This device is out of the group: removed, or its state couldn't keep up. */
  onGroupLost?(info: { conversationId: string; reason: "removed" | "out_of_sync" | "gap" }): void;
  onJoined?(info: { conversationId: string; groupId: string }): void;
}

/** Decision 4, per DM. `refused` never falls back to version 1. */
export type DmSealingMode =
  | { kind: "mls" }
  | { kind: "sealed-v1"; reason: "server_without_mls" | "peer_without_mls" }
  | { kind: "refused"; reason: "peer_left_mls" | "server_dropped_mls" | "no_own_device" };

// ── The driver ─────────────────────────────────────────────────────────

export interface MlsDmDriverOptions {
  transport: MlsTransport;
  store: MlsStateStore;
  pins: MlsPins;
  events: MlsDmEvents;
  /** The identity scope this server's keys are derived under. */
  scope: string;
  serverUserId: string;
  /** `server:info.mls`, or null when the server doesn't advertise it. */
  capability: MlsServerCapability | null;
  /** The first time only: `createMlsDevice` from @gryt/crypto, so the seed stays in the app. */
  newDevice(): MlsDeviceRecord | Promise<MlsDeviceRecord>;
}

/** One per server. Calls for one conversation run one at a time, in order. */
export interface MlsDmDriver {
  /** On connect: register, top up KeyPackages, take waiting Welcomes, catch up every group. */
  start(): Promise<void>;
  modeFor(conversationId: string, peerServerUserId: string): Promise<DmSealingMode>;
  /** Opens the group if need be, adds or removes devices that changed, then sends. */
  send(conversationId: string, peerServerUserId: string, plaintext: Uint8Array): Promise<{ seq: number }>;
  handleMessage(entry: MlsLogEntry): Promise<void>;
  handleWelcome(welcome: MlsWelcomeDelivery): Promise<void>;
  handleDevicesChanged(push: { serverUserId: string }): Promise<void>;
  ownDevices(): Promise<MlsDeviceRef[]>;
  /** Your own devices only. Every group you share drops it on the next pass. */
  removeOwnDevice(deviceId: string): Promise<void>;
}
