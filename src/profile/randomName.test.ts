import assert from "node:assert/strict";
import { test } from "node:test";

import { NAME_POOL, pickRandomName } from "./randomName.ts";

test("the pool is big enough that a room rarely doubles up", () => {
  // The size is the whole reason for the list: two people called the same
  // thing in a member list is the confusion the shared placeholder caused.
  assert.ok(NAME_POOL.length >= 150, `pool is only ${NAME_POOL.length}`);
});

test("every name is unique", () => {
  assert.equal(new Set(NAME_POOL).size, NAME_POOL.length);
});

test("every name is plain, short and capitalised", () => {
  // These go in front of strangers on somebody else's server and get read
  // aloud in voice chat. Anything needing a spelling is the wrong shape.
  for (const name of NAME_POOL) {
    assert.match(name, /^[A-Z][a-z]+$/, `${name} is not one capitalised English word`);
    assert.ok(name.length <= 12, `${name} is too long to sit in a member list`);
  }
});

test("picks from the pool and nowhere else", () => {
  const pool = new Set(NAME_POOL);
  for (let i = 0; i < 500; i++) {
    assert.ok(pool.has(pickRandomName()));
  }
});

test("picking is spread across the pool rather than stuck", () => {
  // A rounding mistake in the index would show up as one name every time, or
  // as the last name never appearing.
  const seen = new Set<string>();
  for (let i = 0; i < 5000; i++) seen.add(pickRandomName());
  assert.ok(seen.size > NAME_POOL.length / 2, `only ${seen.size} distinct names in 5000 picks`);
});
