import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MlsDmContent } from "../mls/content.ts";
import { importId, type ImportFile, runDiscordImport } from "./discordImportJob.ts";

const key = { id: "k", key: Buffer.alloc(32).toString("base64url"), iv: Buffer.alloc(12).toString("base64url") };

function deps() {
  const sent: Extract<MlsDmContent, { type: "import" }>[] = [];
  const stored = new Map<string, Omit<ImportFile, "name">>();
  const downloaded: string[] = [];
  let n = 0;
  return {
    sent,
    stored,
    downloaded,
    deps: {
      send: async (c: MlsDmContent) => void sent.push(c as Extract<MlsDmContent, { type: "import" }>),
      download: async (url: string) => {
        downloaded.push(url);
        return url.endsWith("gone.png") ? null : { type: "image/png", bytes: new Uint8Array([1, 2, 3]) };
      },
      upload: async (f: ImportFile) => ({ id: `up-${++n}`, key: { ...key, name: f.name } }),
      store: {
        has: async (u: string) => stored.has(u),
        put: async (u: string, f: Omit<ImportFile, "name">) => void stored.set(u, f),
        take: async (u: string) => stored.get(u) ?? null,
        drop: async (u: string) => void stored.delete(u),
      },
      sleep: async () => {},
      newId: () => `b${n++}`,
    },
  };
}

describe("the Discord import job (GRYT-1965)", () => {
  it("sends text first, then files, keeps a dead link as a note, and downloads a shared link once", async () => {
    const d = deps();
    const result = await runDiscordImport(
      [
        { discordId: "1", sentAt: 1, text: "hei", attachments: [] },
        { discordId: "2", sentAt: 2, text: "pics", attachments: ["https://cdn.discordapp.com/a.png", "https://cdn.discordapp.com/gone.png"] },
        { discordId: "3", sentAt: 3, text: "", attachments: ["https://cdn.discordapp.com/a.png"] },
      ],
      d.deps,
      { paused: () => false, stopped: () => false },
      () => {},
    );
    assert.equal(d.sent[0].entries[0].id, importId("1"));
    const withFiles = d.sent.slice(1).flatMap((b) => b.entries);
    assert.deepEqual(withFiles.map((e) => e.id), [importId("2"), importId("3")]);
    assert.equal(Object.keys(withFiles[0].attachments ?? {}).length, 1);
    assert.match(withFiles[0].text, /^pics\nA file from Discord couldn.t be downloaded\.$/);
    assert.deepEqual(Object.keys(withFiles[1].attachments ?? {}), Object.keys(withFiles[0].attachments ?? {}), "a file two messages share is uploaded once");
    assert.equal(d.downloaded.filter((u) => u.endsWith("a.png")).length, 1);
    assert.equal(d.stored.size, 0, "the store is emptied as files go up");
    assert.equal(result.missing, 1);
    assert.equal(result.messages.done, 3);
  });

  it("skips a download the store already has, which is how a second run carries on", async () => {
    const d = deps();
    d.stored.set("https://cdn.discordapp.com/a.png", { type: "image/png", bytes: new Uint8Array([9]) });
    await runDiscordImport([{ discordId: "2", sentAt: 2, text: "", attachments: ["https://cdn.discordapp.com/a.png"] }], d.deps, { paused: () => false, stopped: () => false }, () => {});
    assert.deepEqual(d.downloaded, []);
  });

  it("sends nothing more once stopped", async () => {
    const d = deps();
    let stop = false;
    await runDiscordImport(
      Array.from({ length: 500 }, (_, i) => ({ discordId: String(i), sentAt: i, text: "x".repeat(300), attachments: [] })),
      { ...d.deps, send: async (c: MlsDmContent) => { d.sent.push(c as Extract<MlsDmContent, { type: "import" }>); stop = true; } },
      { paused: () => false, stopped: () => stop },
      () => {},
    );
    assert.equal(d.sent.length, 1);
  });
});
