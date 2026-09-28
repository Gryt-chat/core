import {
  base64Url,
  base64UrlDecode,
  createPairingKey,
  decodePairingEnvelope,
  decodePairingSessionId,
  formatPairingCode,
  formatPairingQr,
  pairingCommitment,
  startNewDeviceSession,
  type PairingAccount,
  type PairingEmoji,
  type PairingEnvelope,
  type PairingServer,
  type PairingSession,
} from "@gryt/crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";

import { mailbox, PairingEnded, reasonFor, sealJson, systemClock } from "./channel.ts";
import type {
  PairedServerDevice,
  PairingClock,
  PairingDeviceInfo,
  PairingEndReason,
  PairingOidc,
  PairingStorage,
  PairingTokens,
} from "./interfaces.js";
import type { PairingRelay } from "./relayClient.js";

export type NewDeviceState =
  | { phase: "idle" }
  | { phase: "opening" }
  /** `renewed` says why this is a fresh QR: the last one ran out, or A never approved. */
  | { phase: "showing"; qr: string; code: string; expiresAt: number; renewed?: "expired" | "timed_out" }
  | { phase: "comparing"; emoji: readonly PairingEmoji[]; deadline: number }
  | { phase: "signing_in"; username: string; from: string }
  /** Everything is written. The app joins `servers`, publishes KeyPackages, then calls `ready`. */
  | { phase: "joining"; servers: PairingServer[]; from: string }
  | { phase: "linked"; from: string }
  | { phase: "done"; from: string }
  | { phase: "ended"; reason: PairingEndReason };

export interface NewDeviceOptions {
  relay: PairingRelay;
  device: PairingDeviceInfo;
  storage: PairingStorage;
  oidc: PairingOidc;
  clock?: PairingClock;
  /** Only for a server with its own auth server: goes in the QR for A to check against its own. */
  relayOrigin?: string;
  approvalMs?: number;
}

export interface NewDevicePairing {
  readonly state: NewDeviceState;
  subscribe(listener: (state: NewDeviceState) => void): () => void;
  start(): void;
  /** In `joining`: N's device on each server, once its KeyPackages are up. */
  ready(devices: PairedServerDevice[]): Promise<void>;
  cancel(): Promise<void>;
  /** "They don't match": the same as cancel, with a reason that says the link may be tampered with. */
  mismatch(): Promise<void>;
}

export const PAIRING_APPROVAL_MS = 60_000;
const PAIRING_OIDC_SCOPE = "openid profile email offline_access";

type Renewal = "expired" | "timed_out";

