import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inviteLink, isPublicHost, normalizeCode, normalizeHost, parseServerInput } from "./address.ts";

/**
 * Ported from the phone, which was the only side that had them; the desktop had the same
 * three functions and none. The cases and the values are unchanged.
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

  /* What comes back is what `inviteCodes.ts` stores and what the join sends. The server
     lowercases and trims before looking an invite up, so a survivor will match. */
  it("leaves a code that is already in the sent form alone", () => {
    assert.equal(normalizeCode("xytkjuwh8png"), "xytkjuwh8png");
  });

  /* The server trims but does not squeeze, so it would refuse this one. Codes get typed off
     a screen in groups, and the two clients disagreeing is worse than being forgiving. */
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

  /* GRYT-1291. It fell through to the plain-address branch and returned gryt.chat, the
     link's own host, so pasting a link to an open server joined the wrong one. */
  it("reads a link with only a host as that server, with no code", () => {
    assert.deepEqual(parseServerInput("https://gryt.chat/invite?host=community.gryt.chat"), {
      host: "community.gryt.chat",
      code: "",
    });
    assert.deepEqual(parseServerInput("gryt://invite?host=chat.example.com:5001"), {
      host: "chat.example.com:5001",
      code: "",
    });
    assert.deepEqual(parseServerInput("https://app.gryt.chat/invite?host=chat.example.com&code="), {
      host: "chat.example.com",
      code: "",
    });
  });

  it("still reads a legacy code in the path ahead of a host with no code", () => {
    assert.deepEqual(parseServerInput("https://app.gryt.chat/invite/XYZ?host=chat.example.com"), {
      host: "app.gryt.chat",
      code: "xyz",
    });
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

describe("inviteLink", () => {
  it("builds the link parseServerInput reads back", () => {
    const withCode = inviteLink("chat.example.com:5001", "ABC123");
    assert.equal(withCode, "https://gryt.chat/invite?host=chat.example.com%3A5001&code=abc123");
    assert.deepEqual(parseServerInput(withCode), { host: "chat.example.com:5001", code: "abc123" });
  });

  it("leaves the code out entirely for a server anyone can join", () => {
    const hostOnly = inviteLink("community.gryt.chat");
    assert.equal(hostOnly, "https://gryt.chat/invite?host=community.gryt.chat");
    assert.equal(inviteLink("community.gryt.chat", "   "), hostOnly);
    assert.deepEqual(parseServerInput(hostOnly), { host: "community.gryt.chat", code: "" });
  });

  it("keeps an IPv6 address in brackets through the round trip", () => {
    const link = inviteLink("[2001:db8::1]:5001");
    assert.deepEqual(parseServerInput(link), { host: "[2001:db8::1]:5001", code: "" });
  });
});

describe("isPublicHost", () => {
  it("accepts names and addresses that work from anywhere", () => {
    for (const host of [
      "community.gryt.chat",
      "chat.example.com:5001",
      "https://chat.example.com/",
      "Chat.Example.COM.",
      "8.8.8.8",
      "203.0.113.7:5001",
      "[2001:db8::1]:5001",
    ]) {
      assert.equal(isPublicHost(host), true, host);
    }
  });

  it("refuses loopback, which points at whoever opens the link", () => {
    for (const host of ["localhost:5001", "127.0.0.1:5001", "127.8.9.10", "[::1]:5001", "::1", "app.localhost"]) {
      assert.equal(isPublicHost(host), false, host);
    }
  });

  it("refuses private, link-local and CGNAT ranges", () => {
    for (const host of [
      "10.0.0.4",
      "172.16.0.1",
      "172.31.255.255:5001",
      "192.168.1.42:5001",
      "169.254.10.10",
      "100.64.0.1",
      "100.101.102.103",
      "0.0.0.0",
      "[fd12:3456::1]:5001",
      "fe80::1",
      "::ffff:192.168.1.5",
    ]) {
      assert.equal(isPublicHost(host), false, host);
    }
  });

  it("does not mistake the edges of those ranges for them", () => {
    for (const host of ["172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "::ffff:8.8.8.8"]) {
      assert.equal(isPublicHost(host), true, host);
    }
  });

  it("refuses names that only resolve on one network", () => {
    for (const host of ["nas", "nas:5001", "box.local", "gryt.lan", "server.home", "gryt.internal", "gryt.home.arpa"]) {
      assert.equal(isPublicHost(host), false, host);
    }
  });

  it("refuses nothing and nonsense", () => {
    for (const host of ["", "   ", "999.1.1.1"]) {
      assert.equal(isPublicHost(host), false, host);
    }
  });
});
