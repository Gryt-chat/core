import type { PairingServer } from "@gryt/crypto";

/** Where A leaves sealed history chunks and N picks them up: one of the user's own servers, never Gryt's relay (GRYT-2055). */
export interface HistoryChunkStore {
  put(n: number, sealed: Uint8Array, signal?: AbortSignal): Promise<void>;
  get(n: number, signal?: AbortSignal): Promise<Uint8Array>;
  delete(n: number): Promise<void>;
}

/** "network" is retried, "full" ends the snapshot early, "missing" is a chunk the store doesn't have. */
export class HistoryStoreError extends Error {
  readonly code: "network" | "full" | "missing" | "refused";
  constructor(code: HistoryStoreError["code"], message = `History store: ${code}`) {
    super(message);
    this.name = "HistoryStoreError";
    this.code = code;
  }
}

/** A's choice of a server both devices are on that will hold the history, or null when none will. */
export type HistoryStoreChooser = (
  servers: PairingServer[],
) => Promise<{ host: string; transfer: string; store: HistoryChunkStore } | null>;

/** N's way into the store the envelope names. */
export type HistoryStoreOpener = (host: string, transfer: string) => HistoryChunkStore;
