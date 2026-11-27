import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bindChallengeToServer } from "./joinBinding.ts";

describe("bindChallengeToServer", () => {
  it("binds to the proved key when the challenge names it", () => {
    assert.deepEqual(bindChallengeToServer("kT", "kT"), { claims: { server_key: "kT" } });
  });

  it("refuses a challenge naming another server's key", () => {
    assert.ok("refuse" in bindChallengeToServer("kT", "kM"));
  });

  it("refuses a challenge naming a key when this connection proved none", () => {
    assert.ok("refuse" in bindChallengeToServer("kT", null));
  });

  it("still binds to the proved key when the challenge leaves the field out", () => {
    assert.deepEqual(bindChallengeToServer(undefined, "kM"), { claims: { server_key: "kM" } });
  });

  it("signs unbound for a server with no identity key", () => {
    assert.deepEqual(bindChallengeToServer(undefined, null), { claims: {} });
  });
});
