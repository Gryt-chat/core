import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cellState,
  indexRules,
  nextCellState,
  scopeSetPayload,
  withCell,
  type ChannelRule,
} from "./channelRules.ts";

const rules: ChannelRule[] = [
  { roleId: "role_admin", permission: "send_messages", effect: "allow" },
  { roleId: "role_admin", permission: "manage_channel", effect: "deny" },
  { roleId: "role_guest", permission: "send_messages", effect: "deny" },
];

test("a cell reads back what was indexed for it", () => {
  const index = indexRules(rules);
  assert.equal(cellState(index, "role_admin", "send_messages"), "allow");
  assert.equal(cellState(index, "role_admin", "manage_channel"), "deny");
  assert.equal(cellState(index, "role_guest", "send_messages"), "deny");
});

test("a cell with no row inherits", () => {
  // Inherit is the absence of a row, not a third value the server stores.
  const index = indexRules(rules);
  assert.equal(cellState(index, "role_guest", "manage_channel"), "inherit");
  assert.equal(cellState(index, "role_nobody", "send_messages"), "inherit");
  assert.equal(cellState(indexRules([]), "role_admin", "send_messages"), "inherit");
});

test("the key separator cannot be forged out of the two halves", () => {
  /* The desktop joined role and permission with a NUL and the phone with a
     space, and the space is the weaker of the two: any id containing one lets a
     different pair land on the same key. Nothing in Gryt has a space in either
     half today, which is why the drift went unnoticed rather than being a bug.

     These two pairs collide under a space and do not under a NUL. */
  const spacey: ChannelRule[] = [
    { roleId: "role a", permission: "b", effect: "allow" },
    { roleId: "role", permission: "a b", effect: "deny" },
  ];
  const index = indexRules(spacey);
  assert.equal(cellState(index, "role a", "b"), "allow");
  assert.equal(cellState(index, "role", "a b"), "deny");
});

test("setting a cell replaces the row rather than adding a second", () => {
  const next = withCell(rules, "role_admin", "send_messages", "deny");
  const matching = next.filter(
    (r) => r.roleId === "role_admin" && r.permission === "send_messages",
  );
  assert.equal(matching.length, 1);
  assert.equal(matching[0].effect, "deny");
});

test("setting a cell to inherit removes the row", () => {
  const next = withCell(rules, "role_admin", "send_messages", "inherit");
  assert.equal(
    next.some((r) => r.roleId === "role_admin" && r.permission === "send_messages"),
    false,
  );
  // And leaves the others alone.
  assert.equal(next.length, rules.length - 1);
});

test("setting a cell that had no row adds one", () => {
  const next = withCell(rules, "role_guest", "manage_channel", "allow");
  assert.equal(next.length, rules.length + 1);
  assert.equal(cellState(indexRules(next), "role_guest", "manage_channel"), "allow");
});

test("the cell cycles inherit, deny, allow, and back", () => {
  // Deny before allow on purpose: taking something away is the commoner edit,
  // so it is the one a single tap reaches.
  assert.equal(nextCellState("inherit"), "deny");
  assert.equal(nextCellState("deny"), "allow");
  assert.equal(nextCellState("allow"), "inherit");
});

test("what gets sent for each kind of scope choice", () => {
  assert.deepEqual(scopeSetPayload({ kind: "everyone" }, rules), { templateId: null });
  assert.deepEqual(scopeSetPayload({ kind: "template", templateId: "t1" }, rules), {
    templateId: "t1",
  });
  assert.deepEqual(scopeSetPayload({ kind: "custom" }, rules), { custom: true, rules });
});

test("an empty rule set indexes to an empty map", () => {
  assert.equal(indexRules([]).size, 0);
});

test("a later row wins over an earlier one for the same cell", () => {
  // The server should not send two, but if it does, last write is the answer
  // rather than an arbitrary one.
  const duplicated: ChannelRule[] = [
    { roleId: "r", permission: "p", effect: "allow" },
    { roleId: "r", permission: "p", effect: "deny" },
  ];
  assert.equal(cellState(indexRules(duplicated), "r", "p"), "deny");
});
