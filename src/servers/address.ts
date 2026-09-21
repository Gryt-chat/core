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
 * The default host for a legacy `/invite/<code>` link. Those carry no host, and the only
 * client ever served from a path like that is the hosted one.
 */
const DEFAULT_LEGACY_HOST = "app.gryt.chat";

export interface ServerInput {
  /** Empty when nothing usable was in the input. */
  host: string;
  /** Empty for a plain address, which carries no code. */
  code: string;
}

/* Four shapes: an invite link with a code, one with only a host, a legacy /invite/<code>,
   and a plain address. `normalizeHost` alone returns the link's host, so you'd join gryt.chat. */
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
      // gryt://invite?host=…&code=… puts "invite" in the authority rather than the path,
      // because the scheme is not one the URL parser treats as special. Both mean the same.
      const isInvite = path.startsWith("/invite") || url.hostname === "invite";

      if (isInvite) {
        const host = normalizeHost(url.searchParams.get("host") || "");
        const code = normalizeCode(url.searchParams.get("code") || "");
        if (host && code) return { host, code };

        const parts = path.split("/").filter(Boolean);
        if (parts[0] === "invite" && parts[1]) {
          return { host: legacyHost, code: normalizeCode(parts[1]) };
        }

        // A server anyone can join needs no code, so its link names only the host.
        if (host) return { host, code: "" };
      }
    } catch {
      // Not a URL after all. It is still probably an address.
    }
  }

  return { host: normalizeHost(raw), code: "" };
}

/** The link that opens an invite in whichever app somebody has. Leave out the code for a
    server anyone can join. */
export function inviteLink(host: string, code?: string): string {
  const cleanCode = normalizeCode(code ?? "");
  const query = `host=${encodeURIComponent(normalizeHost(host))}`;
  return `https://gryt.chat/invite?${query}${cleanCode ? `&code=${encodeURIComponent(cleanCode)}` : ""}`;
}

/** Names that only mean something on one network. A bare name with no dot is one too. */
const LOCAL_SUFFIXES = ["localhost", "local", "localdomain", "lan", "home", "internal", "home.arpa"];

/** Lowercased, with any port, brackets and trailing dot removed. */
function bareHostname(host: string): string {
  const trimmed = normalizeHost(host).toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(trimmed);
  if (bracketed) return bracketed[1];
  const colons = (trimmed.match(/:/g) || []).length;
  const withoutPort = colons === 1 ? trimmed.replace(/:\d*$/, "") : trimmed;
  return withoutPort.replace(/\.$/, "");
}

function ipv4Octets(name: string): number[] | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return null;
  const octets = name.split(".").map(Number);
  return octets.every((n) => n <= 255) ? octets : null;
}

function isPublicIpv4([a, b]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT, and Tailscale
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  return !(a === 192 && b === 168);
}

/**
 * Whether an address works for somebody on another network. Loopback, private and
 * link-local ranges, CGNAT, and names like `nas` or `box.local` do not.
 */
export function isPublicHost(host: string): boolean {
  const name = bareHostname(host);
  if (!name) return false;

  const v4 = ipv4Octets(name);
  if (v4) return isPublicIpv4(v4);

  if (name.includes(":")) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(name);
    if (mapped) {
      const octets = ipv4Octets(mapped[1]);
      return !!octets && isPublicIpv4(octets);
    }
    if (name === "::" || name === "::1") return false;
    // fc00::/7 is private, fe80::/10 is link-local.
    return !/^f[cd]/.test(name) && !/^fe[89ab]/.test(name);
  }

  // No top-level domain is all digits, so `999.1.1.1` is a broken address rather than a name.
  if (!name.includes(".") || /\.\d+$/.test(name)) return false;
  return !LOCAL_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}