/** N: shows the QR and code, checks the emoji, opens the envelope, signs in, then says ready. */
export function createNewDevicePairing(options: NewDeviceOptions): NewDevicePairing {
  const { relay, device, storage, oidc } = options;
  const clock = options.clock ?? systemClock;
  const approvalMs = options.approvalMs ?? PAIRING_APPROVAL_MS;
  const listeners = new Set<(state: NewDeviceState) => void>();
  const abort = new AbortController();
  let state: NewDeviceState = { phase: "idle" };
  let current: { id: string; token: string; box: ReturnType<typeof mailbox>; session?: PairingSession } | null = null;

  const set = (next: NewDeviceState) => {
    if (state.phase === "ended" || state.phase === "done") return;
    state = next;
    for (const l of listeners) l(state);
  };
  const closeQuietly = () => (current ? relay.close(current.id, current.token).catch(() => undefined) : undefined);
  const end = async (reason: PairingEndReason) => {
    if (state.phase === "ended" || state.phase === "done") return;
    set({ phase: "ended", reason });
    abort.abort();
    current?.session?.close();
    await closeQuietly();
  };

  async function attempt(renewed?: Renewal): Promise<Renewal | PairingEnvelope> {
    set({ phase: "opening" });
    const key = createPairingKey();
    const created = await relay.create(base64Url(pairingCommitment(key.publicKey)));
    const sessionId = decodePairingSessionId(created.id);
    if (!sessionId) throw new PairingEnded("relay_error");
    const box = mailbox(relay, created.id, created.token, clock);
    current = { id: created.id, token: created.token, box };
    if (abort.signal.aborted) {
      await closeQuietly();
      throw new PairingEnded("cancelled");
    }

    const expiresAt = Date.parse(created.expiresAt);
    const qr = formatPairingQr({ sessionId, publicKey: key.publicKey, relayOrigin: options.relayOrigin });
    set({ phase: "showing", qr, code: formatPairingCode(created.code), expiresAt, ...(renewed ? { renewed } : {}) });

    // No local deadline: the relay's clock decides, and its 410 is what renews the QR.
    const claim = await box.next(abort.signal).catch((e) => {
      if (reasonFor(e) === "expired") return null;
      throw e;
    });
    if (!claim) return "expired";
    if (claim.type !== "claim" || !claim.pkA) throw new PairingEnded("tampered");
    let session: PairingSession;
    try {
      session = current.session = startNewDeviceSession(key, { sessionId, approverPublicKey: base64UrlDecode(claim.pkA) });
    } catch {
      throw new PairingEnded("tampered");
    }

    await relay.post(created.id, created.token, { type: "reveal", pkN: base64Url(key.publicKey) });
    const deadline = clock.now() + approvalMs;
    await relay.post(created.id, created.token, { type: "sealed", body: sealJson(session, { t: "hello", ...device, deadline }) });
    set({ phase: "comparing", emoji: session.emoji, deadline });

    const sealed = await box.next(abort.signal, deadline);
    if (!sealed || clock.now() > deadline) {
      session.close();
      await closeQuietly();
      return "timed_out";
    }
    try {
      if (sealed.type !== "sealed" || !sealed.body) throw new Error();
      return decodePairingEnvelope(session.open(base64UrlDecode(sealed.body)));
    } catch (e) {
      throw new PairingEnded(e instanceof Error && /newer version/.test(e.message) ? "newer_version" : "tampered");
    }
  }

  async function signIn(account: PairingAccount, from: string): Promise<PairingTokens> {
    const { id, token, box, session } = current!;
    set({ phase: "signing_in", username: account.username, from });
    const verifier = base64Url(randomBytes(32));
    const auth = await oidc.deviceAuthorization({
      issuer: account.issuer,
      clientId: account.clientId,
      scope: PAIRING_OIDC_SCOPE,
      codeChallenge: base64Url(sha256(new TextEncoder().encode(verifier))),
      codeChallengeMethod: "S256",
      nonce: session!.keycloakNonce,
    });
    await relay.post(id, token, { type: "sealed", body: sealJson(session!, { t: "user_code", userCode: auth.userCode }) });

    // A sends nothing more here, so anything from the relay (a close, most likely) stops the polling.
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    abort.signal.addEventListener("abort", onAbort, { once: true });
    let failure: unknown = null;
    box.next(stop.signal).then(
      () => ((failure = new PairingEnded("tampered")), stop.abort()),
      (e) => (stop.signal.aborted ? undefined : ((failure = e), stop.abort())),
    );
    try {
      let interval = (auth.interval ?? 5) * 1000;
      for (const until = clock.now() + auth.expiresIn * 1000; clock.now() < until; ) {
        await clock.sleep(interval, stop.signal).catch(() => {
          throw failure ?? new PairingEnded("cancelled");
        });
        const polled = await oidc.deviceToken({
          issuer: account.issuer,
          clientId: account.clientId,
          deviceCode: auth.deviceCode,
          codeVerifier: verifier,
        });
        if (failure) throw failure;
        if (polled.status === "ok") return checkIdToken(polled.tokens, account, session!.keycloakNonce);
        // RFC 8628's own two terminal errors, plus what auth#46 leaves behind when A's approve
        // endpoint refuses the code: either way N's device grant sees it as denied.
        if (polled.status === "denied") throw new PairingEnded("access_denied");
        if (polled.status === "expired") throw new PairingEnded("expired_token");
        if (polled.status === "slow_down") interval += 5000;
        // Anything else is "pending": keep polling.
      }
      throw new PairingEnded("sign_in_failed");
    } finally {
      stop.abort();
      abort.signal.removeEventListener("abort", onAbort);
    }
  }

  async function run() {
    try {
      let outcome = await attempt();
      while (typeof outcome === "string") outcome = await attempt(outcome);
      const envelope = outcome;
      const tokens = envelope.account ? await signIn(envelope.account, envelope.from) : null;
      await storage.commit(envelope, tokens);
      set({ phase: "joining", servers: envelope.servers, from: envelope.from });
    } catch (e) {
      if (!abort.signal.aborted) await end(reasonFor(e));
    }
  }

  async function linked(from: string) {
    try {
      // History from A lands here in a later version. Until then, A closing is the finish.
      while (await current!.box.next(abort.signal));
    } catch (e) {
      if (abort.signal.aborted) return;
      const reason = reasonFor(e);
      if (reason !== "cancelled_by_other" && reason !== "expired") return end(reason);
      set({ phase: "done", from });
      current?.session?.close();
    }
  }

  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    start() {
      if (state.phase !== "idle") throw new Error("This pairing has started already.");
      void run();
    },
    async ready(devices) {
      if (state.phase !== "joining" || !current?.session) throw new Error("Not waiting to join.");
      const { from } = state;
      const body = sealJson(current.session, { t: "ready", devices: devices.map(({ host, deviceId }) => ({ host, deviceId })) });
      await relay.post(current.id, current.token, { type: "sealed", body });
      set({ phase: "linked", from });
      void linked(from);
    },
    cancel: () => end("cancelled"),
    mismatch: () => end("mismatch"),
  };
}

/** Straight from the token endpoint over TLS, so the claims are read, not the signature (OIDC Core 3.1.3.7). */
function checkIdToken(tokens: PairingTokens, account: PairingAccount, nonce: string): PairingTokens {
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(tokens.idToken.split(".")[1] ?? "")));
  } catch {
    throw new PairingEnded("sign_in_failed");
  }
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.nonce !== nonce || claims.iss !== account.issuer || !aud.includes(account.clientId)) {
    throw new PairingEnded("tampered");
  }
  if (claims.sub !== account.sub) throw new PairingEnded("wrong_account");
  return tokens;
}
