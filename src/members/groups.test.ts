import assert from "node:assert/strict";
import { test } from "node:test";

import {
  groupMembersByRole,
  OFFLINE_GROUP_KEY,
  UNGROUPED_GROUP_KEY,
  type GroupableMember,
  type GroupableRole,
} from "./groups.ts";

const ROLES: GroupableRole[] = [
  { id: "owner", name: "Owner", rank: 100, color: "#df6862" },
  { id: "mod", name: "Moderator", rank: 50, color: null },
  { id: "member", name: "Member", rank: 10, color: null },
  { id: "ghost", name: "Ghost", rank: 5, color: null },
];

interface TestMember extends GroupableMember {
  serverUserId: string;
  nickname: string;
}

const member = (nickname: string, role: string, status = "online"): TestMember => ({
  serverUserId: `u_${nickname}`,
  nickname,
  role,
  status,
});

const titles = (groups: { title: string }[]) => groups.map((g) => g.title);

test("runs highest rank first", () => {
  const groups = groupMembersByRole(
    [member("Mia", "member"), member("Ada", "owner"), member("Tor", "mod")],
    ROLES,
  );
  assert.deepEqual(titles(groups), ["Owner", "Moderator", "Member"]);
});

test("leaves out a role nobody holds", () => {
  const groups = groupMembersByRole([member("Ada", "owner")], ROLES);
  assert.deepEqual(
    groups.map((g) => g.key),
    ["owner"],
  );
});

test("takes offline out of its role", () => {
  // The rule worth stating: a moderator who is asleep is not an answer to "who
  // is around", so they leave Moderator rather than sitting at the bottom of it.
  const groups = groupMembersByRole(
    [member("Tor", "mod", "offline"), member("Ada", "owner")],
    ROLES,
  );
  assert.deepEqual(titles(groups), ["Owner", "Offline"]);
  assert.deepEqual(
    groups[1].members.map((m) => m.nickname),
    ["Tor"],
  );
});

test("an absent status is present, not offline", () => {
  // The one place the two apps disagreed. The server always sends a status —
  // `clients.ts` defaults it to `offline` — so nothing produces this except a
  // server too old to have the field, and on one of those the phone's rule put
  // every member into Offline and left the list looking empty.
  const noStatus: TestMember = { serverUserId: "u_nil", nickname: "Nil", role: "mod" };
  const groups = groupMembersByRole([noStatus], ROLES);
  assert.deepEqual(titles(groups), ["Moderator"]);
});

test("a status nobody recognises is present too", () => {
  // Same reasoning one step further out: a newer server inventing a status this
  // build has not heard of should not empty the list either.
  const groups = groupMembersByRole([member("Ada", "owner", "napping")], ROLES);
  assert.deepEqual(titles(groups), ["Owner"]);
});

test("sorts each group by name, ignoring case", () => {
  const groups = groupMembersByRole(
    [member("zoe", "member"), member("Ada", "member"), member("bo", "member")],
    ROLES,
  );
  assert.deepEqual(
    groups[0].members.map((m) => m.nickname),
    ["Ada", "bo", "zoe"],
  );
});

test("sorts a member with no nickname without throwing", () => {
  const anon: TestMember = { serverUserId: "u_anon", nickname: "", role: "member" };
  const groups = groupMembersByRole([member("Ada", "member"), anon], ROLES);
  assert.equal(groups[0].members.length, 2);
  assert.equal(groups[0].members[0].nickname, "");
});

test("puts a role the server never described after the named ones", () => {
  const groups = groupMembersByRole(
    [member("Ada", "owner"), member("Rem", "deleted-role")],
    ROLES,
  );
  assert.deepEqual(titles(groups), ["Owner", "Everyone else"]);
  assert.equal(groups[1].key, UNGROUPED_GROUP_KEY);
});

test("calls the group Members when there are no named ones at all", () => {
  // What a server too old to send roles looks like: one list, not a blank
  // heading over everybody.
  const groups = groupMembersByRole([member("Ada", "member"), member("Bo", "member")], []);
  assert.deepEqual(titles(groups), ["Members"]);
  assert.equal(groups[0].members.length, 2);
});

test("falls back to the role id when the server named it nothing", () => {
  const groups = groupMembersByRole([member("Ada", "shy")], [{ id: "shy", rank: 1 }]);
  assert.deepEqual(titles(groups), ["shy"]);
});

test("carries the role's colour, and null for one without", () => {
  const groups = groupMembersByRole([member("Ada", "owner"), member("Tor", "mod")], ROLES);
  assert.equal(groups[0].color, "#df6862");
  assert.equal(groups[1].color, null);
});

test("the offline group carries the key callers fade on", () => {
  const groups = groupMembersByRole([member("Tor", "mod", "offline")], ROLES);
  assert.equal(groups[0].key, OFFLINE_GROUP_KEY);
});

test("says nothing when nobody is there", () => {
  assert.deepEqual(groupMembersByRole([], ROLES), []);
});

test("does not reorder the caller's arrays", () => {
  // Both apps pass state straight in, so sorting in place would be a mutation
  // of something React is holding.
  const members = [member("zoe", "member"), member("Ada", "member")];
  const roles = [...ROLES];
  groupMembersByRole(members, roles);
  assert.deepEqual(
    members.map((m) => m.nickname),
    ["zoe", "Ada"],
  );
  assert.deepEqual(
    roles.map((r) => r.id),
    ROLES.map((r) => r.id),
  );
});
