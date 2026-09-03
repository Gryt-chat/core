/**
 * What the server found out about a link, and what a card should do with it.
 *
 * The data comes from `GET /api/link-preview`; the shape is the server's, and
 * the decisions below are the ones both apps were making separately. Fetching
 * is not here — the desktop and the phone reach a server differently and neither
 * way belongs in a package with no platform.
 */

export interface LinkPreviewData {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  siteName: string | null;
  favicon: string | null;
  /* Sent by a server new enough to send them, absent from an older one. Every
     one is optional so a card drawn against an old server still comes out
     right rather than empty. */
  imageAlt?: string | null;
  /** The colour the page declares for itself, used when we know no brand. */
  themeColor?: string | null;
  /** `og:type`: "article", "video.other", "music.song". */
  type?: string | null;
  author?: string | null;
  publishedAt?: string | null;
  /** Present when the page advertises a real player. */
  oembedUrl?: string | null;
  /** What the page answered with, so a 404 can say so rather than guess. */
  status?: number | null;
}

const URL_REGEX = /https?:\/\/[^\s<>[\](){}'"`,]+[^\s<>[\](){}'"`,.:;!?)]/gi;

/**
 * The links in a message, minus the ones that are already something else.
 *
 * Code spans and fences are stripped first: a URL inside backticks is being
 * quoted rather than shared, and a card under it would be noise. Markdown
 * images are stripped because the picture is already drawn.
 */
export function extractUrls(text: string | null): string[] {
  if (!text) return [];
  let cleaned = text.replace(/```[\s\S]*?```/g, "");
  cleaned = cleaned.replace(/`[^`]+`/g, "");
  cleaned = cleaned.replace(/!\[[^\]]*\]\([^)]+\)/g, "");
  const matches = cleaned.match(URL_REGEX);
  if (!matches) return [];
  return [...new Set(matches)];
}

/**
 * How much of a card a preview can fill.
 *
 * A wide image wants to sit under the text at full width. A small or square one
 * wants to be a thumbnail beside it. No image wants no space set aside for a
 * picture at all. Drawing all three the same way is what produced a hostname
 * next to an empty grey rectangle.
 */
export type LinkCardLayout = "large" | "thumbnail" | "text" | "bare";

/** Wide enough, and landscape enough, to be a header rather than a thumbnail. */
const LARGE_IMAGE_MIN_WIDTH = 400;
const LARGE_IMAGE_MIN_ASPECT = 1.2;

export function getLinkCardLayout(data: LinkPreviewData): LinkCardLayout {
  const hasText = Boolean(data.title || data.description);
  if (!data.image) return hasText ? "text" : "bare";

  const w = data.imageWidth;
  const h = data.imageHeight;
  /* Unknown dimensions count as large. A site that sets og:image and says
     nothing about its size has almost always set a share card, and the ones
     that have not lose less by being drawn big than a real share card loses by
     being shrunk into a corner. */
  if (!w || !h) return "large";
  if (w >= LARGE_IMAGE_MIN_WIDTH && w / h >= LARGE_IMAGE_MIN_ASPECT) return "large";
  return hasText ? "thumbnail" : "large";
}

/**
 * Why a page gave us nothing, in words worth showing somebody.
 *
 * Only for statuses that mean something to a reader. A 500 is the site's
 * problem and saying so helps nobody, so it returns null and the card falls
 * back to showing the link on its own.
 */
export function describePreviewFailure(status: number | null | undefined): string | null {
  if (status == null) return null;
  if (status === 401) return "Sign-in only";
  /* Not "private": a 403 is as often a site refusing our fetcher as it is a
     page somebody is not allowed to see. Stack Overflow answers 403 to the
     preview fetch and 200 to a browser. A private GitHub repository answers
     404 and is covered below. */
  if (status === 403) return "The site would not let us look";
  if (status === 404 || status === 410) return "Page not found";
  if (status === 429) return "The site is rate limiting us";
  return null;
}

/**
 * The line under the title, where the path says something the title does not.
 *
 * Wikipedia titles its WebRTC page "WebRTC" and the detail read out of
 * `/wiki/WebRTC` is "WebRTC", so showing both printed the word twice.
 */
export function getCardSubtitle(title: string | null, detail: string | null): string | null {
  if (!detail || !title) return null;
  return title.toLowerCase().includes(detail.toLowerCase()) ? null : detail;
}
