import { base64UrlDecode, type SealedAttachmentKey } from "@gryt/crypto";

/* What goes inside an MLS application message in a DM, as the phone wrote it first (GRYT-1521).
   Everything decrypted is still a peer's input, so the reader checks every field. */

/** One message from the sender's own record of the DM, for the other person's new device (GRYT-1875). */
export interface MlsHistoryEntry {
  id: string;
  /** Server user id of whoever wrote it, as the sender's record has it. */
  senderId: string;
  /** Milliseconds since the epoch. */
  sentAt: number;
  text: string;
  replyTo?: string;
  attachments?: Record<string, SealedAttachmentKey>;
}

/** One message from the sender's own Discord data. Who wrote it is never in here: the reader takes the MLS sender. */
export interface MlsImportEntry {
  id: string;
  /** Milliseconds since the epoch, Discord's time for it. */
  sentAt: number;
  text: string;
  attachments?: Record<string, SealedAttachmentKey>;
}

export type MlsDmContent =
  | {
      type: "import";
      id: string;
      source: "discord";
      entries: MlsImportEntry[];
    }
  | {
      type: "history";
      /** For the batch itself, so a repeat is the same message. */
      id: string;
      entries: MlsHistoryEntry[];
    }
  | {
      type: "message";
      /** Made by the sender, a UUID. Edits and deletes name it. */
      id: string;
      text: string;
      replyTo?: string;
      /** Upload id to what `sealAttachment` returned; `openAttachment` takes it as `meta`. */
      attachments?: Record<string, SealedAttachmentKey>;
    }
  | { type: "edit"; id: string; text: string }
  | { type: "delete"; id: string }
  | {
      type: "reaction";
      /** The message reacted to, the way edits and deletes name theirs. */
      id: string;
      /** A Unicode emoji, or a server emoji as `:name:`, the same string `chat:react` carries. */
      emoji: string;
      /** Explicit rather than a toggle, so a repeat or a reorder lands the same on every device. */
      action: "add" | "remove";
    };

export const MLS_DM_CONTENT_VERSION = 1;

const MAX_ID = 64;
/** Well past the composer's limit, and under what one `mls:send` can carry. */
const MAX_TEXT = 32_000;
const MAX_ATTACHMENTS = 10;
const MAX_LABEL = 255;
const UPLOAD_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** The server's own rule for an emoji's name, in `emojiShared.ts`. */
const CUSTOM_EMOJI = /^:[A-Za-z0-9_]{2,32}:$/;
/** The longest RGI emoji, a kiss with two skin tones, is ten code points. */
const MAX_EMOJI_CODE_POINTS = 12;
const EMOJI_PART = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\uFE0E)$/u;
const EMOJI_BASE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3)$/u;

const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_ID;
const isText = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_TEXT;
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isLabel = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_LABEL;
const MAX_HISTORY_ENTRIES = 200;
/** Under what one `mls:send` takes once sealed and padded. */
export const MAX_HISTORY_BATCH_BYTES = 48 * 1024;

