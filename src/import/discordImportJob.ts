import type { SealedAttachmentKey } from "@gryt/crypto";

import { importBatches } from "../mls/content.ts";
import type { MlsDmContent, MlsImportEntry } from "../mls/content.js";
import type { DiscordPackageMessage } from "./discordPackage.js";

export interface ImportFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

/** Where downloads wait until they're uploaded: Cache Storage on the desktop, files on the phone. */
export interface ImportFileStore {
  has(url: string): Promise<boolean>;
  put(url: string, file: Omit<ImportFile, "name">): Promise<void>;
  take(url: string): Promise<Omit<ImportFile, "name"> | null>;
  drop(url: string): Promise<void>;
}

/** What the job needs from the app. Each app supplies its own, and a test supplies fakes. */
export interface ImportDeps {
  send: (content: MlsDmContent) => Promise<void>;
  /** Null when Discord won't hand it over (expired, gone, refused). */
  download: (url: string) => Promise<Omit<ImportFile, "name"> | null>;
  upload: (file: ImportFile) => Promise<{ id: string; key: SealedAttachmentKey }>;
  store: ImportFileStore;
  sleep: (ms: number) => Promise<void>;
  newId: () => string;
}

export interface ImportProgress {
  messages: { done: number; total: number };
  downloaded: { done: number; total: number };
  sent: { done: number; total: number };
  missing: number;
  bytes: number;
  startedAt: number;
}

export interface ImportControl {
  paused: () => boolean;
  stopped: () => boolean;
}

const DOWNLOADS_AT_ONCE = 4;
/** `mls:send` allows about one send every two seconds sustained (RL_SEND in the server). */
const SEND_GAP_MS = 2_000;
const FILE_BATCH = 20;

export const importId = (discordId: string) => `discord-${discordId}`;

function nameOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || "file");
  } catch {
    return "file";
  }
}

/** Messages without files first, then every file downloaded to the store, then the messages that carry files. */
export async function runDiscordImport(
  messages: DiscordPackageMessage[],
  deps: ImportDeps,
  control: ImportControl,
  report: (p: ImportProgress) => void,
): Promise<ImportProgress> {
  const withFiles = messages.filter((m) => m.attachments.length > 0);
  const urls = [...new Set(withFiles.flatMap((m) => m.attachments))];
  const p: ImportProgress = {
    messages: { done: 0, total: messages.length },
    downloaded: { done: 0, total: urls.length },
    sent: { done: 0, total: urls.length },
    missing: 0,
    bytes: 0,
    startedAt: Date.now(),
  };
  const tick = () => report({ ...p, messages: { ...p.messages }, downloaded: { ...p.downloaded }, sent: { ...p.sent } });
  tick();
  const hold = async () => {
    while (control.paused() && !control.stopped()) await deps.sleep(500);
  };
  const sendAll = async (entries: MlsImportEntry[]) => {
    for (const batch of importBatches(entries, deps.newId)) {
      await hold();
      if (control.stopped()) return;
      await deps.send(batch);
      p.messages.done += batch.entries.length;
      tick();
      await deps.sleep(SEND_GAP_MS);
    }
  };

  await sendAll(messages.filter((m) => m.attachments.length === 0).map((m) => ({ id: importId(m.discordId), sentAt: m.sentAt, text: m.text })));

  const missing = new Set<string>();
  let next = 0;
  const worker = async () => {
    while (!control.stopped()) {
      await hold();
      if (next >= urls.length) break;
      const url = urls[next++];
      if (!(await deps.store.has(url))) {
        const file = await deps.download(url).catch(() => null);
        if (file) {
          p.bytes += file.bytes.length;
          await deps.store.put(url, file);
        } else {
          missing.add(url);
          p.missing = missing.size;
        }
      }
      p.downloaded.done++;
      tick();
    }
  };
  await Promise.all(Array.from({ length: DOWNLOADS_AT_ONCE }, worker));

  const uploaded = new Map<string, { id: string; key: SealedAttachmentKey }>();
  let pending: MlsImportEntry[] = [];
  for (const m of withFiles) {
    if (control.stopped()) break;
    const attachments: Record<string, SealedAttachmentKey> = {};
    for (const url of m.attachments) {
      await hold();
      let up = uploaded.get(url);
      const stored = up || missing.has(url) ? null : await deps.store.take(url);
      if (stored) {
        up = await deps.upload({ name: nameOf(url), ...stored });
        uploaded.set(url, up);
        await deps.store.drop(url);
      }
      if (up) attachments[up.id] = up.key;
      p.sent.done++;
      tick();
    }
    const lost = m.attachments.length - Object.keys(attachments).length;
    const note = lost ? `${lost === 1 ? "A file" : `${lost} files`} from Discord couldn’t be downloaded.` : "";
    const text = [m.text, note].filter(Boolean).join("\n");
    pending.push({ id: importId(m.discordId), sentAt: m.sentAt, text, ...(Object.keys(attachments).length ? { attachments } : {}) });
    if (pending.length >= FILE_BATCH) {
      await sendAll(pending);
      pending = [];
    }
  }
  if (pending.length) await sendAll(pending);
  tick();
  return p;
}
