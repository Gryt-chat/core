import type { HistoryRecord, PairingEnvelope } from "@gryt/crypto";

import type { MlsAddOwnDeviceOptions, MlsGroupPosition, MlsOwnDeviceAdd } from "../mls/interfaces.js";

/* What each app implements for linking a device (GRYT-1484). The protocol is
   docs/pairing-design.md in Gryt-chat/crypto; the relay is /api/v1/pairing on id.gryt.chat. */

/** `fetch`, cut down to what pairing uses. The browser's, Node's and React Native's all fit. */
export type PairingFetch = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface PairingClock {
  now(): number;
  /** Resolves after `ms`, or rejects once `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** What N tells A about itself, shown on the approval screen. N chooses it, so A treats it as a claim. */
export interface PairingDeviceInfo {
  name: string;
  app: string;
  platform: string;
}

/** Tokens from the device grant. The ID token has already been checked against the envelope. */
export interface PairingTokens {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  expiresIn: number;
  interval?: number;
}

export type DeviceTokenPoll =
  | { status: "pending" | "slow_down" | "denied" | "expired" }
  | { status: "ok"; tokens: PairingTokens };

/** The two RFC 8628 calls, against `{issuer}/protocol/openid-connect/...`. Core makes the PKCE and nonce. */
export interface PairingOidc {
  deviceAuthorization(req: {
    issuer: string;
    clientId: string;
    scope: string;
    codeChallenge: string;
    codeChallengeMethod: "S256";
    nonce: string;
  }): Promise<DeviceAuthorization>;
  deviceToken(req: { issuer: string; clientId: string; deviceCode: string; codeVerifier: string }): Promise<DeviceTokenPoll>;
}

/** N's secure storage. Called once, only after every check has passed, with everything to keep. */
export interface PairingStorage {
  commit(envelope: PairingEnvelope, tokens: PairingTokens | null): Promise<void>;
}

/** N's MLS device on one server, sent to A in "ready" once its KeyPackages are published. */
export interface PairedServerDevice {
  host: string;
  deviceId: string;
}

/** A's DM driver on one server, or undefined when A isn't on it. */
export type OwnDeviceAdder = (host: string) =>
  | {
      addOwnDevice(deviceId: string, options?: MlsAddOwnDeviceOptions): Promise<MlsOwnDeviceAdd[]>;
      /** Where the history snapshot stops in each group; the tail starts after it. */
      groupPositions(): Promise<MlsGroupPosition[]>;
    }
  | undefined;

/** Why a pairing stopped. `approve:<error>` carries the extension's own error code for anything
    below that isn't broken out on its own (GRYT-1578; auth#46 has the full list). */
export type PairingEndReason =
  | "cancelled"
  | "cancelled_by_other"
  | "mismatch"
  | "timed_out"
  | "expired"
  | "already_claimed"
  | "unknown_code"
  | "wrong_relay"
  | "newer_version"
  | "not_pairing"
  | "rate_limited"
  | "tampered"
  | "wrong_account"
  | "sign_in_failed"
  | "relay_error"
  /** N's archive refused the history it was handed. Keys and sign-in are in place. */
  | "history_failed"
  /** The approve endpoint says this user_code already got its one answer. */
  | "code_used"
  /** The approve endpoint says the user_code isn't valid any more: unknown, expired, or not pending. */
  | "code_expired"
  /** The approve endpoint refuses because the account has something pending, like verifying an email. */
  | "required_actions"
  /** The approve endpoint refuses A's access token as too old; refresh it and try again. */
  | "stale_token"
  /** The device grant itself said no: A denied it, or the approve endpoint's refusal denied the code. */
  | "access_denied"
  /** The device grant's user_code ran out before anyone answered it. */
  | "expired_token"
  | `approve:${string}`;

/** A conversation in A's archive. `count` feeds the progress total, so leave it off rather than guess. */
export interface HistoryConversation {
  scope: string;
  conversationId: string;
  count?: number;
}

/** Where a page of the archive stops: the oldest record in it. */
export interface HistoryCursor {
  sentAt: number;
  messageId: string;
}

/** A's archive, read for the history snapshot. Records are @gryt/crypto's HistoryRecord. */
export interface HistoryArchive {
  conversations(): Promise<HistoryConversation[]>;
  /** Up to `limit` records sent before `before` (by sentAt, then messageId), in any order. */
  page(scope: string, conversationId: string, options: { before?: HistoryCursor; limit: number }): Promise<HistoryRecord[]>;
}

/** N's archive. Core hands it each message id once; a record for an id N already holds replaces it. */
export interface HistorySink {
  put(records: HistoryRecord[]): Promise<void>;
}

/** How a history transfer is going, on either side. */
export interface HistoryProgress {
  /** A: messages uploaded and listed. N: messages stored. */
  messages: number;
  /** A: from the archive's counts. N: what A said it would send. Null when nobody knows yet. */
  total: number | null;
  /** Chunks uploaded (A) or fetched and stored (N), out of `listed`. */
  chunks: number;
  listed: number;
  /** N only: chunks the relay no longer has, and chunks that failed their manifest check. */
  missing: number;
  refused: number;
  /** The relay's cap stopped the snapshot early; the oldest messages stayed behind. */
  truncated: boolean;
  /** The oldest message time sent so far, so N can say how far back it has. */
  oldest: number | null;
  complete: boolean;
}

/** A message A archived from MLS, received or sent, with where it sits in its group's log. */
export interface HistoryNotedMessage {
  host: string;
  conversationId: string;
  seq: number;
  epoch: number;
  record: HistoryRecord;
}
