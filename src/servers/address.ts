/**
 * Reading whatever somebody pasted into the join field.
 *
 * Both apps had this, byte for byte: `normalizeHost`, `normalizeCode` and all
 * of `parseServerInput`, down to the comments. The phone said so in its own
 * header — a copy, because the desktop's `common` package was never published,
 * written down in GRYT-406 rather than left to be found once the two had
 * drifted.
 *
 * They had not drifted, which is the only comfortable moment to do this. The
 * two apps talk to the same servers, so an address one reads differently is a
 * server the other cannot join, and that failure looks like the server being
 * down rather than like a parser disagreeing.
 *
 * What stayed behind is the scheme memory — `schemeFor`, `rememberScheme` and
 * the rest. Those reach for storage and the two apps store differently, so they
 * fail the test at the top of this package.
 */

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

/**
 * Three shapes arrive and they are not the same thing: a full invite link
 * (`https://gryt.chat/invite?host=…&code=…`), a legacy one
 * (`https://app.gryt.chat/invite/<code>`), and a plain address (`gryt.chat`,
 * `192.168.1.5:5001`).
 *
 * `normalizeHost` on its own is wrong for the first two — it returns the
 * *link's* host, which is gryt.chat, and joining that instead of the server
 * named in the query is a confusing failure rather than an obvious one.
 *
 * Anything that does not parse as a link falls through to being an address, so
 * a typo in a URL still gets the address treatment rather than an error about
 * invite formats.
 */
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
