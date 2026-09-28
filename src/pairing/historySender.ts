import {
  generateHistoryKey,
  planHistoryChunks,
  sealHistoryChunk,
  type HistoryChunkEntry,
  type HistoryRecord,
} from "@gryt/crypto";

import type { MlsOwnDeviceAdd } from "../mls/interfaces.js";
import { archiveByDay } from "./historySnapshot.ts";
import type { HistoryArchive, HistoryNotedMessage, HistoryProgress, PairingClock } from "./interfaces.js";
import { PairingRelayError, type PairingRelay } from "./relayClient.ts";

/** The relay's 256 MiB per session, less room for the tail. */
export const HISTORY_SNAPSHOT_MAX_BYTES = 248 * 1024 * 1024;
/** Entries in the envelope's manifest and in each later message, which keep under 256 and 64 KiB. */
export const HISTORY_ENVELOPE_ENTRIES = 400;
export const HISTORY_PAGE_ENTRIES = 180;
/** The relay allows 64 messages a session, both sides together; N and the envelope use five. */
const HISTORY_MAX_CHUNKS = HISTORY_ENVELOPE_ENTRIES + 40 * HISTORY_PAGE_ENTRIES;
const MAX_NETWORK_RETRIES = 5;

/** One chunk as a history message lists it: its relay slot and its manifest entry. */
export interface ListedChunk extends HistoryChunkEntry {
  n: number;
}

/** What A posts after the envelope, sealed. `final` says nothing more is coming. */
export interface HistoryMessage {
  t: "history";
  chunks: ListedChunk[];
  total?: number;
  truncated?: boolean;
  final?: boolean;
}

export const emptyProgress = (): HistoryProgress => ({
  messages: 0, total: null, chunks: 0, listed: 0, missing: 0, refused: 0, truncated: false, oldest: null, complete: false,
});

export interface HistorySenderOptions {
  relay: PairingRelay;
  id: string;
  token: string;
  archive: HistoryArchive;
  clock: PairingClock;
  signal: AbortSignal;
  /** Seals and posts one message. The sender calls it one at a time, in order. */
  post(message: HistoryMessage): Promise<void>;
  onProgress(progress: HistoryProgress): void;
  maxBytes?: number;
}

