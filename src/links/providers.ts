/* Not the list of sites that work — any site with OpenGraph gets a full card
   without being here. Being here buys a real logo and a brand colour.

   The logos are in logos.ts, as path data rather than components, because that
   is the part both apps can share without this package touching a DOM. They
   used to be react-icons components in the desktop client and nothing at all
   on the phone. */

export interface LinkProvider {
  id: string;
  label: string;
  brand: string;
  /** For brands that are essentially black and vanish on a dark card. */
  brandDark?: string;
  hosts: string[];
  hostSuffixes?: string[];
  detail?: (url: URL) => string | null;
}

const seg = (url: URL): string[] => url.pathname.split("/").filter(Boolean);

function githubDetail(url: URL): string | null {
  const p = seg(url);
  if (p.length === 0) return null;
  if (p.length === 1) return `@${p[0]}`;
  const repo = `${p[0]}/${p[1]}`;
  const kind = p[2];
  const number = p[3];
  if (kind === "pull" && number) return `${repo} · pull request #${number}`;
  if (kind === "issues" && number) return `${repo} · issue #${number}`;
  if (kind === "releases") return `${repo} · releases`;
  if (kind === "commit" && number) return `${repo} · commit ${number.slice(0, 7)}`;
  return repo;
}

function modrinthDetail(url: URL): string | null {
  const p = seg(url);
  const kinds: Record<string, string> = {
    mod: "Mod", plugin: "Plugin", datapack: "Data pack",
    shader: "Shader", resourcepack: "Resource pack", modpack: "Modpack",
  };
  if (p.length >= 2 && kinds[p[0]]) return `${kinds[p[0]]} · ${p[1]}`;
  if (p[0] === "user" && p[1]) return `@${p[1]}`;
  return null;
}

function redditDetail(url: URL): string | null {
  const p = seg(url);
  if (p[0] === "r" && p[1]) return p[2] === "comments" ? `r/${p[1]} · post` : `r/${p[1]}`;
  if ((p[0] === "u" || p[0] === "user") && p[1]) return `u/${p[1]}`;
  return null;
}

function npmDetail(url: URL): string | null {
  const p = seg(url);
  if (p[0] !== "package" || !p[1]) return null;
  return p[1].startsWith("@") && p[2] ? `${p[1]}/${p[2]}` : p[1];
}

function wikipediaDetail(url: URL): string | null {
  const p = seg(url);
  const i = p.indexOf("wiki");
  const article = i !== -1 ? p[i + 1] : undefined;
  if (!article) return null;
  try {
    return decodeURIComponent(article).replace(/_/g, " ");
  } catch {
    return article.replace(/_/g, " ");
  }
}

/**
 * The model's name out of `/models/1642496-old-vikings-jewelry-box`.
 *
 * The number is the id their API takes and means nothing to a reader, so the
 * slug behind it is what the line says. A link with the slug stripped —
 * `/models/1642496`, which is what their own copy button produces — has
 * nothing to add, and null leaves the card to its title rather than printing
 * an id at somebody.
 */
function makerWorldDetail(url: URL): string | null {
  const p = seg(url);
  const at = p.indexOf("models");
  const slug = at === -1 ? undefined : p[at + 1];
  if (!slug) return null;
  const name = slug.replace(/^\d+-?/, "").replace(/-/g, " ").trim();
  return name || null;
}

/** Printables files the same way: `/model/1234-a-name`. */
function printablesDetail(url: URL): string | null {
  const p = seg(url);
  const at = p.indexOf("model");
  const slug = at === -1 ? undefined : p[at + 1];
  if (!slug) return null;
  const name = slug.replace(/^\d+-?/, "").replace(/-/g, " ").trim();
  return name || null;
}

function steamDetail(url: URL): string | null {
  const p = seg(url);
  if (p[0] === "app" && p[2]) return decodeURIComponent(p[2]).replace(/_/g, " ");
  if (p[0] === "app" && p[1]) return `App ${p[1]}`;
  return null;
}

