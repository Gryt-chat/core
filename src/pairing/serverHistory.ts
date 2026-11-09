import { base64Url } from "@gryt/crypto";
import { randomBytes } from "@noble/hashes/utils.js";

import type { HistoryChunkStore, HistoryStoreChooser, HistoryStoreOpener } from "./historyStore.js";
import { HistoryStoreError } from "./historyStore.ts";
import { systemClock } from "./channel.ts";
import type { PairingClock } from "./interfaces.js";

/* The history store both apps use: one of the user's own servers, through /api/link-history (GRYT-2055). */

/** `fetch`, cut down to what the store uses. A body here is bytes, which PairingFetch can't send. */
export type HistoryFetch = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: Uint8Array; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<{ linkHistory?: boolean } | null>; arrayBuffer(): Promise<ArrayBuffer> }>;

/** How this device reaches a server: its address and, once it has joined, its token. */
export interface ServerAccess {
  base(host: string): string;
  token(host: string): Promise<string | null> | string | null;
}

/** The new device only gets a token once it has joined, which can trail the envelope. */
const TOKEN_WAIT_MS = 90_000;

export function historyStoreError(status: number): HistoryStoreError {
  if (status === 404) return new HistoryStoreError("missing");
  if (status === 413 || status === 429) return new HistoryStoreError("full");
  // A stale token gets refreshed by the connection, and a server error may pass: both are worth another try.
  if (status === 401 || (status >= 500 && status !== 503)) return new HistoryStoreError("network");
  return new HistoryStoreError("refused");
}

export function serverHistoryStore(
  access: ServerAccess,
  host: string,
  transfer: string,
  fetch: HistoryFetch,
  clock: PairingClock = systemClock,
): HistoryChunkStore {
  async function tokenFor(signal?: AbortSignal): Promise<string> {
    for (const start = clock.now(); ; await clock.sleep(1000, signal)) {
      const token = await access.token(host);
      if (token) return token;
      if (clock.now() - start > TOKEN_WAIT_MS) throw new HistoryStoreError("refused", `No session on ${host} to fetch history from.`);
    }
  }
  async function call(method: string, n: number, signal?: AbortSignal, body?: Uint8Array) {
    const headers: Record<string, string> = { authorization: `Bearer ${await tokenFor(signal)}` };
    if (body) headers["content-type"] = "application/octet-stream";
    const url = `${access.base(host)}/api/link-history/${transfer}/${n}`;
    const res = await fetch(url, { method, headers, body, signal }).catch(() => {
      throw new HistoryStoreError("network");
    });
    if (res.status < 200 || res.status > 299) throw historyStoreError(res.status);
    return res;
  }
  return {
    put: async (n, sealed, signal) => void (await call("PUT", n, signal, sealed)),
    get: async (n, signal) => new Uint8Array(await (await call("GET", n, signal)).arrayBuffer()),
    delete: async (n) => void (await call("DELETE", n)),
  };
}

/** The first server this device is signed in to that says it holds linked devices' history. */
export function chooseHistoryServer(access: ServerAccess, fetch: HistoryFetch, clock: PairingClock = systemClock): HistoryStoreChooser {
  return async (servers) => {
    for (const { host } of servers) {
      if (!(await access.token(host))) continue;
      const info = await fetch(`${access.base(host)}/info`, { method: "GET" })
        .then((r) => (r.status === 200 ? r.json() : null))
        .catch(() => null);
      if (info?.linkHistory !== true) continue;
      const transfer = base64Url(randomBytes(18));
      return { host, transfer, store: serverHistoryStore(access, host, transfer, fetch, clock) };
    }
    return null;
  };
}

/** The new device's side: the server the envelope names. */
export function openServerHistory(access: ServerAccess, fetch: HistoryFetch, clock: PairingClock = systemClock): HistoryStoreOpener {
  return (host, transfer) => serverHistoryStore(access, host, transfer, fetch, clock);
}
