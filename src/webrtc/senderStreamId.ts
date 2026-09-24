/** Keyed by connection, so a reconnect — a new connection object — starts over. */
const byConnection = new WeakMap<object, Record<string, string>>();

/**
 * The stream id for a role: the first one given on this connection, kept in place
 * across a `replaceTrack` swap. With no connection, `streamId` is returned unchanged.
 */
export function senderStreamId<Role extends string>(
  pc: object | null | undefined,
  role: Role,
  streamId: string,
): string {
  if (!pc) return streamId;
  let ids = byConnection.get(pc);
  if (!ids) {
    ids = {};
    byConnection.set(pc, ids);
  }
  return (ids[role] ??= streamId);
}