/** A: seals the archive into chunks newest first, uploads each, then lists it to N. */
export function createHistorySender(options: HistorySenderOptions) {
  const { relay, id, token, clock, signal } = options;
  const key = generateHistoryKey();
  const maxBytes = options.maxBytes ?? HISTORY_SNAPSHOT_MAX_BYTES;
  const progress = emptyProgress();
  /** Uploaded, not yet listed. */
  const unlisted: ListedChunk[] = [];
  let slot = 0;
  let bytes = 0;
  let paging = false;
  let walked = false;
  let posting: Promise<void> = Promise.resolve();
  let finished = false;

  const report = () => options.onProgress({ ...progress });

  async function put(n: number, sealed: Uint8Array) {
    for (let failures = 0; ; ) {
      try {
        return await relay.putChunk(id, token, n, sealed, signal);
      } catch (e) {
        if (!(e instanceof PairingRelayError && e.code === "network") || ++failures > MAX_NETWORK_RETRIES) throw e;
        await clock.sleep(2000, signal);
      }
    }
  }

  /** False once the cap or the relay says no more. */
  async function upload(records: HistoryRecord[], capped: boolean): Promise<boolean> {
    for (const chunk of planHistoryChunks(records)) {
      if (signal.aborted) throw new Error("History transfer cancelled.");
      const { entry, sealed } = sealHistoryChunk(key, chunk);
      if (capped && (bytes + sealed.length > maxBytes || slot >= HISTORY_MAX_CHUNKS)) return false;
      const n = slot++;
      try {
        await put(n, sealed);
      } catch (e) {
        // The relay's own caps: whatever didn't fit stays behind, the same as our own cap.
        if (capped && e instanceof PairingRelayError && (e.status === 507 || e.code === "busy")) return false;
        throw e;
      }
      bytes += sealed.length;
      unlisted.push({ n, ...entry });
      progress.chunks++;
      progress.messages += entry.count;
      progress.oldest = Math.min(progress.oldest ?? entry.first, entry.first);
      report();
    }
    return true;
  }

  async function walk() {
    const conversations = await options.archive.conversations();
    if (conversations.every((c) => typeof c.count === "number")) {
      progress.total = conversations.reduce((sum, c) => sum + (c.count ?? 0), 0);
      report();
    }
    for await (const day of archiveByDay(options.archive)) {
      if (!(await upload(day, true))) {
        progress.truncated = true;
        break;
      }
      if (paging) void flush(false, false);
    }
    walked = true;
    if (paging) void flush(false);
  }
  const snapshot = walk();
  snapshot.catch(() => undefined);

  /** Lists what's uploaded, a page per message. `partial` false keeps back a page that isn't full. */
  function flush(final: boolean, partial = true) {
    const pages: ListedChunk[][] = [];
    while (unlisted.length >= (partial ? 1 : HISTORY_PAGE_ENTRIES)) pages.push(unlisted.splice(0, HISTORY_PAGE_ENTRIES));
    if (final && pages.length === 0) pages.push([]);
    pages.forEach((chunks, i) => {
      const message: HistoryMessage = { t: "history", chunks };
      if (progress.total !== null) message.total = progress.total;
      if (progress.truncated) message.truncated = true;
      if (final && i === pages.length - 1) message.final = true;
      posting = posting.then(async () => {
        await options.post(message);
        progress.listed += chunks.length;
        if (message.final) progress.complete = true;
        report();
      });
    });
    posting.catch(() => undefined);
    return posting;
  }

  return {
    key,
    progress: () => ({ ...progress }),
    /** Waits until `until` or the end of the snapshot, whichever is first, and hands over what's up. */
    async forEnvelope(until: number): Promise<HistoryChunkEntry[]> {
      const wait = new AbortController();
      const stop = () => wait.abort();
      signal.addEventListener("abort", stop, { once: true });
      try {
        await Promise.race([snapshot, clock.sleep(Math.max(0, until - clock.now()), wait.signal).catch(() => undefined)]);
      } finally {
        wait.abort();
        signal.removeEventListener("abort", stop);
      }
      const listed = unlisted.splice(0, HISTORY_ENVELOPE_ENTRIES);
      progress.listed += listed.length;
      report();
      return listed.map(({ n: _n, ...entry }) => entry);
    },
    /** After N's "ready": list what's waiting, and keep listing as pages fill. */
    startPaging() {
      paging = true;
      void flush(false, walked);
    },
    /** The tail: records past the snapshot. `final` waits for the snapshot and says that's all. */
    async send(records: HistoryRecord[], final: boolean) {
      if (finished) throw new Error("This history transfer has finished.");
      if (final) {
        await snapshot;
        finished = true;
      }
      if (records.length > 0) await upload(records, false);
      await flush(final);
    },
  };
}

/**
 * A's record of MLS messages it archived during the transfer. The tail is every one past the
 * snapshot that N can't read: before N's add, or sent in an older epoch that landed after it.
 */
export function createTailRecorder() {
  let on = false;
  let noted: HistoryNotedMessage[] = [];
  return {
    start: () => void (on = true),
    note(message: HistoryNotedMessage) {
      if (on) noted.push(message);
    },
    /** Everything noted since the last call that N needs. `snap` and `added` are per host. */
    take(snap: Map<string, Map<string, number>>, added: Record<string, MlsOwnDeviceAdd[]>): HistoryRecord[] {
      const out: HistoryRecord[] = [];
      for (const m of noted) {
        if (m.seq <= (snap.get(m.host)?.get(m.conversationId) ?? -1)) continue;
        const add = added[m.host]?.find((a) => a.conversationId === m.conversationId)?.add ?? null;
        if (add && m.seq >= add.seq && m.epoch >= add.epoch) continue;
        out.push(m.record);
      }
      noted = [];
      return out;
    },
  };
}
