import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeCode, normalizeHost, parseServerInput } from "./address.ts";

/**
 * Ported from the phone, which was the only side that had them. The desktop
 * had the same three functions and no tests at all, so moving the code here
 * gives it the coverage it never had rather than merely relocating it.
 *
 * Converted from vitest to node:test, which is what this package runs. The
 * cases and the values are unchanged — a ported test that was quietly reworded
 * on the way is not the test that was passing before.
 */

describe("normalizeHost", () => {
  it("strips schemes, paths and whitespace", () => {
    assert.equal(normalizeHost("https://gryt.chat/foo"), "gryt.chat");
    assert.equal(normalizeHost("wss://gryt.chat"), "gryt.chat");
    assert.equal(normalizeHost("  gryt.chat  "), "gryt.chat");
    assert.equal(normalizeHost("gryt chat"), "grytchat");
  });

  it("keeps the port, which is part of the address", () => {
    assert.equal(normalizeHost("http://localhost:5001/"), "localhost:5001");
    assert.equal(normalizeHost("192.168.1.42:5001"), "192.168.1.42:5001");
  });

  it("answers empty for nothing", () => {
    assert.equal(normalizeHost(""), "");
    assert.equal(normalizeHost("   "), "");
  });
});

describe("normalizeCode", () => {
  it("lowercases and strips whitespace", () => {
    assert.equal(normalizeCode("  AbC 123 "), "abc123");
  });

  /* What comes back is what `inviteCodes.ts` stores and what the join sends.
     The server lowercases and trims before it looks an invite up, so a code
     that survives this unchanged is one it will actually match. */
  it("leaves a code that is already in the sent form alone", () => {
    assert.equal(normalizeCode("xytkjuwh8png"), "xytkjuwh8png");
  });

  /* The server trims but does not squeeze, so it would refuse this one. Codes
     get typed off a screen in groups, and the desktop client has always
     accepted that — the two disagreeing about which codes work is worse than
     being more forgiving than the server. */
  it("closes the gaps in a code somebody typed in groups", () => {
    assert.equal(normalizeCode("xytk juwh 8png"), "xytkjuwh8png");
  });

  it("has nothing to say about an empty or absent code", () => {
    assert.equal(normalizeCode(""), "");
    assert.equal(normalizeCode("   "), "");
    assert.equal(normalizeCode(undefined as unknown as string), "");
  });
});

describe("parseServerInput", () => {
  it("reads a full invite link's host and code, not the link's own host", () => {
    // The trap: normalizeHost alone returns gryt.chat, and joining that instead
    // of the server named in the query is a confusing failure.
    assert.deepEqual(parseServerInput("https://gryt.chat/invite?host=chat.example.com&code=ABC123"), { host: "chat.example.com", code: "abc123" });
  });

  it("reads a gryt:// invite, where 'invite' is the authority", () => {
    assert.deepEqual(parseServerInput("gryt://invite?host=chat.example.com&code=ABC123"), { host: "chat.example.com", code: "abc123" });
  });

  it("reads a legacy /invite/<code> link against the default host", () => {
    assert.deepEqual(parseServerInput("https://app.gryt.chat/invite/XYZ"), {
      host: "app.gryt.chat",
      code: "xyz",
    });
  });

  it("takes the default legacy host from the caller when given one", () => {
    assert.deepEqual(parseServerInput("https://anything.example/invite/XYZ", {
        defaultLegacyHost: "other.example",
      }), { host: "other.example", code: "xyz" });
  });

  it("treats a plain address as an address, with no code", () => {
    assert.deepEqual(parseServerInput("chat.example.com"), {
      host: "chat.example.com",
      code: "",
    });
    assert.deepEqual(parseServerInput("localhost:5001"), {
      host: "localhost:5001",
      code: "",
    });
  });

  it("does not mistake a bare hostname for a URL", () => {
    // `new URL("gryt.chat")` parses in some engines with "gryt.chat" as the
    // protocol, which is why the scheme is checked first.
    assert.equal(parseServerInput("gryt.chat").host, "gryt.chat");
  });

  it("falls through to an address when a link does not parse", () => {
    // A typo in a URL should get the address treatment rather than an error
    // about invite formats.
    assert.notEqual(parseServerInput("https://not a url/invite").host, "");
  });

  it("answers empty for nothing", () => {
    assert.deepEqual(parseServerInput(""), { host: "", code: "" });
    assert.deepEqual(parseServerInput("   "), { host: "", code: "" });
  });
});
