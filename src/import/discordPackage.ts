/* Reads the DMs out of Discord's own data package (GRYT-1965). The package only holds
   messages its owner sent, and its JSON is not always valid, so every read is forgiving. */

/** The files in a package, however it was opened: a zip, a folder, a test. */
export interface PackageFiles {
  names: string[];
  read(name: string): Promise<string>;
}

export interface DiscordPackageDm {
  channelId: string;
  /** Their Discord name, from the package's own index. */
  name: string;
  userId: string | null;
  /** Discord's CDN serves avatars by hash without a token. Only friends carry one. */
  avatarUrl: string | null;
  messages: number;
  files: number;
  firstAt: number;
  lastAt: number;
}

export interface DiscordPackageMessage {
  discordId: string;
  sentAt: number;
  text: string;
  attachments: string[];
}

type Index = Map<string, string>;

function indexNames(names: string[]): Index {
  const out: Index = new Map();
  const lower = names.map((n) => n.replace(/\\/g, "/").toLowerCase());
  // A zip made by hand can wrap everything in one folder; Discord's own doesn't.
  const roots = new Set(lower.map((n) => n.split("/")[0]));
  const strip = roots.size === 1 && !lower.some((n) => n === "readme.txt") ? `${[...roots][0]}/` : "";
  lower.forEach((n, i) => out.set(strip && n.startsWith(strip) ? n.slice(strip.length) : n, names[i]));
  return out;
}

export function isDiscordPackage(names: string[]): boolean {
  const idx = indexNames(names);
  return idx.has("messages/index.json") && idx.has("account/user.json");
}

const ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/** Like JSON.parse, but survives what Discord writes: raw newlines in strings, trailing commas. */
export function parseLooseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    let out = "";
    let inString = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === "\\") { out += c + (text[++i] ?? ""); continue; }
        if (c === "\"") inString = false;
        out += ESCAPES[c] ?? c;
      } else {
        if (c === "\"") inString = true;
        out += c;
      }
    }
    return JSON.parse(out.replace(/,\s*([}\]])/g, "$1"));
  }
}

