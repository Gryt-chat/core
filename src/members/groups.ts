/**
 * The member list, cut into role groups. Offline leaves its role and goes to one group at
 * the end: the question the list answers is who is around.
 */

/**
 * What this needs to know about a member, and no more, structurally. A `status` this does
 * not recognise counts as present, `undefined` included — that is an old server.
 */
export interface GroupableMember {
  nickname?: string | null;
  role?: string | null;
  status?: string | null;
}

/** What this needs to know about a role. `server:details` sends all four. */
export interface GroupableRole {
  id: string;
  rank: number;
  name?: string | null;
  color?: string | null;
}

/**
 * One block of the member list: a heading and the people under it. Generic over the member,
 * so a caller gets its own type back. `color` is the role's own, or null.
 */
export interface MemberGroup<M> {
  key: string;
  title: string;
  color: string | null;
  members: M[];
}

/**
 * The key on the group holding anybody not offline, when the server named no
 * roles. Exported so a caller styling that group does not spell it again.
 */
export const UNGROUPED_GROUP_KEY = "__ungrouped__";

/** The key on the offline group, which callers draw faded. */
export const OFFLINE_GROUP_KEY = "__offline__";

function byName(a: GroupableMember, b: GroupableMember): number {
  return (a.nickname ?? "").localeCompare(b.nickname ?? "", undefined, {
    sensitivity: "base",
  });
}

export function groupMembersByRole<M extends GroupableMember, R extends GroupableRole>(
  members: readonly M[],
  roles: readonly R[],
): MemberGroup<M>[] {
  const byRank = [...roles].sort((a, b) => b.rank - a.rank);
  const known = new Set(roles.map((r) => r.id));

  const offline: M[] = [];
  const present = new Map<string, M[]>();

  for (const member of members) {
    if (member.status === "offline") {
      offline.push(member);
      continue;
    }

    const key = member.role && known.has(member.role) ? member.role : UNGROUPED_GROUP_KEY;
    const bucket = present.get(key);
    if (bucket) bucket.push(member);
    else present.set(key, [member]);
  }

  const groups: MemberGroup<M>[] = [];

  for (const role of byRank) {
    const held = present.get(role.id);
    if (!held?.length) continue;
    groups.push({
      key: role.id,
      title: role.name ?? role.id,
      color: role.color ?? null,
      members: held.sort(byName),
    });
  }

  const rest = present.get(UNGROUPED_GROUP_KEY);
  if (rest?.length) {
    groups.push({
      key: UNGROUPED_GROUP_KEY,
      // Named rather than blank: a heading with no words above a list of people
      // reads as a rendering fault.
      title: groups.length > 0 ? "Everyone else" : "Members",
      color: null,
      members: rest.sort(byName),
    });
  }

  if (offline.length) {
    groups.push({
      key: OFFLINE_GROUP_KEY,
      title: "Offline",
      color: null,
      members: offline.sort(byName),
    });
  }

  return groups;
}
