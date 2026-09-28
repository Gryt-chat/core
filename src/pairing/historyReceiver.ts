import { openHistoryChunk, parseHistoryChunkEntry, type HistoryChunkEntry, type HistoryRecord } from "@gryt/crypto";

import { PairingEnded } from "./channel.ts";
import { emptyProgress, type ListedChunk } from "./historySender.ts";
import type { HistoryProgress, HistorySink, PairingClock } from "./interfaces.js";
import { PairingRelayError, type PairingRelay } from "./relayClient.ts";

const MAX_NETWORK_RETRIES = 5;

export interface HistoryReceiverOptions {
  relay: PairingRelay;
  id: string;
  token: string;
  key: Uint8Array;
  sink: HistorySink;
  clock: PairingClock;
  signal: AbortSignal;
  onProgress(progress: HistoryProgress): void;
}

const messageKey = (r: HistoryRecord) => JSON.stringify([r.scope, r.conversationId, r.messageId]);

/** N: fetches each listed chunk newest first, checks it against its entry, and stores each message once. */
export function createHistoryReceiver(options: HistoryReceiverOptions) {
  const { relay, id, token, key, sink, clock, signal } = options;
  const progress = emptyProgress();
  const pending = new Map<number, HistoryChunkEntry>();
  const slots = new Set<number>();
  const chunkIds = new Set<string>();
  const stored = new Set<string>();
  let final = false;
  let stopped = false;
  let wake: (() => void) | null = null;

  const report = () => options.onProgress({ ...progress });
  const nudge = () => (wake?.(), (wake = null));

  function add(n: number, value: unknown) {
    let entry: HistoryChunkEntry;
    try {
      entry = parseHistoryChunkEntry(value);
    } catch {
      throw new PairingEnded("tampered");
    }
    // A slot or chunk listed twice is either a replay or a bug; neither gets a second look.
    if (!Number.isSafeInteger(n) || n < 0 || slots.has(n) || chunkIds.has(entry.id)) throw new PairingEnded("tampered");
    slots.add(n);
    chunkIds.add(entry.id);
    pending.set(n, entry);
    progress.listed++;
  }

  async function fetchChunk(n: number): Promise<Uint8Array | "missing" | "gone"> {
    for (let failures = 0; ; ) {
      try {
        return await relay.getChunk(id, token, n, signal);
      } catch (e) {
        if (e instanceof PairingRelayError && e.status === 404) return "missing";
        if (e instanceof PairingRelayError && e.status === 410) return "gone";
        if (!(e instanceof PairingRelayError && e.code === "network") || ++failures > MAX_NETWORK_RETRIES) throw e;
        await clock.sleep(2000, signal);
      }
    }
  }

  /** The newest listed chunk, so recent conversations fill in first. */
  function next(): [number, HistoryChunkEntry] | null {
    let best: [number, HistoryChunkEntry] | null = null;
    for (const item of pending) if (!best || item[1].last > best[1].last) best = item;
    return best;
  }

  function abandon() {
    progress.missing += pending.size;
    pending.clear();
    stopped = true;
    report();
    nudge();
  }

  async function run() {
    for (;;) {
      if (signal.aborted || stopped) return;
      const item = next();
      if (!item) {
        if (final) return void ((progress.complete = true), report());
        await new Promise<void>((resolve) => (wake = resolve));
        continue;
      }
      const [n, entry] = item;
      const sealed = await fetchChunk(n);
      if (sealed === "gone") return abandon();
      pending.delete(n);
      if (sealed === "missing") {
        progress.missing++;
        report();
        continue;
      }
      let records: HistoryRecord[];
      try {
        records = openHistoryChunk(key, entry, sealed);
      } catch {
        progress.refused++;
        report();
        continue;
      }
      const fresh = records.filter((r) => !stored.has(messageKey(r)));
      if (fresh.length > 0) await sink.put(fresh);
      for (const r of fresh) stored.add(messageKey(r));
      progress.chunks++;
      progress.messages += fresh.length;
      progress.oldest = Math.min(progress.oldest ?? entry.first, entry.first);
      report();
      relay.deleteChunk(id, token, n).catch(() => undefined);
    }
  }

  signal.addEventListener("abort", nudge, { once: true });
  const done = run();
  done.catch(() => undefined);

  return {
    done,
    progress: () => ({ ...progress }),
    /** The envelope's manifest: slots 0 onwards, in order. */
    listManifest(chunks: readonly HistoryChunkEntry[]) {
      chunks.forEach((entry, n) => add(n, entry));
      report();
      nudge();
    },
    /** One of A's history messages. Throws `tampered` for anything off. */
    list(message: Record<string, unknown>) {
      if (final || !Array.isArray(message.chunks)) throw new PairingEnded("tampered");
      for (const chunk of message.chunks as ListedChunk[]) add(chunk?.n, chunk);
      if (Number.isSafeInteger(message.total)) progress.total = message.total as number;
      if (message.truncated === true) progress.truncated = true;
      if (message.final === true) final = true;
      report();
      nudge();
    },
    /** The session is gone: whatever is still listed won't arrive. */
    abandon,
  };
}
