import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MlsDmContent } from "../mls/content.ts";
import { type ImportDeps, importId, type ImportFile, retryAfterMs, runDiscordImport } from "./discordImportJob.ts";

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

  const control = { paused: () => false, stopped: () => false };
  const png = { type: "image/png", bytes: new Uint8Array([1]) };
  const oneFile = [{ discordId: "1", sentAt: 1, text: "", attachments: ["https://cdn.discordapp.com/a.png"] }];

  it("waits out a 429 and tries the file again", async () => {
    const d = deps();
    const waits: number[] = [];
    let calls = 0;
    const result = await runDiscordImport(
      oneFile,
      { ...d.deps, sleep: async (ms) => void waits.push(ms), download: async () => (++calls === 1 ? { retryAfterMs: 30_000 } : png) },
      control,
      () => {},
    );
    assert.equal(calls, 2);
    assert.equal(result.missing, 0);
    assert.ok(waits.some((w) => w > 29_000 && w <= 30_000), "waited as long as Discord asked");
  });

  it("gives up on a file that stays rate limited, and caps the wait", async () => {
    const d = deps();
    const waits: number[] = [];
    let calls = 0;
    const result = await runDiscordImport(
      oneFile,
      { ...d.deps, sleep: async (ms) => void waits.push(ms), download: async () => (calls++, { retryAfterMs: 3_600_000 }) },
      control,
      () => {},
    );
    assert.equal(calls, 6);
    assert.equal(result.missing, 1);
    assert.ok(Math.max(...waits) <= 60_000);
  });

  it("runs downloads and uploads together, as many as it's told", async () => {
    const urls = Array.from({ length: 8 }, (_, i) => `https://cdn.discordapp.com/attachments/1/${i}/f${i}.png`);
    const messages = urls.map((u, i) => ({ discordId: String(i), sentAt: 1_500_000_000_000 + i, text: "", attachments: [u] }));
    const files = new Map<string, { type: string; bytes: Uint8Array }>();
    let now = 0;
    let downloads = 0;
    let uploads = 0;
    const gate = async (add: (n: number) => void) => {
      add(1);
      await new Promise((r) => setTimeout(r, 1));
      add(-1);
    };
    const deps: ImportDeps = {
      send: async () => {},
      download: async () => {
        await gate((n) => { now += n; downloads = Math.max(downloads, now); });
        return { type: "image/png", bytes: new Uint8Array(1) };
      },
      upload: async (f) => {
        await gate((n) => { now += n; uploads = Math.max(uploads, now); });
        return { id: `id${f.name.replace(/\W/g, "")}`, key: { id: "k", key: "AA", iv: "AA" } };
      },
      store: {
        has: async (u) => files.has(u),
        put: async (u, f) => { files.set(u, f); },
        take: async (u) => files.get(u) ?? null,
        drop: async (u) => { files.delete(u); },
      },
      sleep: async () => {},
      newId: () => "b",
      transfersAtOnce: 3,
    };
    await runDiscordImport(messages, deps, { paused: () => false, stopped: () => false }, () => {});
    assert.equal(downloads, 3);
    assert.equal(uploads, 3);
  });

  it("waits out an upload 429, and notes a file too big for the server instead of stopping", async () => {
    const h = deps();
    let refused = 0;
    const sleeps: number[] = [];
    const url = (n: string) => `https://cdn.discordapp.com/attachments/1/2/${n}.png`;
    const messages = [
      { discordId: "1", sentAt: 1_500_000_000_000, text: "ok", attachments: [url("a")] },
      { discordId: "2", sentAt: 1_500_000_000_001, text: "big", attachments: [url("big")] },
    ];
    const done = await runDiscordImport(messages, {
      ...h.deps,
      sleep: async (ms: number) => void sleeps.push(ms),
      upload: async (f: ImportFile) => {
        if (f.name === "big.png") return { tooLarge: true as const };
        if (refused++ === 0) return { retryAfterMs: 1000 };
        return { id: "up", key };
      },
    }, { paused: () => false, stopped: () => false }, () => {});
    assert.equal(done.tooLarge, 1);
    assert.equal(done.missing, 0);
    assert.ok(sleeps.some((ms) => ms > 0));
    const entries = h.sent.flatMap((c) => c.entries);
    assert.deepEqual(Object.keys(entries.find((e) => e.text === "ok")?.attachments ?? {}), ["up"]);
    assert.match(entries.find((e) => e.text.startsWith("big"))?.text ?? "", /too big for this server/);
    assert.equal(h.stored.size, 0, "nothing is left in the store");
  });

  it("reads Retry-After in seconds, and falls back when it can't", () => {
    assert.equal(retryAfterMs("12"), 12_000);
    assert.equal(retryAfterMs(null), 5_000);
    assert.equal(retryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT"), 5_000);
  });
});
