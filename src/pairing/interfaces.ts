import type { PairingEnvelope } from "@gryt/crypto";

import type { MlsAddOwnDeviceOptions, MlsOwnDeviceAdd } from "../mls/interfaces.js";

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
  | { addOwnDevice(deviceId: string, options?: MlsAddOwnDeviceOptions): Promise<MlsOwnDeviceAdd[]> }
  | undefined;

/** Why a pairing stopped. `approve:<error>` carries the extension's own error code. */
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
  | `approve:${string}`;
