import {
  base64Url,
  base64UrlDecode,
  createPairingKey,
  decodePairingSessionId,
  encodePairingEnvelope,
  encodePairingSessionId,
  parsePairingCode,
  parsePairingQr,
  startApproverSession,
  type PairingEmoji,
  type PairingEnvelope,
  type PairingSession,
} from "@gryt/crypto";

import type { MlsOwnDeviceAdd } from "../mls/interfaces.js";
import { mailbox, openJson, PairingEnded, reasonFor, sealJson, systemClock } from "./channel.ts";
import { createHistorySender, createTailRecorder, type HistoryMessage } from "./historySender.ts";
import type {
  HistoryArchive,
  HistoryNotedMessage,
  HistoryProgress,
  OwnDeviceAdder,
  PairedServerDevice,
  PairingClock,
  PairingDeviceInfo,
  PairingEndReason,
  PairingFetch,
} from "./interfaces.js";
import { PAIRING_APPROVAL_MS } from "./newDevice.ts";
import type { PairingRelay } from "./relayClient.js";

export type ApproverState =
  | { phase: "idle" }
  | { phase: "claiming" }
  | { phase: "waiting" }
  | {
      phase: "confirming";
      device: PairingDeviceInfo;
      /** Where the relay puts N, and A, from their IPs. Null when it can't say. */
      location: string | null;
      yourLocation: string | null;
      emoji: readonly PairingEmoji[];
      deadline: number;
    }
  | { phase: "signing_in"; device: PairingDeviceInfo }
  /** No extension on this Keycloak: the app opens `url`, Keycloak's own device page, for the same code. */
  | { phase: "browser"; device: PairingDeviceInfo; url: string }
  | { phase: "waiting_ready"; device: PairingDeviceInfo }
  | { phase: "adding"; device: PairingDeviceInfo; host: string; done: number; total: number }
  /** N is in every conversation; the history's tail is still going. Progress is on `history`. */
  | { phase: "sending"; device: PairingDeviceInfo; added: Record<string, MlsOwnDeviceAdd[]> }
  | { phase: "done"; device: PairingDeviceInfo; added: Record<string, MlsOwnDeviceAdd[]> }
  | { phase: "ended"; reason: PairingEndReason };

export interface ApproverOptions {
  relay: PairingRelay;
  /** A's own relay origin. A QR naming any other is refused. */
  relayOrigin: string;
  /** For the extension call. */
  fetch: PairingFetch;
  devices: OwnDeviceAdder;
  clock?: PairingClock;
  approvalMs?: number;
  /** A's archive. Without it, no history goes across. */
  history?: HistoryArchive;
  /** How long after the adds A keeps collecting old-epoch messages for the last tail. */
  lateWindowMs?: number;
}

export interface ApproverPairing {
  readonly state: ApproverState;
  subscribe(listener: (state: ApproverState) => void): () => void;
  /** Null until Approve, or with no archive. */
  readonly history: HistoryProgress | null;
  subscribeHistory(listener: (progress: HistoryProgress) => void): () => void;
  /** Every MLS message A archives while this runs, received or sent, for the tail. */
  noteMessage(message: HistoryNotedMessage): void;
  /** A scanned QR, or a typed code. */
  claim(input: { qr: string } | { code: string }): void;
  /** For an account, `accessToken` refreshes first: the extension refuses a token over 60 seconds old. */
  approve(envelope: PairingEnvelope, accessToken?: () => Promise<string>): void;
  deny(): Promise<void>;
  mismatch(): Promise<void>;
  cancel(): Promise<void>;
}

const NOT_LISTED_RETRIES = 5;
/** How long Approve may spend sealing history before the envelope goes, so it lands in N's window. */
const ENVELOPE_BUDGET_MS = 5_000;
const HISTORY_LATE_WINDOW_MS = 60_000;

/** auth#46's codes that get a named reason. Anything else it can answer still falls
    through to the generic `approve:<code>`. */
const APPROVE_ERROR_REASONS: Record<string, PairingEndReason> = {
  code_used: "code_used",
  unknown_code: "code_expired",
  expired_code: "code_expired",
  code_not_pending: "code_expired",
  required_actions: "required_actions",
  stale_token: "stale_token",
  rate_limited: "rate_limited",
};

