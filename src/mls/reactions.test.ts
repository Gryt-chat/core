import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyMlsReaction, mlsReactionAction, type MlsReaction } from "./reactions.ts";

describe("MLS reactions", () => {
  it("adds, stacks and removes in the server's shape", () => {
    let r: MlsReaction[] = applyMlsReaction(null, { emoji: "👍", userId: "kari", action: "add" });
    assert.deepEqual(r, [{ src: "👍", amount: 1, users: ["kari"] }]);
    r = applyMlsReaction(r, { emoji: "👍", userId: "ola", action: "add" });
    r = applyMlsReaction(r, { emoji: ":owl:", userId: "ola", action: "add" });
    assert.deepEqual(r, [
      { src: "👍", amount: 2, users: ["kari", "ola"] },
      { src: ":owl:", amount: 1, users: ["ola"] },
    ]);
    r = applyMlsReaction(r, { emoji: "👍", userId: "kari", action: "remove" });
    r = applyMlsReaction(r, { emoji: ":owl:", userId: "ola", action: "remove" });
    assert.deepEqual(r, [{ src: "👍", amount: 1, users: ["ola"] }]);
  });

  it("lands the same when an add or a remove arrives twice", () => {
    const once = applyMlsReaction([], { emoji: "👍", userId: "kari", action: "add" });
    assert.deepEqual(applyMlsReaction(once, { emoji: "👍", userId: "kari", action: "add" }), once);
    assert.deepEqual(applyMlsReaction([], { emoji: "👍", userId: "kari", action: "remove" }), []);
  });

  it("leaves the list it was given alone", () => {
    const before: MlsReaction[] = [{ src: "👍", amount: 1, users: ["kari"] }];
    applyMlsReaction(before, { emoji: "👍", userId: "ola", action: "add" });
    applyMlsReaction(before, { emoji: "👍", userId: "kari", action: "remove" });
    assert.deepEqual(before, [{ src: "👍", amount: 1, users: ["kari"] }]);
  });

  it("recounts rather than trusting a stored amount", () => {
    assert.deepEqual(applyMlsReaction([{ src: "👍", amount: 9, users: ["kari"] }], { emoji: "😂", userId: "ola", action: "add" })[0], {
      src: "👍",
      amount: 1,
      users: ["kari"],
    });
  });

  it("turns a tap into add or remove for this person", () => {
    const r: MlsReaction[] = [{ src: "👍", amount: 1, users: ["kari"] }];
    assert.equal(mlsReactionAction(r, "👍", "kari"), "remove");
    assert.equal(mlsReactionAction(r, "👍", "ola"), "add");
    assert.equal(mlsReactionAction(null, "👍", "kari"), "add");
  });
});
