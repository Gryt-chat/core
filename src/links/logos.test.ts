import assert from "node:assert/strict";
import { test } from "node:test";

import { LINK_PROVIDERS } from "./providers.ts";
import { getProviderLogo, LINK_PROVIDER_LOGOS, LOGO_VIEW_BOX } from "./logos.ts";

test("every logo names a provider that exists", () => {
  const ids = new Set(LINK_PROVIDERS.map((provider) => provider.id));
  for (const id of Object.keys(LINK_PROVIDER_LOGOS)) {
    assert.ok(ids.has(id), `${id} has a logo but is not a provider`);
  }
});

// Not the other way round on purpose. A provider without a logo falls back to
// the site's favicon, so the gap is a design decision rather than a bug, and
// requiring artwork for every provider would make adding one harder than it
// needs to be.

test("every logo is a single path on the documented canvas", () => {
  assert.equal(LOGO_VIEW_BOX, "0 0 24 24");

  for (const [id, d] of Object.entries(LINK_PROVIDER_LOGOS)) {
    assert.match(d, /^[Mm]/, `${id} does not start with a move command`);

    // One path, so both apps can draw a logo without knowing how many elements
    // it takes. The extraction asserted this too; this keeps it true after
    // somebody edits the file by hand.
    assert.doesNotMatch(d, /["<>]/, `${id} looks like markup rather than path data`);
  }
});

test("getProviderLogo answers for known and unknown ids", () => {
  assert.equal(getProviderLogo("github"), LINK_PROVIDER_LOGOS.github);
  assert.equal(getProviderLogo("not-a-provider"), undefined);
});

test("the providers the client draws today all have artwork", () => {
  // The desktop client rendered these as react-icons components before they
  // moved here. Losing one is a logo silently becoming a favicon, which is the
  // kind of regression nobody files.
  //
  // 73 at the extraction, plus the three printing sites GRYT-913 added.
  assert.equal(Object.keys(LINK_PROVIDER_LOGOS).length, 76);
});

test("the printing sites have both a provider and a mark", () => {
  // The pair that made this worth a test: GRYT-913 added the providers in one
  // change and the artwork in another, so for a release they had names, brand
  // colours and a favicon where a logo should be.
  for (const id of ["makerworld", "printables", "thingiverse"]) {
    assert.ok(getProviderLogo(id), `${id} has no logo`);
  }
});
