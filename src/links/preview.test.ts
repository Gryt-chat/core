import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getAccentColor,
  getLinkProvider,
  getProviderDetail,
  hostnameOf,
  LINK_PROVIDERS,
} from "./providers.ts";
import {
  describePreviewFailure,
  extractUrls,
  getCardSubtitle,
  getLinkCardLayout,
  type LinkPreviewData,
} from "./preview.ts";

/** A preview with nothing set, so each case names only what it needs. */
function preview(fields: Partial<LinkPreviewData> = {}): LinkPreviewData {
  return {
    url: "https://example.com/a",
    title: null,
    description: null,
    image: null,
    imageWidth: null,
    imageHeight: null,
    siteName: null,
    favicon: null,
    ...fields,
  };
}

test("finds the links in a message, once each", () => {
  assert.deepEqual(extractUrls("see https://gryt.chat and https://example.com/x"), [
    "https://gryt.chat",
    "https://example.com/x",
  ]);
  assert.deepEqual(extractUrls("https://a.example https://a.example"), ["https://a.example"]);
});

test("leaves quoted and already-drawn links alone", () => {
  // A URL inside backticks is being quoted, not shared.
  assert.deepEqual(extractUrls("run `curl https://a.example` first"), []);
  assert.deepEqual(extractUrls("```\nhttps://a.example\n```"), []);
  // The picture is already on screen.
  assert.deepEqual(extractUrls("![alt](https://a.example/i.png)"), []);
});

test("does not swallow the punctuation a sentence ends on", () => {
  assert.deepEqual(extractUrls("look at https://gryt.chat."), ["https://gryt.chat"]);
});

test("has nothing to say about a message with no text", () => {
  assert.deepEqual(extractUrls(null), []);
  assert.deepEqual(extractUrls(""), []);
});

test("picks a layout from what the page actually returned", () => {
  const big = preview({ title: "A", image: "i", imageWidth: 1200, imageHeight: 630 });
  assert.equal(getLinkCardLayout(big), "large");

  const square = preview({ title: "A", image: "i", imageWidth: 400, imageHeight: 400 });
  assert.equal(getLinkCardLayout(square), "thumbnail");

  const small = preview({ title: "A", image: "i", imageWidth: 120, imageHeight: 90 });
  assert.equal(getLinkCardLayout(small), "thumbnail");

  // A site that sets og:image and no size has almost always set a share card.
  assert.equal(getLinkCardLayout(preview({ title: "A", image: "i" })), "large");

  // With no words to sit beside, a square image leads instead of shrinking.
  assert.equal(
    getLinkCardLayout(preview({ image: "i", imageWidth: 400, imageHeight: 400 })),
    "large",
  );

  assert.equal(getLinkCardLayout(preview({ title: "A", description: "B" })), "text");
  // Not an empty large card: that is the grey rectangle this replaced.
  assert.equal(getLinkCardLayout(preview()), "bare");
});

test("says only what a reader can act on about a failure", () => {
  assert.equal(describePreviewFailure(401), "Sign-in only");
  // A 403 is as often a site refusing our fetcher as a page you may not see.
  assert.equal(describePreviewFailure(403), "The site would not let us look");
  assert.equal(describePreviewFailure(404), "Page not found");
  assert.equal(describePreviewFailure(429), "The site is rate limiting us");

  assert.equal(describePreviewFailure(200), null);
  // The site being broken is not news to whoever posted the link.
  assert.equal(describePreviewFailure(500), null);
  assert.equal(describePreviewFailure(null), null);
  // An older server sends no status at all.
  assert.equal(describePreviewFailure(undefined), null);
});

test("knows a site by hostname and by suffix", () => {
  assert.equal(getLinkProvider("https://github.com/Gryt-chat/gryt")?.id, "github");
  assert.equal(getLinkProvider("https://www.github.com/x/y")?.id, "github");
  assert.equal(getLinkProvider("https://en.wikipedia.org/wiki/WebRTC")?.id, "wikipedia");
  assert.equal(getLinkProvider("https://no.wikipedia.org/wiki/WebRTC")?.id, "wikipedia");
});

test("is not fooled by a hostname that merely contains one", () => {
  assert.equal(getLinkProvider("https://notgithub.com/x"), null);
  assert.equal(getLinkProvider("https://github.com.evil.example/x"), null);
});

test("has no opinion about the rest of the web", () => {
  assert.equal(getLinkProvider("https://gryt.chat/"), null);
  assert.equal(getLinkProvider("not a url"), null);
});

test("reads the line a path carries", () => {
  assert.equal(getProviderDetail("https://github.com/Gryt-chat/gryt"), "Gryt-chat/gryt");
  assert.equal(
    getProviderDetail("https://github.com/Gryt-chat/gryt/pull/171"),
    "Gryt-chat/gryt · pull request #171",
  );
  assert.equal(getProviderDetail("https://github.com/sivert-io"), "@sivert-io");
  assert.equal(getProviderDetail("https://github.com/"), null);

  assert.equal(getProviderDetail("https://modrinth.com/mod/sodium"), "Mod · sodium");
  assert.equal(getProviderDetail("https://www.reddit.com/r/programming/"), "r/programming");
  assert.equal(getProviderDetail("https://www.npmjs.com/package/@types/node"), "@types/node");

  assert.equal(getProviderDetail("https://en.wikipedia.org/wiki/Caf%C3%A9"), "Café");
  assert.equal(getProviderDetail("https://gryt.chat/"), null);
});

test("draws a card in the site's colour, or the one it declares", () => {
  assert.equal(getAccentColor("https://modrinth.com/mod/sodium", "#ffffff", "dark"), "#00AF5C");
  // A near-black brand is lifted so the edge is visible on a dark card.
  assert.equal(getAccentColor("https://github.com/x/y", null, "dark"), "#8B949E");
  assert.equal(getAccentColor("https://github.com/x/y", null, "light"), "#181717");

  assert.equal(getAccentColor("https://example.com/", "#1bd96a", "dark"), "#1bd96a");
  assert.equal(getAccentColor("https://example.com/", null, "dark"), null);
});

test("drops a subtitle that only repeats the title", () => {
  // Wikipedia titles its WebRTC page "WebRTC".
  assert.equal(getCardSubtitle("WebRTC", "WebRTC"), null);
  assert.equal(getCardSubtitle("GitHub - Gryt-chat/gryt: the monorepo", "Gryt-chat/gryt"), null);
  assert.equal(getCardSubtitle("Weekly thread", "r/programming"), "r/programming");
  assert.equal(getCardSubtitle(null, "r/programming"), null);
  assert.equal(getCardSubtitle("A title", null), null);
});

test("hostnameOf drops the www and survives nonsense", () => {
  assert.equal(hostnameOf("https://www.example.com/a/b?c=d"), "example.com");
  assert.equal(hostnameOf("https://docs.example.com/"), "docs.example.com");
  assert.equal(hostnameOf("nonsense"), "nonsense");
});

test("every provider has one id and a colour that can be drawn", () => {
  const ids = new Set<string>();
  for (const p of LINK_PROVIDERS) {
    assert.ok(!ids.has(p.id), `duplicate provider id: ${p.id}`);
    ids.add(p.id);
    assert.match(p.brand, /^#[0-9a-fA-F]{6}$/, `${p.id} brand is not a hex colour`);
    if (p.brandDark) {
      assert.match(p.brandDark, /^#[0-9a-fA-F]{6}$/, `${p.id} brandDark is not a hex colour`);
    }
    assert.ok(
      p.hosts.length > 0 || (p.hostSuffixes?.length ?? 0) > 0,
      `${p.id} matches nothing`,
    );
  }
});
