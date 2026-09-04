/**
 * The member list, cut into role groups.
 *
 * Both apps drew this and both got it right, separately, which is the shape of
 * duplicate that goes wrong quietly: nothing fails when the two drift, the
 * lists just stop matching, and a moderator has to re-learn the sidebar on
 * whichever device they are holding.
 *
 * **Offline leaves its role** — the question the list answers is "who is
 * around", so they go to one group at the end in one alphabet rather than to
 * the bottom of each role.
 *
 * Roles run highest rank first, and roles nobody holds are left out rather than
 * drawn empty. A member whose role the server did not describe lands in one
 * unnamed group after the named ones, which is also what a server too old to
 * send roles looks like.
 */

/**
 * What this needs to know about a member, and no more.
 *
 * Structural rather than a type the apps have to adopt: the desktop's
 * `MemberInfo` and the phone's `Member` carry different fields for different
 * screens, and both already satisfy this.
 *
 * **A `status` this does not recognise counts as present, `undefined`
 * included.** The server always sends one — `clients.ts` defaults it to
 * `offline` — so the absent case is a server too old to have the field, and on
 * one of those every member reading as offline would blank the whole list.
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
 * One block of the member list: a heading and the people under it.
 *
 * Generic over the member so a caller gets its own type back and can draw
 * whatever it stores. `color` is the role's own colour, straight from the
 * server, or null for a role that has none and for the two groups that are not
 * roles.
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
