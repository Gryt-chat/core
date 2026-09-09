/* Inherit is the absence of a row, so a cell has three states and only two are written.
   `indexRules` keys on NUL, written as `\u0000` or git treats the file as binary. */

export type RuleEffect = "allow" | "deny";

/** What one cell in the matrix is showing. */
export type CellState = "inherit" | RuleEffect;

export interface ChannelRule {
  roleId: string;
  permission: string;
  effect: RuleEffect;
}

/** The choice in the channel's dropdown, before any matrix is drawn. */
export type ScopeChoice =
  | { kind: "everyone" }
  | { kind: "template"; templateId: string }
  | { kind: "custom" };

/** The dropdown value that means "this channel has its own rules". */
export const CUSTOM_VALUE = "custom";

/**
 * The dropdown value that means "no rules at all". A word rather than an empty string: the
 * Select reads "" as "nothing chosen" and paints its placeholder over the label.
 */
export const EVERYONE_VALUE = "everyone";

/** Look up one cell without scanning the whole list per cell. */
export function indexRules(rules: ChannelRule[]): Map<string, RuleEffect> {
  const byCell = new Map<string, RuleEffect>();
  for (const rule of rules) byCell.set(`${rule.roleId}\u0000${rule.permission}`, rule.effect);
  return byCell;
}

export function cellState(
  index: Map<string, RuleEffect>,
  roleId: string,
  permission: string,
): CellState {
  return index.get(`${roleId}\u0000${permission}`) ?? "inherit";
}

/**
 * The next state when somebody clicks a cell: inherit, deny, allow, inherit. Deny first,
 * because taking something away is what people open this to do.
 */
export function nextCellState(current: CellState): CellState {
  if (current === "inherit") return "deny";
  if (current === "deny") return "allow";
  return "inherit";
}

/** Set one cell, dropping the row entirely when it goes back to inherit. */
export function withCell(
  rules: ChannelRule[],
  roleId: string,
  permission: string,
  state: CellState,
): ChannelRule[] {
  const without = rules.filter((r) => !(r.roleId === roleId && r.permission === permission));
  if (state === "inherit") return without;
  return [...without, { roleId, permission, effect: state }];
}

/**
 * Which dropdown value a channel is showing. A scope that is not a template is this
 * channel's own, which is Custom; no scope at all is Everyone.
 */
export function scopeChoiceValue(scopeId: string | null, isTemplate: boolean): string {
  if (!scopeId) return EVERYONE_VALUE;
  return isTemplate ? scopeId : CUSTOM_VALUE;
}

/** Turn the dropdown value back into what the server event wants. */
export function scopeChoiceFromValue(value: string): ScopeChoice {
  if (value === CUSTOM_VALUE) return { kind: "custom" };
  if (value === EVERYONE_VALUE || value === "") return { kind: "everyone" };
  return { kind: "template", templateId: value };
}

/**
 * The payload for `server:channels:scope:set`. Templates deliberately do not carry rules:
 * editing one from a channel would change every other channel using it.
 */
export function scopeSetPayload(
  choice: ScopeChoice,
  rules: ChannelRule[],
): { templateId?: string | null; custom?: boolean; rules?: ChannelRule[] } {
  if (choice.kind === "custom") return { custom: true, rules };
  if (choice.kind === "template") return { templateId: choice.templateId };
  return { templateId: null };
}

/**
 * The dropdown options: Everyone, then each template, then Custom. Custom last, because it
 * is the escape hatch and reaching for it is the uncommon choice.
 */
export function scopeOptions(
  templates: { id: string; name: string | null }[],
): { label: string; value: string }[] {
  return [
    { label: "Everyone", value: EVERYONE_VALUE },
    ...templates
      .filter((t) => t.name)
      .map((t) => ({ label: t.name as string, value: t.id })),
    { label: "Custom…", value: CUSTOM_VALUE },
  ];
}

/**
 * A one-line summary of what a set of rules does. Reading is called out on its own: a role
 * denied `read_messages` is shown nothing at all rather than a locked channel.
 */
export function describeRules(
  rules: ChannelRule[],
  roleNames: Map<string, string>,
): string {
  if (rules.length === 0) return "Everyone on the server can see and use this channel.";

  const hidden = rules
    .filter((r) => r.permission === "read_messages" && r.effect === "deny")
    .map((r) => roleNames.get(r.roleId) ?? r.roleId);

  const others = rules.filter((r) => r.permission !== "read_messages").length;

  if (hidden.length === 0) {
    return `${others} change${others === 1 ? "" : "s"} to what roles can do here.`;
  }

  const list =
    hidden.length === 1
      ? hidden[0]
      : `${hidden.slice(0, -1).join(", ")} and ${hidden[hidden.length - 1]}`;
  const rest = others > 0 ? `, and ${others} other change${others === 1 ? "" : "s"}` : "";
  return `${list} will not see this channel at all${rest}.`;
}