/** Seventy-three sites, and the seven that also read a line out of the path. */
export const LINK_PROVIDERS: LinkProvider[] = [
  { id: "github", label: "GitHub", brand: "#181717", brandDark: "#8B949E", hosts: ["github.com", "gist.github.com"], detail: githubDetail },
  { id: "gitlab", label: "GitLab", brand: "#FC6D26", hosts: ["gitlab.com"] },
  { id: "npm", label: "npm", brand: "#CB3837", hosts: ["npmjs.com"], detail: npmDetail },
  { id: "pypi", label: "PyPI", brand: "#3775A9", hosts: ["pypi.org"] },
  { id: "crates", label: "crates.io", brand: "#B7410E", hosts: ["crates.io", "docs.rs"] },
  { id: "docker", label: "Docker Hub", brand: "#2496ED", hosts: ["hub.docker.com"] },
  { id: "stackoverflow", label: "Stack Overflow", brand: "#F58025", hosts: ["stackoverflow.com", "superuser.com", "serverfault.com"], hostSuffixes: [".stackexchange.com"] },
  { id: "codepen", label: "CodePen", brand: "#111111", brandDark: "#C9CDD3", hosts: ["codepen.io"] },
  { id: "codesandbox", label: "CodeSandbox", brand: "#151515", brandDark: "#B9BEC5", hosts: ["codesandbox.io"] },
  { id: "stackblitz", label: "StackBlitz", brand: "#1269D3", hosts: ["stackblitz.com"] },
  { id: "replit", label: "Replit", brand: "#F26207", hosts: ["replit.com"] },
  { id: "vercel", label: "Vercel", brand: "#000000", brandDark: "#B4B4B4", hosts: ["vercel.com"] },
  { id: "netlify", label: "Netlify", brand: "#00C7B7", hosts: ["netlify.com", "netlify.app"] },
  { id: "cloudflare", label: "Cloudflare", brand: "#F38020", hosts: ["cloudflare.com"] },

  { id: "modrinth", label: "Modrinth", brand: "#00AF5C", hosts: ["modrinth.com"], detail: modrinthDetail },
  { id: "curseforge", label: "CurseForge", brand: "#F16436", hosts: ["curseforge.com"] },
  { id: "nexusmods", label: "Nexus Mods", brand: "#D98F40", hosts: ["nexusmods.com"] },
  { id: "steam", label: "Steam", brand: "#1B2838", brandDark: "#8BA5C4", hosts: ["store.steampowered.com", "steamcommunity.com"], detail: steamDetail },
  { id: "itch", label: "itch.io", brand: "#FA5C5C", hosts: ["itch.io"], hostSuffixes: [".itch.io"] },
  { id: "gog", label: "GOG", brand: "#86328A", hosts: ["gog.com"] },
  { id: "epic", label: "Epic Games", brand: "#2A2A2A", brandDark: "#B0B0B0", hosts: ["store.epicgames.com", "epicgames.com"] },
  { id: "playstation", label: "PlayStation", brand: "#0070D1", hosts: ["playstation.com", "store.playstation.com"] },
  { id: "nintendo", label: "Nintendo", brand: "#E60012", hosts: ["nintendo.com"] },

  { id: "youtube", label: "YouTube", brand: "#FF0000", hosts: ["youtube.com", "youtu.be", "m.youtube.com", "music.youtube.com"] },
  { id: "twitch", label: "Twitch", brand: "#9146FF", hosts: ["twitch.tv", "clips.twitch.tv"] },
  { id: "vimeo", label: "Vimeo", brand: "#1AB7EA", hosts: ["vimeo.com", "player.vimeo.com"] },
  { id: "kick", label: "Kick", brand: "#0FA33C", hosts: ["kick.com"] },
  { id: "rumble", label: "Rumble", brand: "#85C742", hosts: ["rumble.com"] },
  { id: "spotify", label: "Spotify", brand: "#1DB954", hosts: ["open.spotify.com"] },
  { id: "applemusic", label: "Apple Music", brand: "#FA243C", hosts: ["music.apple.com"] },
  { id: "soundcloud", label: "SoundCloud", brand: "#FF5500", hosts: ["soundcloud.com", "on.soundcloud.com"] },
  { id: "bandcamp", label: "Bandcamp", brand: "#408294", hosts: ["bandcamp.com"], hostSuffixes: [".bandcamp.com"] },
  { id: "tidal", label: "Tidal", brand: "#1A1A1A", brandDark: "#B0B0B0", hosts: ["tidal.com"] },
  { id: "mixcloud", label: "Mixcloud", brand: "#5000FF", hosts: ["mixcloud.com"] },
  { id: "lastfm", label: "Last.fm", brand: "#D51007", hosts: ["last.fm"] },

  { id: "x", label: "X", brand: "#0F1419", brandDark: "#C4CDD5", hosts: ["x.com", "twitter.com"] },
  { id: "bluesky", label: "Bluesky", brand: "#0285FF", hosts: ["bsky.app"] },
  { id: "mastodon", label: "Mastodon", brand: "#6364FF", hosts: ["mastodon.social", "mastodon.online", "fosstodon.org"] },
  { id: "reddit", label: "Reddit", brand: "#FF4500", hosts: ["reddit.com", "old.reddit.com", "redd.it"], detail: redditDetail },
  { id: "facebook", label: "Facebook", brand: "#0866FF", hosts: ["facebook.com", "fb.com", "fb.watch", "m.facebook.com"] },
  { id: "instagram", label: "Instagram", brand: "#E4405F", hosts: ["instagram.com"] },
  { id: "threads", label: "Threads", brand: "#101010", brandDark: "#BFBFBF", hosts: ["threads.net", "threads.com"] },
  { id: "tiktok", label: "TikTok", brand: "#EE1D52", hosts: ["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"] },
  { id: "linkedin", label: "LinkedIn", brand: "#0A66C2", hosts: ["linkedin.com"] },
  { id: "pinterest", label: "Pinterest", brand: "#BD081C", hosts: ["pinterest.com"], hostSuffixes: [".pinterest.com"] },
  { id: "snapchat", label: "Snapchat", brand: "#B8B400", hosts: ["snapchat.com"] },
  { id: "telegram", label: "Telegram", brand: "#26A5E4", hosts: ["t.me", "telegram.me"] },
  { id: "discord", label: "Discord", brand: "#5865F2", hosts: ["discord.com", "discord.gg", "discordapp.com"] },

  { id: "wikipedia", label: "Wikipedia", brand: "#3366CC", hosts: ["wikipedia.org"], hostSuffixes: [".wikipedia.org"], detail: wikipediaDetail },
  { id: "mdn", label: "MDN Web Docs", brand: "#1B76C4", hosts: ["developer.mozilla.org"] },
  { id: "hackernews", label: "Hacker News", brand: "#FF6600", hosts: ["news.ycombinator.com"] },
  { id: "medium", label: "Medium", brand: "#1A1A1A", brandDark: "#C0C0C0", hosts: ["medium.com"], hostSuffixes: [".medium.com"] },
  { id: "devto", label: "DEV", brand: "#3B49DF", hosts: ["dev.to"] },
  { id: "arxiv", label: "arXiv", brand: "#B31B1B", hosts: ["arxiv.org"] },
  { id: "archive", label: "Internet Archive", brand: "#4A4A4A", brandDark: "#B5B5B5", hosts: ["archive.org", "web.archive.org"] },
  { id: "wolfram", label: "Wolfram Alpha", brand: "#DD1100", hosts: ["wolframalpha.com"] },
  { id: "goodreads", label: "Goodreads", brand: "#75633F", hosts: ["goodreads.com"] },
  { id: "imdb", label: "IMDb", brand: "#C9A227", hosts: ["imdb.com"] },
  { id: "letterboxd", label: "Letterboxd", brand: "#00B020", hosts: ["letterboxd.com"] },

  { id: "imgur", label: "Imgur", brand: "#1BB76E", hosts: ["imgur.com", "i.imgur.com"] },
  { id: "giphy", label: "Giphy", brand: "#FF6666", hosts: ["giphy.com"] },
  { id: "flickr", label: "Flickr", brand: "#0063DC", hosts: ["flickr.com"] },
  { id: "figma", label: "Figma", brand: "#F24E1E", hosts: ["figma.com"] },
  { id: "dribbble", label: "Dribbble", brand: "#EA4C89", hosts: ["dribbble.com"] },
  { id: "behance", label: "Behance", brand: "#1769FF", hosts: ["behance.net"] },

  { id: "notion", label: "Notion", brand: "#2F2F2F", brandDark: "#BFBFBF", hosts: ["notion.so", "notion.site"], hostSuffixes: [".notion.site"] },
  { id: "linear", label: "Linear", brand: "#5E6AD2", hosts: ["linear.app"] },
  { id: "trello", label: "Trello", brand: "#0052CC", hosts: ["trello.com"] },
  { id: "jira", label: "Jira", brand: "#0052CC", hosts: ["atlassian.net"], hostSuffixes: [".atlassian.net"] },
  { id: "obsidian", label: "Obsidian", brand: "#7C3AED", hosts: ["obsidian.md"] },
  { id: "googledrive", label: "Google Drive", brand: "#1A73E8", hosts: ["drive.google.com", "docs.google.com"] },
  { id: "googlemaps", label: "Google Maps", brand: "#34A853", hosts: ["maps.google.com", "maps.app.goo.gl"] },
  { id: "openstreetmap", label: "OpenStreetMap", brand: "#5A8B3E", hosts: ["openstreetmap.org"] },

  /* Where a 3D print came from. MakerWorld wears Bambu Lab's mark and its
     green: it is Bambu Lab's site and has no mark of its own. */
  { id: "makerworld", label: "MakerWorld", brand: "#00AE42", hosts: ["makerworld.com"], detail: makerWorldDetail },
  { id: "printables", label: "Printables", brand: "#FA6831", hosts: ["printables.com"], detail: printablesDetail },
  { id: "thingiverse", label: "Thingiverse", brand: "#248BFB", hosts: ["thingiverse.com"] },
];

