import { base64Url, base64UrlDecode } from "@gryt/crypto";

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
  /** A: one sealed history chunk into slot `n`. */
  putChunk(id: string, token: string, n: number, sealed: Uint8Array, signal?: AbortSignal): Promise<void>;
  /** N: the chunk in slot `n`. A 404 means the relay doesn't have it. */
  getChunk(id: string, token: string, n: number, signal?: AbortSignal): Promise<Uint8Array>;
  /** N: done with slot `n`. */
  deleteChunk(id: string, token: string, n: number): Promise<void>;
}

/** The relay's HTTP API as auth#45 built it, under `{origin}/api/v1/pairing`. The chunk
    calls follow docs/pairing-design.md; the relay doesn't have them yet (GRYT-1591). */
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
    putChunk: async (id, token, n, sealed, signal) =>
      void (await call("PUT", `${path(id)}/chunks/${n}`, { body: base64Url(sealed) }, token, signal)),
    getChunk: async (id, token, n, signal) => {
      const res = await call("GET", `${path(id)}/chunks/${n}`, undefined, token, signal);
      if (typeof res.body !== "string") throw new PairingRelayError(200, "invalid_body");
      try {
        return base64UrlDecode(res.body);
      } catch {
        throw new PairingRelayError(200, "invalid_body");
      }
    },
    deleteChunk: async (id, token, n) => void (await call("DELETE", `${path(id)}/chunks/${n}`, undefined, token)),
  };
}
