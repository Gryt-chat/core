/**
 * What a direct conversation is called in a list.
 *
 * Both apps had this and they had drifted: the phone returns "Group" when an
 * unnamed group has no members to name, and the desktop returned an empty
 * string, because `[].join(" and ")` is "". A group whose members have not
 * arrived yet draws a blank row there.
 *
 * The phone's version is the one kept. This is the shape of drift GRYT-406
 * warned about — not two implementations disagreeing loudly, but one of them
 * quietly having a case the other never got.
 */

export interface ConversationParticipant {
  server_user_id: string;
  nickname: string;
  avatar_file_id: string | null;
  /** The owl look, so a row draws the same face the member list does. */
  avatar_worn: string | null;
}

export interface DirectConversation {
  conversation_id: string;
  /** Two people, or more than two. Groups get their own section. */
  kind: "dm" | "group";
  /** What a group was named. Null means read it off `members`. */
  name: string | null;
  /** An upload. Null means draw one from the name. */
  icon_file_id: string | null;
  created_at: string;
  last_message_at: string | null;
  /** Everybody but you. */
  members: ConversationParticipant[];
  /** The first of `members`. The whole story on a one-to-one. */
  other: ConversationParticipant;
}

export function conversationTitle(conversation: DirectConversation): string {
  if (conversation.kind === "dm") return conversation.other.nickname;
  if (conversation.name) return conversation.name;
  const names = conversation.members.map((m) => m.nickname);
  if (names.length === 0) return "Group";
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}
