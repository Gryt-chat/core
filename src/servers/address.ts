/* Both apps read an address the same way or a server one can join is one the
   other cannot. The scheme memory stays in the apps: it touches storage. */

export function normalizeHost(input: string): string {
  let h = String(input || "").trim();
  h = h.replace(/^(wss?:\/\/|https?:\/\/)/i, "");
  h = h.split("/")[0] || "";
  h = h.replace(/\s+/g, "");
  return h;
}

export function normalizeCode(input: string): string {
  return String(input || "")
    .trim()
    .replace(/\s+/g, "")
    .toLowerCase();
}

/**
 * The default host for a legacy `/invite/<code>` link.
 *
 * Those links carry no host, and the only client ever served from a path like
 * that is the hosted one.
 */
const DEFAULT_LEGACY_HOST = "app.gryt.chat";

export interface ServerInput {
  /** Empty when nothing usable was in the input. */
  host: string;
  /** Empty for a plain address, which carries no code. */
  code: string;
}

/* Three shapes: a full invite link, a legacy /invite/<code>, and a plain
   address. `normalizeHost` alone is wrong for the first two — it returns the
   link's host, so you would join gryt.chat instead of the server named in the
   query. Anything that does not parse as a link falls through to an address. */
export function parseServerInput(
  input: string,
  opts?: { defaultLegacyHost?: string },
): ServerInput {
  const raw = String(input || "").trim();
  if (!raw) return { host: "", code: "" };

  const legacyHost = normalizeHost(opts?.defaultLegacyHost || DEFAULT_LEGACY_HOST);

  // Only something carrying a scheme can be a link. Without this, `gryt.chat`
  // parses as a URL in some engines with "gryt.chat" as the protocol.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const path = url.pathname || "/";
      // gryt://invite?host=…&code=… puts "invite" in the authority rather than
      // the path, because the scheme is not one the URL parser treats as
      // special. Both spellings mean the same thing.
      const isInvite = path.startsWith("/invite") || url.hostname === "invite";

      if (isInvite) {
        const host = normalizeHost(url.searchParams.get("host") || "");
        const code = normalizeCode(url.searchParams.get("code") || "");
        if (host && code) return { host, code };

        const parts = path.split("/").filter(Boolean);
        if (parts[0] === "invite" && parts[1]) {
          return { host: legacyHost, code: normalizeCode(parts[1]) };
        }
      }
    } catch {
      // Not a URL after all. It is still probably an address.
    }
  }

  return { host: normalizeHost(raw), code: "" };
}
