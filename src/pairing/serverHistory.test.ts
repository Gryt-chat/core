import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HistoryStoreError } from "./historyStore.ts";
import { FakeClock } from "./relay.fake.ts";
import { chooseHistoryServer, historyStoreError, serverHistoryStore, type HistoryFetch } from "./serverHistory.ts";

const access = {
  base: (host: string) => `https://${host}`,
  token: async (host: string) => (host === "off.example" ? null : `token-for-${host}`),
};

function fakeServer() {
  const calls: string[] = [];
  const fetch: HistoryFetch = async (url, init) => {
    calls.push(`${init.method} ${url} ${init.headers?.authorization ?? ""}`.trim());
    const reply = (status: number, body: { linkHistory?: boolean } | null = null, bytes = new Uint8Array()) => ({
      status,
      json: async () => body,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    });
    if (url.endsWith("/info")) return reply(200, { linkHistory: !url.includes("closed.example") });
    if (init.method === "GET") return reply(200, null, new Uint8Array([1, 2, 3]));
    return reply(204);
  };
  return { calls, fetch };
}

describe("history on the user's own server (GRYT-2055)", () => {
  it("picks a server this device is on that says yes, and never falls back to anything else", async () => {
    const { fetch } = fakeServer();
    const choose = chooseHistoryServer(access, fetch, new FakeClock());
    const held = await choose([{ host: "off.example" }, { host: "closed.example" }, { host: "open.example" }] as never);
    assert.equal(held?.host, "open.example", "skips one with no session here and one that said no");
    assert.match(held?.transfer ?? "", /^[A-Za-z0-9_-]{24}$/);
    assert.equal(await choose([{ host: "closed.example" }] as never), null);
    assert.equal(await choose([]), null, "no servers, no DMs, nothing to hold");
  });

  it("puts, gets and deletes a chunk at its own address, with the server's token", async () => {
    const { calls, fetch } = fakeServer();
    const store = serverHistoryStore(access, "open.example", "T".repeat(24), fetch, new FakeClock());
    await store.put(3, new Uint8Array([9]));
    assert.deepEqual(await store.get(3), new Uint8Array([1, 2, 3]));
    await store.delete(3);
    const at = `https://open.example/api/link-history/${"T".repeat(24)}/3 Bearer token-for-open.example`;
    assert.deepEqual(calls, [`PUT ${at}`, `GET ${at}`, `DELETE ${at}`]);
  });

  it("waits for the new device's token, which comes once it has joined", async () => {
    const { fetch } = fakeServer();
    const clock = new FakeClock();
    let joined = false;
    const store = serverHistoryStore({ ...access, token: () => (joined ? "late" : null) }, "open.example", "T".repeat(24), fetch, clock);
    const got = store.get(0);
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
      clock.advance(1000);
    }
    joined = true;
    clock.advance(1000);
    assert.deepEqual(await got, new Uint8Array([1, 2, 3]));
  });

  it("sorts the server's answers into retry, full, missing and refused", async () => {
    assert.deepEqual(
      [404, 413, 429, 401, 500, 503, 403].map((s) => historyStoreError(s).code),
      ["missing", "full", "full", "network", "network", "refused", "refused"],
    );
    const offline = serverHistoryStore(access, "open.example", "T".repeat(24), async () => {
      throw new TypeError("Network request failed");
    }, new FakeClock());
    await assert.rejects(offline.get(0), (e: Error) => e instanceof HistoryStoreError && e.code === "network");
  });
});
