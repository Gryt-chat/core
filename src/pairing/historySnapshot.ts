import type { HistoryRecord } from "@gryt/crypto";

import type { HistoryArchive, HistoryConversation, HistoryCursor } from "./interfaces.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const dayOf = (sentAt: number) => Math.floor(sentAt / DAY_MS);

/** Negative when `a` is newer: by time, then by message id, the same order the archive pages in. */
export function newerFirst(a: HistoryCursor, b: HistoryCursor): number {
  return b.sentAt - a.sentAt || (a.messageId < b.messageId ? 1 : a.messageId > b.messageId ? -1 : 0);
}

interface Walk extends HistoryConversation {
  buffer: HistoryRecord[];
  before?: HistoryCursor;
  exhausted: boolean;
}

/** A's archive one UTC day at a time, newest day first across every conversation and server. */
export async function* archiveByDay(archive: HistoryArchive, pageSize = 500): AsyncGenerator<HistoryRecord[]> {
  const walks: Walk[] = (await archive.conversations()).map((c) => ({ ...c, buffer: [], exhausted: false }));

  const fill = async (w: Walk) => {
    if (w.buffer.length > 0 || w.exhausted) return;
    const page = await archive.page(w.scope, w.conversationId, { before: w.before, limit: pageSize });
    // Only what's older than the cursor and in this conversation, so a sloppy page can't loop forever.
    const fresh = page
      .filter((r) => r.scope === w.scope && r.conversationId === w.conversationId)
      .filter((r) => !w.before || newerFirst(r, w.before) > 0)
      .sort(newerFirst);
    w.buffer = fresh;
    w.before = fresh.at(-1) ?? w.before;
    w.exhausted = fresh.length === 0 || page.length < pageSize;
  };

  for (;;) {
    await Promise.all(walks.map(fill));
    const heads = walks.filter((w) => w.buffer.length > 0);
    if (heads.length === 0) return;
    const day = Math.max(...heads.map((w) => dayOf(w.buffer[0].sentAt)));
    const out: HistoryRecord[] = [];
    for (const w of heads) {
      for (;;) {
        let i = 0;
        while (i < w.buffer.length && dayOf(w.buffer[i].sentAt) === day) out.push(w.buffer[i++]);
        w.buffer = w.buffer.slice(i);
        if (w.buffer.length > 0) break;
        await fill(w);
        if (w.buffer.length === 0) break;
      }
    }
    yield out;
  }
}
