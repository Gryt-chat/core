import type { SealedAttachmentKey } from "@gryt/crypto";

import { encodeImportBundle, importBatches } from "../mls/content.ts";
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
  /** Null when Discord won't hand it over (expired, gone, refused). `retryAfterMs` when it answers 429. */
  download: (url: string) => Promise<Omit<ImportFile, "name"> | { retryAfterMs: number } | null>;
  /** `retryAfterMs` when the server answers 429, `tooLarge` when it refuses the file's size. */
  upload: (file: ImportFile) => Promise<{ id: string; key: SealedAttachmentKey } | { retryAfterMs: number } | { tooLarge: true }>;
  store: ImportFileStore;
  sleep: (ms: number) => Promise<void>;
  newId: () => string;
  /** Downloads and uploads running together. A phone holding each file in memory wants fewer. */
  transfersAtOnce?: number;
  /** Send a big import's text as one sealed upload. Only for apps that read `import_bundle`. */
  bundles?: boolean;
}

export interface ImportProgress {
  messages: { done: number; total: number };
  downloaded: { done: number; total: number };
  sent: { done: number; total: number };
  missing: number;
  /** Files this server won't take, each left out with a note on its message. */
  tooLarge: number;
  bytes: number;
  startedAt: number;
}

export interface ImportControl {
  paused: () => boolean;
  stopped: () => boolean;
}

const TRANSFERS_AT_ONCE = 16;
/** `mls:send` allows about one send every two seconds sustained (RL_SEND in the server). */
const SEND_GAP_MS = 2_000;
const FILE_BATCH = 20;
/* A batch holds up to 200, and one send is the point where a bundle starts saving time. */
const BUNDLE_ABOVE = 200;
const DOWNLOAD_RETRIES = 5;
/* A server allows 30 uploads a minute with a ban after, so a big import waits many times over. */
const UPLOAD_RETRIES = 200;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
const DEFAULT_RATE_LIMIT_WAIT_MS = 5_000;

/** For a 429's Retry-After header. Only the seconds form: anything else gets the default wait. */
export function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  return header && seconds >= 0 ? seconds * 1000 : DEFAULT_RATE_LIMIT_WAIT_MS;
}

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
    tooLarge: 0,
    bytes: 0,
    startedAt: Date.now(),
  };
  const tick = () => report({ ...p, messages: { ...p.messages }, downloaded: { ...p.downloaded }, sent: { ...p.sent } });
  tick();
  const hold = async () => {
    while (control.paused() && !control.stopped()) await deps.sleep(500);
  };
  let uploadClearAt = 0;
  const uploadFile = async (file: ImportFile) => {
    for (let attempt = 0; attempt <= UPLOAD_RETRIES && !control.stopped(); attempt++) {
      const wait = uploadClearAt - Date.now();
      if (wait > 0) await deps.sleep(wait);
      const got = await deps.upload(file);
      if (!("retryAfterMs" in got)) return got;
      uploadClearAt = Math.max(uploadClearAt, Date.now() + Math.min(got.retryAfterMs, MAX_RATE_LIMIT_WAIT_MS));
    }
    if (control.stopped()) return null;
    throw new Error("The server kept refusing uploads.");
  };
  /* False when the bundle can't go up, so the batches carry it. */
  const sendBundle = async (entries: MlsImportEntry[]) => {
    await hold();
    const up = await uploadFile({ name: "discord-import.json", type: "application/json", bytes: encodeImportBundle(entries) });
    if (!up || "tooLarge" in up) return false;
    await deps.send({ type: "import_bundle", id: deps.newId(), source: "discord", attachments: { [up.id]: up.key } });
    p.messages.done += entries.length;
    tick();
    return true;
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

  const textOnly = messages.filter((m) => m.attachments.length === 0).map((m) => ({ id: importId(m.discordId), sentAt: m.sentAt, text: m.text }));
  if (!(deps.bundles && textOnly.length > BUNDLE_ABOVE && !control.stopped() && (await sendBundle(textOnly)))) await sendAll(textOnly);

  const missing = new Set<string>();
  let clearAt = 0;
  const downloadFile = async (url: string) => {
    for (let attempt = 0; attempt <= DOWNLOAD_RETRIES && !control.stopped(); attempt++) {
      const wait = clearAt - Date.now();
      if (wait > 0) await deps.sleep(wait);
      const got = await deps.download(url).catch(() => null);
      if (!got || !("retryAfterMs" in got)) return got;
      // Every worker waits, or the other three spend the wait getting 429s too.
      clearAt = Math.max(clearAt, Date.now() + Math.min(got.retryAfterMs, MAX_RATE_LIMIT_WAIT_MS));
    }
    return null;
  };
  const eachAtOnce = async (run: (url: string) => Promise<void>) => {
    let next = 0;
    await Promise.all(Array.from({ length: deps.transfersAtOnce ?? TRANSFERS_AT_ONCE }, async () => {
      while (!control.stopped()) {
        await hold();
        if (next >= urls.length) break;
        await run(urls[next++]);
      }
    }));
  };
  await eachAtOnce(async (url) => {
    if (!(await deps.store.has(url))) {
      const file = await downloadFile(url);
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
  });

  const uploaded = new Map<string, { id: string; key: SealedAttachmentKey }>();
  const tooLarge = new Set<string>();
  await eachAtOnce(async (url) => {
    const stored = missing.has(url) ? null : await deps.store.take(url);
    if (stored) {
      const up = await uploadFile({ name: nameOf(url), ...stored });
      if (up && "tooLarge" in up) {
        tooLarge.add(url);
        p.tooLarge = tooLarge.size;
      } else if (up) {
        uploaded.set(url, up);
      }
      if (up) await deps.store.drop(url);
    }
    p.sent.done++;
    tick();
  });

  let pending: MlsImportEntry[] = [];
  for (const m of withFiles) {
    if (control.stopped()) break;
    const attachments: Record<string, SealedAttachmentKey> = {};
    for (const url of m.attachments) {
      const up = uploaded.get(url);
      if (up) attachments[up.id] = up.key;
    }
    const big = m.attachments.filter((u) => tooLarge.has(u)).length;
    const lost = m.attachments.length - Object.keys(attachments).length - big;
    const lostNote = lost ? `${lost === 1 ? "A file" : `${lost} files`} from Discord couldn’t be downloaded.` : "";
    const bigNote = big ? `${big === 1 ? "A file" : `${big} files`} from Discord ${big === 1 ? "was" : "were"} too big for this server.` : "";
    const text = [m.text, lostNote, bigNote].filter(Boolean).join("\n");
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
