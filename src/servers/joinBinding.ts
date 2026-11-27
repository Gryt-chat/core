/* Ties a join assertion to the server key this connection proved, so an assertion
   signed while joining one server is refused by any other. */

export type ChallengeBinding =
  | { claims: { server_key?: string } }
  | { refuse: string };

/**
 * `provedKey` must come from this connection's `server:identify` proof, never from the
 * challenge: the challenge is what a relaying server controls.
 */
export function bindChallengeToServer(
  challengeKey: string | undefined | null,
  provedKey: string | undefined | null,
): ChallengeBinding {
  if (challengeKey && challengeKey !== provedKey) {
    return { refuse: "This server's join request names a different server. Not signing in." };
  }
  return { claims: provedKey ? { server_key: provedKey } : {} };
}
