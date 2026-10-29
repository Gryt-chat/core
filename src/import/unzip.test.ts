import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { constants, deflateRawSync } from "node:zlib";

import { listDiscordDms } from "./discordPackage.ts";
import { inflateRaw, openZipBytes } from "./unzip.ts";

function zip(files: Record<string, string>): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = new TextEncoder().encode(text);
    const data = deflateRawSync(raw);
    const n = new TextEncoder().encode(name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, 8, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, n.length, true);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(10, 8, true);
    dir.setUint32(20, data.length, true);
    dir.setUint32(24, raw.length, true);
    dir.setUint16(28, n.length, true);
    dir.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), n, data);
    central.push(new Uint8Array(dir.buffer), n);
    offset += 30 + n.length + data.length;
  }
  const size = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Uint8Array(Buffer.concat([...parts, ...central, new Uint8Array(end.buffer)]));
}

describe("our own inflate (GRYT-1965)", () => {
  it("matches zlib for stored, fixed and dynamic blocks", () => {
    const text = Buffer.from(JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ ID: String(i), Contents: `melding ${i % 37} æøå 🦉` }))));
    const inputs = [Buffer.alloc(0), Buffer.from("a"), text, randomBytes(70_000), Buffer.concat([text, randomBytes(5_000), text])];
    for (const input of inputs) {
      for (const level of [0, 1, 6, 9]) {
        for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FIXED]) {
          const packed = deflateRawSync(input, { level, strategy });
          assert.deepEqual(Buffer.from(inflateRaw(packed, input.length)), input, `level ${level}, strategy ${strategy}, ${input.length} bytes`);
        }
      }
    }
  });

  it("refuses damaged data instead of returning garbage", () => {
    assert.throws(() => inflateRaw(new Uint8Array([0xff, 0xff, 0xff]), 10));
  });

  it("opens a Discord package from a zip", async () => {
    const files = openZipBytes(zip({
      "Account/user.json": JSON.stringify({ id: "1" }),
      "Messages/index.json": JSON.stringify({ 11: "Direct Message with kari#0" }),
      "Messages/c11/channel.json": JSON.stringify({ type: 1, recipients: ["1", "2"] }),
      "Messages/c11/messages.json": JSON.stringify([{ ID: "9", Timestamp: "2023-04-12 21:14:00", Contents: "hei", Attachments: "" }]),
    }));
    const [dm] = await listDiscordDms(files);
    assert.equal(dm.name, "kari");
    assert.equal(dm.messages, 1);
    assert.throws(() => openZipBytes(new Uint8Array(100)), /isn't a zip/);
  });
});
