import type { PairingFetch } from "./interfaces.js";

/** A refusal from the relay: its status and the `error` it sent, or "network" when nothing came back. */
export class PairingRelayError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`Pairing relay: ${status} ${code}`);
    this.name = "PairingRelayError";
    this.status = status;
    this.code = code;
  }
}

export interface RelayMessage {
  seq: number;
  type: "claim" | "reveal" | "sealed";
  pkA?: string;
  pkN?: string;
  body?: string;
}

export interface PairingRelay {
  create(commit: string): Promise<{ id: string; code: string; token: string; expiresAt: string }>;
  claim(
    by: { id: string } | { code: string },
    pkA: string,
  ): Promise<{ id: string; token: string; commit: string; location: string | null; yourLocation: string | null }>;
  post(id: string, token: string, message: { type: "reveal"; pkN: string } | { type: "sealed"; body: string }): Promise<void>;
  /** The other side's messages after `after`, waiting up to `waitSeconds`. Asking past one acks it. */
  poll(id: string, token: string, after: number, waitSeconds: number, signal?: AbortSignal): Promise<RelayMessage[]>;
  close(id: string, token: string): Promise<void>;
}

/** The relay's HTTP API as auth#45 built it, under `{origin}/api/v1/pairing`. */
export function createPairingRelay(origin: string, fetch: PairingFetch): PairingRelay {
  const base = `${origin.replace(/\/+$/, "")}/api/v1/pairing/sessions`;

  async function call(method: string, path: string, body?: unknown, token?: string, signal?: AbortSignal) {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Awaited<ReturnType<PairingFetch>>;
    try {
      res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new PairingRelayError(0, "network");
    }
    if (res.status === 204) return {};
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status >= 400 || !json) throw new PairingRelayError(res.status, String(json?.error ?? "unknown"));
    return json;
  }

  const path = (id: string) => `/${encodeURIComponent(id)}`;
  return {
    create: async (commit) => (await call("POST", "", { commit })) as never,
    claim: async (by, pkA) => (await call("POST", "/claim", { ...by, pkA })) as never,
    post: async (id, token, message) => void (await call("POST", `${path(id)}/messages`, message, token)),
    poll: async (id, token, after, waitSeconds, signal) => {
      const res = await call("GET", `${path(id)}/messages?after=${after}&wait=${waitSeconds}`, undefined, token, signal);
      return (Array.isArray(res.messages) ? res.messages : []) as RelayMessage[];
    },
    close: async (id, token) => void (await call("DELETE", path(id), undefined, token)),
  };
}
