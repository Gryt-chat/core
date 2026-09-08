/* Shape is the server's, from `GET /api/link-preview`. Fetching is not here:
   the two apps reach a server differently. */

export interface LinkPreviewData {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  siteName: string | null;
  favicon: string | null;
  /* Sent by a server new enough to send them, absent from an older one. Every one is
     optional, so a card drawn against an old server still comes out right. */
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
 * The links in a message, minus the ones that are already something else: a URL in backticks
 * is being quoted rather than shared, and a markdown image is already drawn.
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
 * How much of a card a preview can fill. A wide image sits under the text, a small one
 * beside it, and no image takes no space — drawing all three alike gave a grey rectangle.
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
  /* Unknown dimensions count as large: a site that sets og:image and says nothing about its
     size has almost always set a share card, and those lose most by being shrunk. */
  if (!w || !h) return "large";
  if (w >= LARGE_IMAGE_MIN_WIDTH && w / h >= LARGE_IMAGE_MIN_ASPECT) return "large";
  return hasText ? "thumbnail" : "large";
}

/**
 * Why a page gave us nothing, in words worth showing somebody. Only for statuses that mean
 * something to a reader: a 500 is the site's problem, so it returns null.
 */
export function describePreviewFailure(status: number | null | undefined): string | null {
  if (status == null) return null;
  if (status === 401) return "Sign-in only";
  /* Not "private": a 403 is as often a site refusing our fetcher as a page somebody may not
     see. Stack Overflow answers 403 to the fetch and 200 to a browser. */
  if (status === 403) return "The site would not let us look";
  if (status === 404 || status === 410) return "Page not found";
  if (status === 429) return "The site is rate limiting us";
  return null;
}

/**
 * The line under the title, where the path says something the title does not. Wikipedia
 * titles its WebRTC page "WebRTC", and `/wiki/WebRTC` printed the word twice.
 */
export function getCardSubtitle(title: string | null, detail: string | null): string | null {
  if (!detail || !title) return null;
  return title.toLowerCase().includes(detail.toLowerCase()) ? null : detail;
}