/** One emoji's worth of emoji characters, so a peer can't put a sentence on a message as a reaction. */
function isReactionEmoji(v: unknown): v is string {
  if (typeof v !== "string") return false;
  if (CUSTOM_EMOJI.test(v)) return true;
  const points = Array.from(v);
  if (points.length === 0 || points.length > MAX_EMOJI_CODE_POINTS) return false;
  return points.every((p) => EMOJI_PART.test(p)) && points.some((p) => EMOJI_BASE.test(p));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function decodesTo(v: unknown, bytes: number): v is string {
  if (typeof v !== "string") return false;
  try {
    return base64UrlDecode(v).length === bytes;
  } catch {
    return false;
  }
}

/** Only the fields a reader uses, each checked; null for anything off. */
function readAttachmentKey(v: unknown): SealedAttachmentKey | null {
  if (!isObject(v) || !isId(v.id) || !decodesTo(v.key, 32) || !decodesTo(v.iv, 12)) return null;
  const out: SealedAttachmentKey = { id: v.id, key: v.key, iv: v.iv };
  for (const field of ["name", "mime"] as const) {
    if (v[field] === undefined) continue;
    if (!isLabel(v[field])) return null;
    out[field] = v[field];
  }
  for (const field of ["size", "width", "height"] as const) {
    if (v[field] === undefined) continue;
    if (!isCount(v[field])) return null;
    out[field] = v[field];
  }
  return out;
}

function readAttachments(v: unknown): Record<string, SealedAttachmentKey> | null {
  if (!isObject(v)) return null;
  const entries = Object.entries(v);
  if (entries.length === 0 || entries.length > MAX_ATTACHMENTS) return null;
  const out: Record<string, SealedAttachmentKey> = {};
  for (const [uploadId, meta] of entries) {
    const key = readAttachmentKey(meta);
    if (!UPLOAD_ID.test(uploadId) || !key) return null;
    out[uploadId] = key;
  }
  return out;
}

/** The same bytes the phone writes: `v` first, then the content's fields in this order. */
export function encodeMlsDmContent(content: MlsDmContent): Uint8Array {
  let body: Record<string, unknown>;
  if (content.type === "history") {
    body = { type: content.type, id: content.id, entries: content.entries.map(historyBody) };
  } else if (content.type === "import") {
    body = { type: content.type, id: content.id, source: content.source, entries: content.entries.map(importBody) };
  } else if (content.type === "message") {
    body = { type: content.type, id: content.id, text: content.text };
    if (content.replyTo !== undefined) body.replyTo = content.replyTo;
    if (content.attachments && Object.keys(content.attachments).length > 0) body.attachments = content.attachments;
  } else if (content.type === "edit") {
    body = { type: content.type, id: content.id, text: content.text };
  } else if (content.type === "reaction") {
    body = { type: content.type, id: content.id, emoji: content.emoji, action: content.action };
  } else {
    body = { type: content.type, id: content.id };
  }
  const bytes = new TextEncoder().encode(JSON.stringify({ v: MLS_DM_CONTENT_VERSION, ...body }));
  if (!decodeMlsDmContent(bytes)) throw new Error("That content wouldn't read back, so it isn't sent.");
  return bytes;
}

function historyBody(e: MlsHistoryEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { id: e.id, senderId: e.senderId, sentAt: e.sentAt, text: e.text };
  if (e.replyTo !== undefined) out.replyTo = e.replyTo;
  if (e.attachments && Object.keys(e.attachments).length > 0) out.attachments = e.attachments;
  return out;
}

function importBody(e: MlsImportEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { id: e.id, sentAt: e.sentAt, text: e.text };
  if (e.attachments && Object.keys(e.attachments).length > 0) out.attachments = e.attachments;
  return out;
}

function sizedBatches<E extends { sentAt: number }>(
  entries: E[],
  body: (e: E) => Record<string, unknown>,
  readable: (raw: Record<string, unknown>) => boolean,
  head: Record<string, unknown>,
): E[][] {
  const size = (batch: E[]) =>
    new TextEncoder().encode(JSON.stringify({ v: MLS_DM_CONTENT_VERSION, ...head, id: "x".repeat(MAX_ID), entries: batch.map(body) })).length;
  const out: E[][] = [];
  let batch: E[] = [];
  for (const e of [...entries].sort((a, b) => a.sentAt - b.sentAt)) {
    if (!readable(body(e)) || size([e]) > MAX_HISTORY_BATCH_BYTES) continue;
    if (batch.length === MAX_HISTORY_ENTRIES || size([...batch, e]) > MAX_HISTORY_BATCH_BYTES) {
      out.push(batch);
      batch = [];
    }
    batch.push(e);
  }
  if (batch.length) out.push(batch);
  return out;
}

/** History as batches small enough to send, oldest first. One entry too big to send on its own is left out. */
export function historyBatches(entries: MlsHistoryEntry[], newId: () => string): Extract<MlsDmContent, { type: "history" }>[] {
  return sizedBatches(entries, historyBody, (raw) => readHistoryEntry(raw) !== null, { type: "history" })
    .map((batch) => ({ type: "history", id: newId(), entries: batch }));
}

/** An import as batches small enough to send, oldest first, the same way `historyBatches` splits. */
export function importBatches(entries: MlsImportEntry[], newId: () => string): Extract<MlsDmContent, { type: "import" }>[] {
  return sizedBatches(entries, importBody, (raw) => readImportEntry(raw) !== null, { type: "import", source: "discord" })
    .map((batch) => ({ type: "import", id: newId(), source: "discord", entries: batch }));
}

/** Discord's own epoch, 2015-01-01. Nothing from Discord is older. */
const DISCORD_EPOCH = 1_420_070_400_000;

/**
 * An import's entries as messages by `senderId`, the MLS sender, whatever the batch says.
 * Dated before Discord existed or after the server got it (`at`) is dropped.
 */
export function acceptImport(
  content: Extract<MlsDmContent, { type: "import" }>,
  { senderId, at }: { senderId: string; at: number },
): MlsHistoryEntry[] {
  return content.entries
    .filter((e) => e.sentAt >= DISCORD_EPOCH && e.sentAt <= at)
    .map((e) => (e.attachments ? { ...e, senderId } : { id: e.id, senderId, sentAt: e.sentAt, text: e.text }));
}

function readHistoryEntry(v: unknown): MlsHistoryEntry | null {
  if (!isObject(v) || !isId(v.id) || !isId(v.senderId) || !isText(v.text) || !isCount(v.sentAt)) return null;
  const out: MlsHistoryEntry = { id: v.id, senderId: v.senderId, sentAt: v.sentAt, text: v.text };
  if (v.replyTo !== undefined) {
    if (!isId(v.replyTo)) return null;
    out.replyTo = v.replyTo;
  }
  if (v.attachments !== undefined) {
    const attachments = readAttachments(v.attachments);
    if (!attachments) return null;
    out.attachments = attachments;
  }
  return out;
}

function readImportEntry(v: unknown): MlsImportEntry | null {
  if (!isObject(v) || !isId(v.id) || !isText(v.text) || !isCount(v.sentAt)) return null;
  const out: MlsImportEntry = { id: v.id, sentAt: v.sentAt, text: v.text };
  if (v.attachments !== undefined) {
    const attachments = readAttachments(v.attachments);
    if (!attachments) return null;
    out.attachments = attachments;
  }
  return out;
}

/** Null for anything this version can't read: a newer version, a new type, or junk. */
export function decodeMlsDmContent(bytes: Uint8Array): MlsDmContent | null {
  return fromRaw(parse(bytes));
}

/**
 * Like `decodeMlsDmContent`, but tells content from a newer app ("newer", skip it quietly)
 * apart from junk (null, which is worth counting). A known type with a bad field is junk.
 */
export function readMlsDmContent(bytes: Uint8Array): MlsDmContent | "newer" | null {
  const raw = parse(bytes);
  return fromRaw(raw) ?? (isNewer(raw) ? "newer" : null);
}

const KNOWN_TYPES: ReadonlySet<string> = new Set(["message", "edit", "delete", "reaction", "history", "import"]);
const TYPE_NAME = /^[a-z][a-z0-9_]{0,31}$/;

/** A later version, or a type this one doesn't know that names its message the way ours do. */
function isNewer(raw: unknown): boolean {
  if (!isObject(raw) || typeof raw.type !== "string" || !TYPE_NAME.test(raw.type)) return false;
  if (raw.v === MLS_DM_CONTENT_VERSION) return !KNOWN_TYPES.has(raw.type) && isId(raw.id);
  return typeof raw.v === "number" && Number.isSafeInteger(raw.v) && raw.v > MLS_DM_CONTENT_VERSION;
}

function parse(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

function fromRaw(raw: unknown): MlsDmContent | null {
  if (!isObject(raw) || raw.v !== MLS_DM_CONTENT_VERSION || !isId(raw.id)) return null;
  const { type, id, text } = raw;

  if (type === "history") {
    if (!Array.isArray(raw.entries) || raw.entries.length === 0 || raw.entries.length > MAX_HISTORY_ENTRIES) return null;
    const entries = raw.entries.map(readHistoryEntry);
    return entries.every((e): e is MlsHistoryEntry => e !== null) ? { type, id, entries } : null;
  }
  if (type === "import") {
    if (raw.source !== "discord" || !Array.isArray(raw.entries) || raw.entries.length === 0 || raw.entries.length > MAX_HISTORY_ENTRIES) return null;
    const entries = raw.entries.map(readImportEntry);
    return entries.every((e): e is MlsImportEntry => e !== null) ? { type, id, source: raw.source, entries } : null;
  }
  if (type === "message" && isText(text)) {
    const out: Extract<MlsDmContent, { type: "message" }> = { type, id, text };
    if (raw.replyTo !== undefined) {
      if (!isId(raw.replyTo)) return null;
      out.replyTo = raw.replyTo;
    }
    if (raw.attachments !== undefined) {
      const attachments = readAttachments(raw.attachments);
      if (!attachments) return null;
      out.attachments = attachments;
    }
    return out;
  }
  if (type === "edit" && isText(text)) return { type, id, text };
  if (type === "delete") return { type, id };
  if (type === "reaction" && isReactionEmoji(raw.emoji) && (raw.action === "add" || raw.action === "remove")) {
    return { type, id, emoji: raw.emoji, action: raw.action };
  }
  return null;
}
