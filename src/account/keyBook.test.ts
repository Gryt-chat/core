import assert from "node:assert/strict";
import { test } from "node:test";

import { foreignKeyDay, type KeyBookEntry, keyBookId } from "./keyBook.ts";

const mine = "mine";
const book: KeyBookEntry[] = [{ day: "2026-10-01", thumb: mine, how: "first" }];
const seen = new Set(book.map(keyBookId));

test("the first look only remembers", () => assert.equal(foreignKeyDay(book, mine, null), null));
test("nothing new", () => assert.equal(foreignKeyDay(book, mine, seen), null));
test("a key none of your devices made", () =>
  assert.equal(foreignKeyDay([...book, { day: "2026-11-16", thumb: "theirs", how: "reset" }], mine, seen), "2026-11-16"));
test("a key leaving is not news", () =>
  assert.equal(foreignKeyDay([...book, { day: "2026-11-16", thumb: "old", how: "retired" }], mine, seen), null));
test("this device's own key", () =>
  assert.equal(foreignKeyDay([...book, { day: "2026-11-16", thumb: mine, how: "kept" }], mine, seen), null));
