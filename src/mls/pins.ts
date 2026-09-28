import { asIdentityScope, base64Url, getPeerPin, trustPinnedPersonKeys, type PeerPinStore } from "@gryt/crypto";

import type { MlsPins } from "./interfaces.js";

/**
 * `MlsPins` over the peer pins @gryt/crypto keeps, person keys included. The app still pins
 * with `evaluateMemberKeys`, passing each member's `personKeyBinding`, before the driver asks.
 */
export function mlsPinsFromPeerPins({
  store,
  scope,
  serverUserId,
  ownPersonKey,
  membersOf,
  seen,
}: {
  store: PeerPinStore;
  scope: string;
  /** Yours on this server. Your own person key answers as you. */
  serverUserId: string;
  /** The public half of `derivePersonKeyPair(seed, scope)`. */
  ownPersonKey: Uint8Array;
  /** Everybody in the conversation. Anybody else's person key is refused there. */
  membersOf(conversationId: string): readonly string[] | Promise<readonly string[]>;
  /** Decision 4's record, kept by the app: a peer pin has no field for it yet. */
  seen: { has(serverUserId: string): boolean | Promise<boolean>; add(serverUserId: string): void | Promise<void> };
}): MlsPins {
  const identityScope = asIdentityScope(scope);
  const own = base64Url(ownPersonKey);
  return {
    async personOf(conversationId, personPublicKey) {
      const presented = base64Url(personPublicKey);
      if (presented === own) return serverUserId;
      const members = await membersOf(conversationId);
      return members.find((id) => id !== serverUserId && getPeerPin(store, identityScope, id)?.personPublicKey === presented) ?? null;
    },
    trustFor(conversationId) {
      return async (certificate) => {
        const memberIds = await membersOf(conversationId);
        return trustPinnedPersonKeys({ store, scope: identityScope, memberIds, ownPersonKey })(certificate);
      };
    },
    seenOnMls: (id) => seen.has(id),
    markSeenOnMls: (id) => seen.add(id),
  };
}
