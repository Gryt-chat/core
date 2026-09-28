import { base64Url, base64UrlDecode, type PairingSession } from "@gryt/crypto";

import type { PairingClock, PairingEndReason } from "./interfaces.js";
import { PairingRelayError } from "./relayClient.ts";
import type { PairingRelay, RelayMessage } from "./relayClient.js";

/** Thrown inside a pairing to stop it with a reason the screen can show. */
export class PairingEnded extends Error {
  readonly reason: PairingEndReason;
  constructor(reason: PairingEndReason) {
    super(`Pairing ended: ${reason}`);
    this.reason = reason;
  }
}

export const systemClock: PairingClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
    }),
};

export function reasonFor(error: unknown): PairingEndReason {
  if (error instanceof PairingEnded) return error.reason;
  if (!(error instanceof PairingRelayError)) return "relay_error";
  if (error.status === 410) return error.code === "closed" ? "cancelled_by_other" : "expired";
  if (error.code === "already_claimed") return "already_claimed";
  if (error.status === 404) return "unknown_code";
  if (error.status === 429) return "rate_limited";
  return "relay_error";
}

export function sealJson(session: PairingSession, value: Record<string, unknown>): string {
  return base64Url(session.seal(new TextEncoder().encode(JSON.stringify(value))));
}

/** The next sealed message as JSON with a `t`, or a throw that ends the pairing as tampered. */
export function openJson(session: PairingSession, message: RelayMessage | null, t?: string): Record<string, unknown> {
  try {
    if (message?.type !== "sealed" || !message.body) throw new Error();
    const value: unknown = JSON.parse(new TextDecoder().decode(session.open(base64UrlDecode(message.body))));
    const got = value && typeof value === "object" ? (value as { t?: unknown }).t : undefined;
    if (typeof got === "string" && (t === undefined || got === t)) return value as Record<string, unknown>;
  } catch {
    // Falls through: whatever went wrong, the other side can't be trusted with the rest.
  }
  throw new PairingEnded("tampered");
}

const MAX_NETWORK_RETRIES = 5;

/** The other side's messages in order, long-polling the relay. `next` gives null once `deadline` passes. */
export function mailbox(relay: PairingRelay, id: string, token: string, clock: PairingClock) {
  let after = 0;
  const queue: RelayMessage[] = [];
  return {
    async next(signal: AbortSignal, deadline?: number): Promise<RelayMessage | null> {
      for (let failures = 0; ; ) {
        const queued = queue.shift();
        if (queued) return queued;
        const left = deadline === undefined ? 25_000 : deadline - clock.now();
        if (left <= 0) return null;
        try {
          for (const m of await relay.poll(id, token, after, Math.min(25, Math.ceil(left / 1000)), signal)) {
            if (m.seq > after) (queue.push(m), (after = m.seq));
          }
          failures = 0;
        } catch (e) {
          if (!(e instanceof PairingRelayError && e.code === "network") || ++failures > MAX_NETWORK_RETRIES) throw e;
          await clock.sleep(2000, signal);
        }
      }
    },
  };
}