const BY_HOST = new Map<string, LinkProvider>();
for (const provider of LINK_PROVIDERS) {
  for (const host of provider.hosts) BY_HOST.set(host, provider);
}

/** The hostname without `www.`, or the input when that was not a URL. */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function getLinkProvider(url: string): LinkProvider | null {
  const host = hostnameOf(url).toLowerCase();
  const exact = BY_HOST.get(host);
  if (exact) return exact;
  for (const provider of LINK_PROVIDERS) {
    if (provider.hostSuffixes?.some((suffix) => host.endsWith(suffix))) return provider;
  }
  return null;
}

/** The line a provider can read out of the path, if it knows how. */
export function getProviderDetail(url: string): string | null {
  const provider = getLinkProvider(url);
  if (!provider?.detail) return null;
  try {
    return provider.detail(new URL(url));
  } catch {
    return null;
  }
}

/**
 * The accent a card is drawn with: the brand where we know it, the colour the
 * page declared where we do not, and null for the app's own accent when
 * neither is on offer.
 */
export function getAccentColor(
  url: string,
  themeColor: string | null | undefined,
  appearance: "light" | "dark",
): string | null {
  const provider = getLinkProvider(url);
  if (provider) {
    return appearance === "dark" ? (provider.brandDark ?? provider.brand) : provider.brand;
  }
  return themeColor ?? null;
}
