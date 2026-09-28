/* Reactions on an MLS message live only in each device's archive. One reducer for both apps,
   in the `{ src, amount, users }` shape the server sends for every other message. */

export interface MlsReaction {
  src: string;
  amount: number;
  users: string[];
}

/** Adding twice or removing what isn't there changes nothing, so replays and reorders are safe. */
export function applyMlsReaction(
  reactions: readonly MlsReaction[] | null | undefined,
  change: { emoji: string; userId: string; action: "add" | "remove" },
): MlsReaction[] {
  const { emoji, userId, action } = change;
  const list = (reactions ?? []).map((r) => ({ src: r.src, amount: r.users.length, users: [...r.users] }));
  const existing = list.find((r) => r.src === emoji);
  if (action === "add") {
    if (!existing) list.push({ src: emoji, amount: 1, users: [userId] });
    else if (!existing.users.includes(userId)) {
      existing.users.push(userId);
      existing.amount = existing.users.length;
    }
    return list;
  }
  if (existing) {
    existing.users = existing.users.filter((u) => u !== userId);
    existing.amount = existing.users.length;
  }
  return list.filter((r) => r.amount > 0);
}

/** What a tap on a reaction chip means for this person: take theirs off, or put it on. */
export function mlsReactionAction(
  reactions: readonly MlsReaction[] | null | undefined,
  emoji: string,
  userId: string,
): "add" | "remove" {
  return reactions?.some((r) => r.src === emoji && r.users.includes(userId)) ? "remove" : "add";
}