/** A: claims the session, shows N and the emoji, and on Approve seals the envelope, signs N in and adds it. */
export function createApproverPairing(options: ApproverOptions): ApproverPairing {
  const { relay, fetch, devices } = options;
  const clock = options.clock ?? systemClock;
  const approvalMs = options.approvalMs ?? PAIRING_APPROVAL_MS;
  const listeners = new Set<(state: ApproverState) => void>();
  const abort = new AbortController();
  let state: ApproverState = { phase: "idle" };
  let current: { id: string; token: string; box: ReturnType<typeof mailbox>; session?: PairingSession } | null = null;
  let device: PairingDeviceInfo | null = null;
  let confirming: AbortController | null = null;
  let deadline = 0;
  let history: HistoryProgress | null = null;
  const historyListeners = new Set<(progress: HistoryProgress) => void>();
  const tail = createTailRecorder();
  const setHistory = (progress: HistoryProgress) => {
    history = progress;
    for (const l of historyListeners) l(progress);
  };

  const set = (next: ApproverState) => {
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
  const fail = (e: unknown) => (abort.signal.aborted ? undefined : end(reasonFor(e)));

  async function claim(input: { qr: string } | { code: string }) {
    let by: { id: string } | { code: string };
    let scanned: Uint8Array | undefined;
    if ("qr" in input) {
      const qr = parsePairingQr(input.qr);
      if (!qr.ok) throw new PairingEnded(qr.reason === "newer-version" ? "newer_version" : "not_pairing");
      if (qr.relayOrigin !== undefined && qr.relayOrigin !== options.relayOrigin.toLowerCase().replace(/\/+$/, "")) {
        throw new PairingEnded("wrong_relay");
      }
      by = { id: encodePairingSessionId(qr.sessionId) };
      scanned = qr.publicKey;
    } else {
      const code = parsePairingCode(input.code);
      if (!code) throw new PairingEnded("unknown_code");
      by = { code };
    }

    set({ phase: "claiming" });
    const key = createPairingKey();
    const claimed = await relay.claim(by, base64Url(key.publicKey));
    const box = mailbox(relay, claimed.id, claimed.token, clock);
    current = { id: claimed.id, token: claimed.token, box };
    const sessionId = decodePairingSessionId(claimed.id);
    set({ phase: "waiting" });

    const reveal = await box.next(abort.signal, clock.now() + approvalMs);
    if (!reveal) throw new PairingEnded("timed_out");
    if (reveal.type !== "reveal" || !reveal.pkN || !sessionId) throw new PairingEnded("tampered");
    try {
      current.session = startApproverSession(key, {
        sessionId,
        commitment: base64UrlDecode(claimed.commit),
        newDevicePublicKey: base64UrlDecode(reveal.pkN),
        scannedPublicKey: scanned,
      });
    } catch {
      throw new PairingEnded("tampered");
    }

    const hello = openJson(current.session, await box.next(abort.signal, clock.now() + approvalMs), "hello");
    const text = (v: unknown) => (typeof v === "string" ? v.slice(0, 100) : "");
    device = { name: text(hello.name), app: text(hello.app), platform: text(hello.platform) };
    deadline = clock.now() + approvalMs;
    set({ phase: "confirming", device, location: claimed.location, yourLocation: claimed.yourLocation, emoji: current.session.emoji, deadline });

    // N sends nothing more until A approves, so a message or a close here means something's off.
    confirming = new AbortController();
    abort.signal.addEventListener("abort", () => confirming?.abort(), { once: true });
    try {
      if (await box.next(confirming.signal, deadline)) throw new PairingEnded("tampered");
    } catch (e) {
      if (confirming.signal.aborted) return;
      // N's clock started a moment before ours, so its timeout close can land just before ours fires.
      if (reasonFor(e) !== "cancelled_by_other" || clock.now() < deadline - 5000) throw e;
    }
    throw new PairingEnded("timed_out");
  }

  async function approveExtension(issuer: string, userCode: string, accessToken: () => Promise<string>) {
    const token = await accessToken();
    const res = await fetch(`${issuer.replace(/\/+$/, "")}/gryt-pairing/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ user_code: userCode, binding: current!.session!.keycloakNonce }),
    }).catch(() => {
      throw new PairingEnded("approve:network");
    });
    if (res.status === 204) return true;
    if (res.status === 404) return false;
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const code = typeof body?.error === "string" ? body.error : String(res.status);
    throw new PairingEnded(APPROVE_ERROR_REASONS[code] ?? `approve:${code}`);
  }

  async function addEverywhere(ready: PairedServerDevice[]) {
    const added: Record<string, MlsOwnDeviceAdd[]> = {};
    for (const { host, deviceId } of ready) {
      const driver = devices(host);
      if (!driver) continue;
      for (let tries = 0; ; tries++) {
        try {
          added[host] = await driver.addOwnDevice(deviceId, {
            onProgress: ({ done, total }) => set({ phase: "adding", device: device!, host, done, total }),
          });
          break;
        } catch (e) {
          // The server lists N's device once its KeyPackages are in, which can trail N's "ready".
          if ((e as { code?: unknown }).code !== "not_own_device" || tries >= NOT_LISTED_RETRIES) throw e;
          await clock.sleep(2000, abort.signal);
        }
      }
    }
    return added;
  }

  /** Each group's cursor on every server in the envelope: the snapshot covers up to there. */
  async function positions(envelope: PairingEnvelope) {
    const snap = new Map<string, Map<string, number>>();
    for (const { host } of envelope.servers) {
      const driver = devices(host);
      if (driver) snap.set(host, new Map((await driver.groupPositions()).map((p) => [p.conversationId, p.seq])));
    }
    return snap;
  }

  function startHistory(archive: HistoryArchive) {
    const { id, token, session } = current!;
    return createHistorySender({
      relay, id, token, archive, clock, signal: abort.signal,
      post: (message: HistoryMessage) =>
        relay.post(id, token, { type: "sealed", body: sealJson(session!, message as unknown as Record<string, unknown>) }),
      onProgress: setHistory,
    });
  }

  async function approve(envelope: PairingEnvelope, accessToken?: () => Promise<string>) {
    const { id, token, box, session } = current!;
    set({ phase: envelope.account ? "signing_in" : "waiting_ready", device: device! });
    let sender: ReturnType<typeof createHistorySender> | null = null;
    let snap = new Map<string, Map<string, number>>();
    if (options.history) {
      // Recording starts before the positions are read, so nothing lands between the two unseen.
      tail.start();
      snap = await positions(envelope);
      sender = startHistory(options.history);
      const chunks = await sender.forEnvelope(Math.min(clock.now() + ENVELOPE_BUDGET_MS, deadline - 10_000));
      envelope = { ...envelope, history: { key: sender.key, manifest: { v: 1, chunks } } };
    }
    await relay.post(id, token, { type: "sealed", body: base64Url(session!.seal(encodePairingEnvelope(envelope))) });

    if (envelope.account && accessToken) {
      const message = await box.next(abort.signal, clock.now() + approvalMs);
      if (!message) throw new PairingEnded("timed_out");
      const userCode = String(openJson(session!, message, "user_code").userCode ?? "");
      if (!(await approveExtension(envelope.account.issuer, userCode, accessToken))) {
        const url = `${envelope.account.issuer.replace(/\/+$/, "")}/device?user_code=${encodeURIComponent(userCode)}`;
        set({ phase: "browser", device: device!, url });
      }
    }
    if (state.phase === "signing_in") set({ phase: "waiting_ready", device: device! });

    const ready = openJson(session!, await box.next(abort.signal), "ready");
    const list = Array.isArray(ready.devices) ? ready.devices : [];
    const named = list.filter(
      (d): d is PairedServerDevice => typeof d?.host === "string" && typeof d?.deviceId === "string",
    );
    sender?.startPaging();
    const added = await addEverywhere(named);
    if (!sender) {
      set({ phase: "done", device: device!, added });
      session!.close();
      return void (await closeQuietly());
    }

    set({ phase: "sending", device: device!, added });
    await sender.send(tail.take(snap, added), false);
    await clock.sleep(options.lateWindowMs ?? HISTORY_LATE_WINDOW_MS, abort.signal);
    await sender.send(tail.take(snap, added), true);
    // N closes the session once it has every chunk; closing here would delete them.
    set({ phase: "done", device: device!, added });
    session!.close();
  }

  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get history() {
      return history;
    },
    subscribeHistory(listener) {
      historyListeners.add(listener);
      return () => void historyListeners.delete(listener);
    },
    noteMessage: (message) => tail.note(message),
    claim(input) {
      if (state.phase !== "idle") throw new Error("This pairing has claimed a session already.");
      claim(input).catch(fail);
    },
    approve(envelope, accessToken) {
      if (state.phase !== "confirming") throw new Error("Nothing to approve.");
      if (envelope.account && !accessToken) throw new Error("An account needs an access token to approve with.");
      if (clock.now() > state.deadline) return void end("timed_out");
      confirming?.abort();
      approve(envelope, accessToken).catch(fail);
    },
    deny: () => end("cancelled"),
    mismatch: () => end("mismatch"),
    cancel: () => end("cancelled"),
  };
}
