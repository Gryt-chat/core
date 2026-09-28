import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sealAttachment } from "@gryt/crypto";

import { decodeMlsDmContent, encodeMlsDmContent, type MlsDmContent } from "./content.ts";

const raw = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const meta = () => sealAttachment({ bytes: new Uint8Array([1, 2, 3]), conversationId: "dm:a:b", name: "a.png", mime: "image/png", width: 2, height: 1 }).meta;

describe("MLS DM content", () => {
  it("writes the same bytes the phone writes, and reads them", () => {
    // As mobile's encodeMlsContent writes them: `{ v: 1, ...content }`.
    const phone = [
      { type: "message", id: "8d0e1c1e-1111-4a4a-9b9b-222233334444", text: "hei", replyTo: "q" },
      { type: "message", id: "a", text: "" },
      { type: "edit", id: "a", text: "hallo" },
      { type: "delete", id: "a" },
    ] as const;
    for (const c of phone) {
      const bytes = raw({ v: 1, ...c });
      assert.deepEqual(encodeMlsDmContent(c), bytes);
      assert.deepEqual(decodeMlsDmContent(bytes), c);
    }
  });

  it("carries the keys to open a sealed upload", () => {
    const c: MlsDmContent = { type: "message", id: "m", text: "", attachments: { "0b7a-upload_1": meta() } };
    assert.deepEqual(decodeMlsDmContent(encodeMlsDmContent(c)), c);
    assert.ok(!new TextDecoder().decode(encodeMlsDmContent({ type: "message", id: "m", text: "x", attachments: {} })).includes("attachments"));
  });

  it("drops fields it doesn't know, at the top and inside a file's keys", () => {
    const m = meta();
    const read = decodeMlsDmContent(raw({ v: 1, type: "message", id: "m", text: "x", extra: 1, attachments: { u: { ...m, evil: "<script>" } } }));
    assert.deepEqual(read, { type: "message", id: "m", text: "x", attachments: { u: m } });
  });

  it("refuses anything off rather than guessing", () => {
    const m = meta();
    const bad: unknown[] = [
      { v: 2, type: "message", id: "a", text: "x" },
      { v: "1", type: "message", id: "a", text: "x" },
      { v: 1, type: "poll", id: "a" },
      { v: 1, type: "message", id: "x".repeat(65), text: "x" },
      { v: 1, type: "message", id: "", text: "x" },
      { v: 1, type: "message", id: "a" },
      { v: 1, type: "message", id: "a", text: 5 },
      { v: 1, type: "message", id: "a", text: "x".repeat(32_001) },
      { v: 1, type: "message", id: "a", text: "x", replyTo: 7 },
      { v: 1, type: "edit", id: "a" },
      { v: 1, type: "message", id: "a", text: "x", attachments: [m] },
      { v: 1, type: "message", id: "a", text: "x", attachments: {} },
      { v: 1, type: "message", id: "a", text: "x", attachments: { "../etc": m } },
      { v: 1, type: "message", id: "a", text: "x", attachments: { u: { ...m, key: m.key.slice(1) } } },
      { v: 1, type: "message", id: "a", text: "x", attachments: { u: { ...m, iv: "!!" } } },
      { v: 1, type: "message", id: "a", text: "x", attachments: { u: { ...m, size: -1 } } },
      { v: 1, type: "message", id: "a", text: "x", attachments: { u: { ...m, width: 1.5 } } },
      { v: 1, type: "message", id: "a", text: "x", attachments: { u: { ...m, name: "n".repeat(256) } } },
      { v: 1, type: "message", id: "a", text: "x", attachments: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`u${i}`, m])) },
      [1, 2],
      null,
      "message",
    ];
    for (const v of bad) assert.equal(decodeMlsDmContent(raw(v)), null, JSON.stringify(v)?.slice(0, 80));
    assert.equal(decodeMlsDmContent(new TextEncoder().encode('{"v":1,"type":"message","id":"a","text":"x","attachments":{"__proto__":{}}}')), null);
    assert.equal(decodeMlsDmContent(new Uint8Array([0xff, 0xfe])), null);
  });

  it("carries a reaction as an explicit add or remove on a message id", () => {
    const reactions: MlsDmContent[] = [
      { type: "reaction", id: "8d0e1c1e-1111-4a4a-9b9b-222233334444", emoji: "👍", action: "add" },
      { type: "reaction", id: "a", emoji: "❤️", action: "remove" },
      { type: "reaction", id: "a", emoji: ":party_owl:", action: "add" },
      { type: "reaction", id: "a", emoji: "👍🏽", action: "add" },
      { type: "reaction", id: "a", emoji: "🇳🇴", action: "add" },
      { type: "reaction", id: "a", emoji: "1️⃣", action: "add" },
      { type: "reaction", id: "a", emoji: "👩🏻‍❤️‍💋‍👨🏼", action: "add" },
      { type: "reaction", id: "a", emoji: "🏴󠁧󠁢󠁳󠁣󠁴󠁿", action: "add" },
      { type: "reaction", id: "a", emoji: "©️", action: "add" },
    ];
    for (const c of reactions) {
      const bytes = encodeMlsDmContent(c);
      assert.deepEqual(bytes, raw({ v: 1, ...c }));
      assert.deepEqual(decodeMlsDmContent(bytes), c);
    }
  });

  it("reads every emoji the pickers offer as a reaction", () => {
    // Node's RGI_Emoji set is the list both pickers draw from, give or take a Unicode version.
    const rgi = /^\p{RGI_Emoji}$/v;
    const samples = ["😀", "🫠", "🧑‍🧑‍🧒‍🧒", "🏳️‍🌈", "🏳️‍⚧️", "#️⃣", "*️⃣", "👁️‍🗨️", "🧔🏿‍♂️", "🐦‍🔥", "™️", "〰️", "🅰️"];
    for (const emoji of samples) {
      assert.ok(rgi.test(emoji), emoji);
      assert.ok(decodeMlsDmContent(raw({ v: 1, type: "reaction", id: "a", emoji, action: "add" })), emoji);
    }
  });

  it("refuses a reaction that isn't one emoji", () => {
    const bad = [
      "",
      "lol",
      "1",
      "#",
      "👍 ",
      " 👍",
      "👍\n",
      "‍",
      "️",
      "🏻",
      "👍".repeat(13),
      ":a:",
      ":x" + "x".repeat(32) + ":",
      ":party owl:",
      ":<img>:",
      "<img src=x onerror=alert(1)>",
      "é",
      "中",
      "\u202e👍",
    ];
    for (const emoji of bad) {
      assert.equal(decodeMlsDmContent(raw({ v: 1, type: "reaction", id: "a", emoji, action: "add" })), null, JSON.stringify(emoji));
    }
    for (const v of [
      { v: 1, type: "reaction", id: "a", emoji: "👍" },
      { v: 1, type: "reaction", id: "a", emoji: "👍", action: "toggle" },
      { v: 1, type: "reaction", id: "a", emoji: 1, action: "add" },
      { v: 1, type: "reaction", emoji: "👍", action: "add" },
      { v: 1, type: "reaction", id: "x".repeat(65), emoji: "👍", action: "add" },
    ]) {
      assert.equal(decodeMlsDmContent(raw(v)), null, JSON.stringify(v));
    }
    assert.throws(() => encodeMlsDmContent({ type: "reaction", id: "a", emoji: "hei", action: "add" }));
  });

  it("drops fields it doesn't know on a reaction", () => {
    assert.deepEqual(decodeMlsDmContent(raw({ v: 1, type: "reaction", id: "a", emoji: "👍", action: "add", text: "x", users: ["b"] })), {
      type: "reaction",
      id: "a",
      emoji: "👍",
      action: "add",
    });
  });

  it("won't write what it wouldn't read", () => {
    assert.throws(() => encodeMlsDmContent({ type: "message", id: "", text: "x" }));
    assert.throws(() => encodeMlsDmContent({ type: "message", id: "a", text: "x", replyTo: "r".repeat(65) }));
  });
});
