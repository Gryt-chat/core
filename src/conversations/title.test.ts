import assert from "node:assert/strict";
import { test } from "node:test";

import { conversationTitle, type DirectConversation } from "./title.ts";

const member = (nickname: string) => ({
  server_user_id: nickname,
  nickname,
  avatar_file_id: null,
  avatar_worn: null,
});

const conv = (over: Partial<DirectConversation>): DirectConversation =>
  ({
    conversation_id: "dm_1",
    kind: "dm",
    name: null,
    avatar_url: null,
    members: [member("ada")],
    other: member("ada"),
    last_message_at: null,
    unread: 0,
    ...over,
  }) as DirectConversation;

test("a one-to-one is the other person", () => {
  assert.equal(conversationTitle(conv({ other: member("grace") })), "grace");
});

test("a named group is its name", () => {
  assert.equal(
    conversationTitle(conv({ kind: "group", name: "Lunch", members: [member("ada")] })),
    "Lunch",
  );
});

test("an unnamed pair is both names", () => {
  assert.equal(
    conversationTitle(
      conv({ kind: "group", members: [member("ada"), member("grace")] }),
    ),
    "ada and grace",
  );
});

test("an unnamed crowd is two names and a count", () => {
  assert.equal(
    conversationTitle(
      conv({
        kind: "group",
        members: [member("ada"), member("grace"), member("alan"), member("edsger")],
      }),
    ),
    "ada, grace and 2 more",
  );
});

test("an unnamed group with nobody in it is 'Group', not blank", () => {
  // The case the desktop was missing. `[].join(" and ")` is "", so it drew an
  // empty row for a group whose members had not arrived yet.
  assert.equal(conversationTitle(conv({ kind: "group", members: [] })), "Group");
});
