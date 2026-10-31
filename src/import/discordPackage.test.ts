import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isDiscordPackage,
  linksExpireAt,
  listDiscordDms,
  type PackageFiles,
  parseCsv,
  parseDiscordTime,
  parseLooseJson,
  readableDiscordText,
  readDiscordDm,
} from "./discordPackage.ts";

const SELF = "100000000000000001";
const KARI = "200000000000000002";
const MIA = "300000000000000003";
const HASH = "a".repeat(32);

function pkg(entries: Record<string, string>): PackageFiles {
  return { names: Object.keys(entries), read: async (n) => entries[n] };
}

// Shaped like a real package: a DM in JSON, an older one in CSV, a group DM and a server channel.
const files = pkg({
  "README.txt": "",
  "Account/user.json": JSON.stringify({ id: SELF, relationships: [{ id: KARI, user: { id: KARI, avatar: HASH } }] }),
  "Messages/index.json": JSON.stringify({ 11: "Direct Message with kari.k#0", 22: "Direct Message with mia", 33: "Group", 44: "general in Some Server" }),
  "Messages/c11/channel.json": JSON.stringify({ id: "11", type: 1, recipients: [SELF, KARI] }),
  "Messages/c11/messages.json": `[
    {"ID": "9002", "Timestamp": "2023-04-12 21:15:00", "Contents": "sending pics", "Attachments": "https://cdn.discordapp.com/attachments/1/2/a.png?ex=6540a1b0&is=1&hm=2 https://cdn.discordapp.com/attachments/1/3/b.png?ex=6540a0b0&is=1&hm=3"},
    {"ID": "9001", "Timestamp": "2023-04-12 21:14:00.123000+00:00", "Contents": "two
lines", "Attachments": ""},
  ]`,
  "Messages/22/channel.json": JSON.stringify({ id: "22", recipients: [MIA, SELF] }),
  "Messages/22/messages.csv": 'ID,Timestamp,Contents,Attachments\n7001,2020-01-01 10:00:00,"hei, du",\n7002,2020-01-02 10:00:00,"she said ""hi""\nback",\n',
  "Messages/c33/channel.json": JSON.stringify({ id: "33", type: 3, recipients: [SELF, KARI, MIA] }),
  "Messages/c33/messages.json": JSON.stringify([{ ID: "1", Timestamp: "2024-01-01 00:00:00", Contents: "x", Attachments: "" }]),
  "Messages/c44/channel.json": JSON.stringify({ id: "44", type: 0, guild: { id: "5", name: "Some Server" } }),
  "Messages/c44/messages.json": JSON.stringify([{ ID: "2", Timestamp: "2024-01-01 00:00:00", Contents: "y", Attachments: "" }]),
});

describe("Discord's markup in a message (GRYT-1982)", () => {
  const people = new Map([["1", "Kari"]]);
  const channels = { 5: "general, A server", 6: "Unknown channel, B" };
  it("turns it into text a person can read", () => {
    assert.equal(readableDiscordText("hei <:pog:123> <a:dance:456>", people, channels), "hei :pog: :dance:");
    assert.equal(readableDiscordText("<@1> <@!1> <@2>", people, channels), "@Kari @Kari @someone");
    assert.equal(readableDiscordText("<@&9> <#5> <#6> <#7>", people, channels), "@role #general #channel #channel");
  });
  it("leaves other text alone", () => {
    const plain = "a < b, <https://gryt.chat> <:notemoji> <@me> `x`";
    assert.equal(readableDiscordText(plain, people, channels), plain);
  });
  it("converts while reading a DM, naming a friend and the person it's with", async () => {
    const read = pkg({
      "Account/user.json": JSON.stringify({ id: SELF, global_name: "Me", relationships: [{ user: { id: MIA, username: "mia" } }] }),
      "Messages/index.json": JSON.stringify({ 77: "Direct Message with kari.k#0" }),
      "Messages/c77/channel.json": JSON.stringify({ id: "77", type: "DM", recipients: [SELF, KARI] }),
      "Messages/c77/messages.json": JSON.stringify([{ ID: "1", Timestamp: "2023-04-12 21:14:05", Contents: `<@${KARI}> <@${MIA}> <@${SELF}> <:ok:1>`, Attachments: "" }]),
    });
    const [m] = await readDiscordDm(read, "77");
    assert.equal(m.text, "@kari.k @mia @Me :ok:");
  });
});

describe("Discord data package (GRYT-1965)", () => {
  it("knows a package from anything else", () => {
    assert.ok(isDiscordPackage(files.names));
    assert.ok(isDiscordPackage(files.names.map((n) => `package/${n}`)));
    assert.ok(!isDiscordPackage(["photos/a.png"]));
  });

  it("lists one-to-one DMs only, most messages first", async () => {
    const dms = await listDiscordDms(files);
    assert.deepEqual(dms.map((d) => d.name), ["kari.k", "mia"]);
    const [kari, mia] = dms;
    assert.equal(kari.userId, KARI);
    assert.equal(kari.avatarUrl, `https://cdn.discordapp.com/avatars/${KARI}/${HASH}.png?size=64`);
    assert.equal(kari.files, 2);
    assert.equal(kari.firstAt, Date.UTC(2023, 3, 12, 21, 14, 0, 123));
    assert.equal(mia.avatarUrl, null, "not a friend, so no avatar hash");
  });

  it("reads a DM's messages oldest first, from JSON with raw newlines and a trailing comma", async () => {
    const msgs = await readDiscordDm(files, "11");
    assert.deepEqual(msgs.map((m) => m.discordId), ["9001", "9002"]);
    assert.equal(msgs[0].text, "two\nlines");
    assert.equal(msgs[1].attachments.length, 2);
  });

  it("reads an older package's CSV", async () => {
    const msgs = await readDiscordDm(files, "22");
    assert.deepEqual(msgs.map((m) => m.text), ["hei, du", "she said \"hi\"\nback"]);
  });

  it("finds when the soonest signed link stops working", () => {
    const urls = ["https://cdn.discordapp.com/x?ex=6540a1b0&is=1", "https://cdn.discordapp.com/y?ex=6540a0b0&is=1", "https://cdn.discordapp.com/z"];
    assert.equal(linksExpireAt(urls), 0x6540a0b0 * 1000);
    assert.equal(linksExpireAt(["https://cdn.discordapp.com/z"]), null);
  });

  it("parses the small formats on their own", () => {
    assert.deepEqual(parseLooseJson('{"a": "x\ny",}'), { a: "x\ny" });
    assert.deepEqual(parseCsv("A,B\n1,\"2,3\"\n"), [{ A: "1", B: "2,3" }]);
    assert.equal(parseDiscordTime("2023-04-12 21:14:00"), Date.UTC(2023, 3, 12, 21, 14));
    assert.equal(parseDiscordTime("nonsense"), null);
  });
});
