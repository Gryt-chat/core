import assert from "node:assert/strict";
import { test } from "node:test";

import { describeFolderRules, folderFollowNote, folderPhrase } from "./folderRules.ts";
import type { ChannelRule } from "./channelRules.ts";

test("folderPhrase names the folder, or falls back to 'its folder'", () => {
  assert.equal(folderPhrase("Design"), "the Design folder");
  assert.equal(folderPhrase(null), "its folder");
});

test("folderFollowNote reads the same with and without a folder name", () => {
  assert.equal(folderFollowNote("Design"), "Has its own permissions instead of the Design folder's.");
  assert.equal(folderFollowNote(null), "Has its own permissions instead of its folder's.");
});

test("describeFolderRules: no rules means everyone", () => {
  assert.equal(
    describeFolderRules([], new Map()),
    "Everyone on the server can see and use the channels in this folder.",
  );
});

test("describeFolderRules: hidden roles are named, other changes are counted", () => {
  const rules: ChannelRule[] = [
    { roleId: "role_guest", permission: "read_messages", effect: "deny" },
    { roleId: "role_admin", permission: "send_messages", effect: "allow" },
  ];
  const roleNames = new Map([["role_guest", "Guest"]]);
  assert.equal(
    describeFolderRules(rules, roleNames),
    "Guest won't see this folder or anything in it, and 1 other change.",
  );
});

test("describeFolderRules: no hidden roles, only other changes", () => {
  const rules: ChannelRule[] = [{ roleId: "role_admin", permission: "send_messages", effect: "allow" }];
  assert.equal(describeFolderRules(rules, new Map()), "1 change to what roles can do in this folder's channels.");
});
