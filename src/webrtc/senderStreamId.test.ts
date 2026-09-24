import assert from "node:assert/strict";
import { test } from "node:test";

import { senderStreamId } from "./senderStreamId.ts";

test("returns streamId unchanged with no connection", () => {
  assert.equal(senderStreamId(null, "camera", "s1"), "s1");
  assert.equal(senderStreamId(undefined, "camera", "s1"), "s1");
});

test("keeps the first stream id given for a role on a connection", () => {
  const pc = {};
  assert.equal(senderStreamId(pc, "camera", "s1"), "s1");
  // A later track (replaceTrack) offers a new stream id; the first one wins.
  assert.equal(senderStreamId(pc, "camera", "s2"), "s1");
});

test("tracks each role on a connection independently", () => {
  const pc = {};
  assert.equal(senderStreamId(pc, "camera", "cam1"), "cam1");
  assert.equal(senderStreamId(pc, "screenVideo", "scr1"), "scr1");
  assert.equal(senderStreamId(pc, "camera", "cam2"), "cam1");
  assert.equal(senderStreamId(pc, "screenVideo", "scr2"), "scr1");
});

test("does not mix up two connections", () => {
  const pcA = {};
  const pcB = {};
  assert.equal(senderStreamId(pcA, "camera", "a1"), "a1");
  assert.equal(senderStreamId(pcB, "camera", "b1"), "b1");
  assert.equal(senderStreamId(pcA, "camera", "a2"), "a1");
  assert.equal(senderStreamId(pcB, "camera", "b2"), "b1");
});