/** RFC 4180: quoted fields may hold commas, quotes ("") and newlines. First row is the header. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "\"" && text[i + 1] === "\"") { field += "\""; i++; }
      else if (c === "\"") quoted = false;
      else field += c;
    } else if (c === "\"") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ""])));
}

/** Discord writes "2023-04-12 21:14:05" in UTC, sometimes with fractions and an offset. */
export function parseDiscordTime(v: unknown): number | null {
  if (typeof v !== "string" || !v.trim()) return null;
  let s = v.trim().replace(" ", "T");
  if (!/(Z|[+-]\d\d:?\d\d)$/.test(s)) s += "Z";
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

const field = (row: Record<string, unknown>, name: string): unknown => {
  const key = Object.keys(row).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : row[key];
};

function attachmentsOf(v: unknown): string[] {
  let list: unknown[] = [];
  if (Array.isArray(v)) list = v;
  else if (typeof v === "string") list = v.split(/\s+/);
  return list.filter((u): u is string => typeof u === "string" && /^https:\/\//.test(u));
}

function toMessage(row: unknown): DiscordPackageMessage | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  const id = field(r, "id");
  const sentAt = parseDiscordTime(field(r, "timestamp"));
  const text = field(r, "contents");
  if ((typeof id !== "string" && typeof id !== "number") || sentAt === null) return null;
  return { discordId: String(id), sentAt, text: typeof text === "string" ? text : "", attachments: attachmentsOf(field(r, "attachments")) };
}

async function readJson(files: PackageFiles, idx: Index, path: string): Promise<unknown> {
  const real = idx.get(path);
  return real === undefined ? undefined : parseLooseJson(await files.read(real));
}

/** Newer packages name folders `c<id>`, older ones just `<id>`. */
function channelFolder(idx: Index, channelId: string): string | null {
  for (const dir of [`messages/c${channelId}/`, `messages/${channelId}/`]) {
    if (idx.has(`${dir}channel.json`)) return dir;
  }
  return null;
}

async function messagesIn(files: PackageFiles, idx: Index, dir: string): Promise<DiscordPackageMessage[]> {
  const json = idx.get(`${dir}messages.json`);
  const csv = idx.get(`${dir}messages.csv`);
  let rows: unknown[] = [];
  if (json !== undefined) {
    const parsed = parseLooseJson(await files.read(json));
    rows = Array.isArray(parsed) ? parsed : [];
  } else if (csv !== undefined) {
    rows = parseCsv(await files.read(csv));
  }
  return rows.map(toMessage).filter((m): m is DiscordPackageMessage => m !== null).sort((a, b) => a.sentAt - b.sentAt);
}

const displayName = (raw: string) => raw.replace(/^Direct Message with\s*/i, "").replace(/#\d+$/, "").trim();

/** Every one-to-one DM in the package that has at least one message, most messages first. */
export async function listDiscordDms(files: PackageFiles): Promise<DiscordPackageDm[]> {
  const idx = indexNames(files.names);
  const user = (await readJson(files, idx, "account/user.json")) as Record<string, unknown> | undefined;
  const selfId = typeof user?.id === "string" ? user.id : null;
  const avatars = new Map<string, string>();
  for (const rel of Array.isArray(user?.relationships) ? user.relationships : []) {
    const u = (rel as { user?: { id?: unknown; avatar?: unknown } } | null)?.user;
    if (typeof u?.id === "string" && typeof u.avatar === "string" && /^(a_)?[0-9a-f]{32}$/i.test(u.avatar)) avatars.set(u.id, u.avatar);
  }
  const index = ((await readJson(files, idx, "messages/index.json")) ?? {}) as Record<string, unknown>;

  const out: DiscordPackageDm[] = [];
  for (const [channelId, label] of Object.entries(index)) {
    const dir = channelFolder(idx, channelId);
    if (!dir) continue;
    const channel = (await readJson(files, idx, `${dir}channel.json`)) as Record<string, unknown> | undefined;
    const recipients = Array.isArray(channel?.recipients) ? channel.recipients.filter((r): r is string => typeof r === "string") : [];
    const isDm = channel?.type === 1 || channel?.type === "DM" || (!channel?.guild && recipients.length === 2);
    if (!isDm) continue;
    const messages = await messagesIn(files, idx, dir);
    if (messages.length === 0) continue;
    const userId = recipients.find((r) => r !== selfId) ?? null;
    const hash = userId ? avatars.get(userId) : undefined;
    out.push({
      channelId,
      name: typeof label === "string" && label ? displayName(label) : (userId ?? channelId),
      userId,
      avatarUrl: userId && hash ? `https://cdn.discordapp.com/avatars/${userId}/${hash}.png?size=64` : null,
      messages: messages.length,
      files: messages.reduce((n, m) => n + m.attachments.length, 0),
      firstAt: messages[0].sentAt,
      lastAt: messages[messages.length - 1].sentAt,
    });
  }
  return out.sort((a, b) => b.messages - a.messages);
}

/** One DM's messages, oldest first. */
export async function readDiscordDm(files: PackageFiles, channelId: string): Promise<DiscordPackageMessage[]> {
  const idx = indexNames(files.names);
  const dir = channelFolder(idx, channelId);
  return dir ? messagesIn(files, idx, dir) : [];
}

/** The earliest `ex` (hex Unix seconds) among signed CDN links, or null when none carry one. */
export function linksExpireAt(urls: string[]): number | null {
  let soonest: number | null = null;
  for (const u of urls) {
    const ex = /[?&]ex=([0-9a-f]+)/i.exec(u)?.[1];
    if (!ex) continue;
    const at = parseInt(ex, 16) * 1000;
    if (soonest === null || at < soonest) soonest = at;
  }
  return soonest;
}
