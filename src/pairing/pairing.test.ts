import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { asIdentityScope, type PairingEnvelope } from "@gryt/crypto";

import type { MlsOwnDeviceAdd } from "../mls/interfaces.ts";
import { createApproverPairing, type ApproverPairing } from "./approver.ts";
import type { PairingTokens } from "./interfaces.ts";
import { createNewDevicePairing, type NewDevicePairing } from "./newDevice.ts";
import { FakeClock, FakeKeycloak, FakeRelay } from "./relay.fake.ts";
import { createPairingRelay } from "./relayClient.ts";

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const SERVER = { host: "chat.example", name: "Example", scope: asIdentityScope("srv:lineage-1") };

function setup(options: { mitm?: boolean } = {}) {
  const clock = new FakeClock();
  const relay = new FakeRelay(clock);
  relay.mitm = options.mitm ?? false;
  const keycloak = new FakeKeycloak();
  const committed: { envelope: PairingEnvelope; tokens: PairingTokens | null }[] = [];
  const adds: { host: string; deviceId: string }[] = [];

  const newDevice = () =>
    createNewDevicePairing({
      relay: createPairingRelay(relay.origin, relay.fetch),
      device: { name: "MacBook Air", app: "Gryt desktop", platform: "macOS" },
      storage: { commit: async (envelope, tokens) => void committed.push({ envelope, tokens }) },
      oidc: keycloak.oidc,
      clock,
    });
  const approver = () =>
    createApproverPairing({
      relay: createPairingRelay(relay.origin, relay.fetch),
      relayOrigin: relay.origin,
      fetch: keycloak.fetch,
      clock,
      devices: (host) => ({
        addOwnDevice: async (deviceId, opts) => {
          adds.push({ host, deviceId });
          const result: MlsOwnDeviceAdd = { conversationId: "dm-1", groupId: "ab", outcome: "added", add: { seq: 4, epoch: 2 } };
          opts?.onProgress?.({ done: 1, total: 1, result });
          return [result];
        },
      }),
    });

  /** Lets every promise settle, then moves the clock a second at a time until `done` holds. */
  async function until(done: () => boolean, maxSeconds = 600) {
    for (let s = 0; ; s++) {
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      if (done()) return;
      if (s >= maxSeconds) assert.fail("never got there");
      clock.advance(1000);
    }
  }

  return { clock, relay, keycloak, committed, adds, newDevice, approver, until };
}

type Env = ReturnType<typeof setup>;

const envelope = (account?: PairingEnvelope["account"]): PairingEnvelope => ({
  seed: SEED,
  keys: [],
  servers: [SERVER],
  pins: {},
  from: "Sivert's iPhone",
  ...(account ? { account } : {}),
});

function account(env: Env, sub = "user-1") {
  return { issuer: env.keycloak.issuer, clientId: "gryt-web", identityUrl: "https://id.example", sub, username: "sivert" };
}

/** N showing a QR, A claiming it by QR or code, both at the emoji. */
async function toEmoji(env: Env, by: "qr" | "code" = "qr") {
  const n = env.newDevice();
  const a = env.approver();
  n.start();
  await env.until(() => n.state.phase === "showing");
  const s = n.state as Extract<NewDevicePairing["state"], { phase: "showing" }>;
  a.claim(by === "qr" ? { qr: s.qr } : { code: s.code.toLowerCase() });
  await env.until(() => a.state.phase !== "claiming" && a.state.phase !== "waiting");
  return { n, a, qr: s.qr };
}

const phase = (p: NewDevicePairing | ApproverPairing) => p.state.phase;
const emojiOf = (p: NewDevicePairing | ApproverPairing) => (p.state as { emoji?: unknown }).emoji;

describe("pairing a guest", () => {
  it("hands over the seed and servers, then A adds N everywhere", async () => {
    const env = setup();
    const { n, a } = await toEmoji(env);
    assert.equal(phase(a), "confirming");
    assert.deepEqual(emojiOf(a), emojiOf(n));
    const confirming = a.state as Extract<ApproverPairing["state"], { phase: "confirming" }>;
    assert.deepEqual(confirming.device, { name: "MacBook Air", app: "Gryt desktop", platform: "macOS" });
    assert.equal(confirming.location, "Oslo, Norway");

    a.approve(envelope());
    await env.until(() => phase(n) === "joining");
    assert.deepEqual(env.committed[0].envelope.seed, SEED);
    assert.equal(env.committed[0].envelope.servers[0].scope, "srv:lineage-1");
    assert.equal(env.committed[0].tokens, null);

    await n.ready([{ host: "chat.example", deviceId: "dev-n" }]);
    await env.until(() => phase(a) === "done" && phase(n) === "done");
    assert.deepEqual(env.adds, [{ host: "chat.example", deviceId: "dev-n" }]);
    assert.equal(env.relay.sessions.size, 0);
  });
});

describe("pairing an account", () => {
  it("signs N in through the extension with the pairing's nonce", async () => {
    const env = setup();
    const { n, a } = await toEmoji(env, "code");
    let tokenCalls = 0;
    a.approve(envelope(account(env)), async () => (tokenCalls++, "token:user-1"));
    await env.until(() => phase(n) === "joining");
    assert.equal(tokenCalls, 1);
    assert.equal(env.committed[0].tokens?.accessToken, "token:user-1");
    const [code] = env.keycloak.codes.values();
    assert.equal(code.state, "approved");

    await n.ready([{ host: "chat.example", deviceId: "dev-n" }]);
    await env.until(() => phase(a) === "done" && phase(n) === "done");
  });

  it("falls back to Keycloak's device page when the extension answers 404", async () => {
    const env = setup();
    env.keycloak.extension = false;
    const { n, a } = await toEmoji(env);
    a.approve(envelope(account(env)), async () => "token:user-1");
    await env.until(() => phase(a) === "browser");
    const [userCode] = env.keycloak.codes.keys();
    const url = (a.state as { url: string }).url;
    assert.equal(url, `${env.keycloak.issuer}/device?user_code=${userCode}`);

    env.keycloak.approveInBrowser(userCode, "user-1");
    await env.until(() => phase(n) === "joining");
    assert.equal(env.committed.length, 1);
  });

  it("throws everything away when N ends up signed in as somebody else", async () => {
    const env = setup();
    const { n, a } = await toEmoji(env);
    a.approve(envelope(account(env)), async () => "token:someone-else");
    await env.until(() => phase(n) === "ended");
    assert.deepEqual(n.state, { phase: "ended", reason: "wrong_account" });
    assert.equal(env.committed.length, 0);
  });

  it("stops on a user code that was already used", async () => {
    const env = setup();
    const { a } = await toEmoji(env);
    const original = env.keycloak.oidc.deviceAuthorization;
    env.keycloak.oidc.deviceAuthorization = async (req) => {
      const auth = await original(req);
      env.keycloak.codes.get(auth.userCode)!.used = true;
      return auth;
    };
    a.approve(envelope(account(env)), async () => "token:user-1");
    await env.until(() => phase(a) === "ended");
    assert.deepEqual(a.state, { phase: "ended", reason: "code_used" });
  });
});

describe("Keycloak's own refusals get their own reason (GRYT-1578)", () => {
  /** Swaps in a canned response from the approve endpoint. Must run before `env.approver()`
      captures the fetch it was given, so set it up before `toEmoji`. */
  function refuseApproval(env: Env, status: number, error: string) {
    env.keycloak.fetch = async () => ({ status, json: async () => ({ error }) });
  }

  it("gives an unknown user_code its own reason", async () => {
    const env = setup();
    refuseApproval(env, 400, "unknown_code");
    const { a } = await toEmoji(env, "code");
    a.approve(envelope(account(env)), async () => "token:user-1");
    await env.until(() => phase(a) === "ended");
    assert.deepEqual(a.state, { phase: "ended", reason: "code_expired" });
  });

  it("gives an expired user_code the same reason as an unknown one", async () => {
    const env = setup();
    refuseApproval(env, 410, "expired_code");
    const { a } = await toEmoji(env, "code");
    a.approve(envelope(account(env)), async () => "token:user-1");
    await env.until(() => phase(a) === "ended");
    assert.deepEqual(a.state, { phase: "ended", reason: "code_expired" });
  });

  it("gives the approve endpoint's rate limit its own reason", async () => {
    const env = setup();
    refuseApproval(env, 429, "rate_limited");
    const { a } = await toEmoji(env, "code");
    a.approve(envelope(account(env)), async () => "token:user-1");
    await env.until(() => phase(a) === "ended");
    assert.deepEqual(a.state, { phase: "ended", reason: "rate_limited" });
  });

  it("gives a pending required action its own reason", async () => {
    const env = setup();
    refuseApproval(env, 403, "required_actions");
    const { a } = await toEmoji(env, "code");
    a.approve(envelope(account(env)), async () => "token:user-1");
    await env.until(() => phase(a) === "ended");
    assert.deepEqual(a.state, { phase: "ended", reason: "required_actions" });
  });

  it("gives a stale access token its own reason", async () => {
    const env = setup();
    refuseApproval(env, 403, "stale_token");
    const { a } = await toEmoji(env, "code");
    a.approve(envelope(account(env)), async () => "token:user-1");
    await env.until(() => phase(a) === "ended");
    assert.deepEqual(a.state, { phase: "ended", reason: "stale_token" });
  });

  it("still falls back to approve:<code> for a refusal with no reason of its own", async () => {
    const env = setup();
    refuseApproval(env, 403, "wrong_client");
    const { a } = await toEmoji(env, "code");
    a.approve(envelope(account(env)), async () => "token:user-1");
    await env.until(() => phase(a) === "ended");
    assert.deepEqual(a.state, { phase: "ended", reason: "approve:wrong_client" });
  });

  it("tells N when Keycloak's device grant itself says access_denied", async () => {
    const env = setup();
    const { n, a } = await toEmoji(env, "code");
    env.keycloak.oidc.deviceToken = async () => ({ status: "denied" });
    a.approve(envelope(account(env)), async () => "token:user-1");
    await env.until(() => phase(n) === "ended");
    assert.deepEqual(n.state, { phase: "ended", reason: "access_denied" });
  });

  it("tells N when the device grant's user_code has expired", async () => {
    const env = setup();
    const { n, a } = await toEmoji(env, "code");
    env.keycloak.oidc.deviceToken = async () => ({ status: "expired" });
    a.approve(envelope(account(env)), async () => "token:user-1");
    await env.until(() => phase(n) === "ended");
    assert.deepEqual(n.state, { phase: "ended", reason: "expired_token" });
  });

  it("backs off on slow_down instead of ending the pairing", async () => {
    const env = setup();
    const { n, a } = await toEmoji(env, "code");
    const original = env.keycloak.oidc.deviceToken;
    let calls = 0;
    env.keycloak.oidc.deviceToken = async (req) => {
      calls++;
      return calls === 1 ? { status: "slow_down" } : original(req);
    };
    a.approve(envelope(account(env)), async () => "token:user-1");
    await env.until(() => phase(n) === "joining");
    assert.ok(calls >= 2);
  });
});

describe("a relay in the middle", () => {
  it("shows different emoji on each side when it swaps keys, so the person refuses", async () => {
    const env = setup({ mitm: true });
    const { n, a } = await toEmoji(env, "code");
    assert.equal(phase(a), "confirming");
    assert.notDeepEqual(emojiOf(a), emojiOf(n));
    await a.mismatch();
    await env.until(() => phase(n) === "ended");
    assert.deepEqual(a.state, { phase: "ended", reason: "mismatch" });
    assert.deepEqual(n.state, { phase: "ended", reason: "cancelled_by_other" });
    assert.equal(env.committed.length, 0);
    assert.equal(env.relay.readByRelay.length, 0);
  });

  it("can't swap N's key when A scanned the QR", async () => {
    const env = setup({ mitm: true });
    const { a } = await toEmoji(env, "qr");
    await env.until(() => phase(a) === "ended");
    assert.deepEqual(a.state, { phase: "ended", reason: "tampered" });
  });

  it("can't replay an envelope from an earlier session", async () => {
    const env = setup();
    const first = await toEmoji(env);
    first.a.approve(envelope());
    await env.until(() => phase(first.n) === "joining");
    const old = env.relay.log.find((l) => l.side === "a" && l.msg.type === "sealed")!.msg.body!;

    const n = env.newDevice();
    n.start();
    await env.until(() => phase(n) === "showing");
    const a = env.approver();
    a.claim({ qr: (n.state as { qr: string }).qr });
    await env.until(() => phase(n) === "comparing");
    env.relay.inject([...env.relay.sessions.keys()].at(-1)!, "a", old);
    await env.until(() => phase(n) === "ended");
    assert.deepEqual(n.state, { phase: "ended", reason: "tampered" });
    assert.equal(env.committed.length, 1);
  });
});

describe("timeouts, cancelling and a second scan", () => {
  it("runs out 60 seconds after the emoji, and N shows a fresh QR", async () => {
    const env = setup();
    const { n, a, qr } = await toEmoji(env);
    const start = env.clock.now();
    await env.until(() => phase(a) === "ended");
    assert.deepEqual(a.state, { phase: "ended", reason: "timed_out" });
    assert.ok(env.clock.now() - start <= 61_000);
    await env.until(() => phase(n) === "showing");
    assert.equal((n.state as { renewed?: string }).renewed, "timed_out");
    assert.notEqual((n.state as { qr: string }).qr, qr);
    await n.cancel();
  });

  it("makes a new QR and code when nobody scans for five minutes", async () => {
    const env = setup();
    const n = env.newDevice();
    n.start();
    await env.until(() => phase(n) === "showing");
    const first = (n.state as { code: string }).code;
    await env.until(() => (n.state as { renewed?: string }).renewed === "expired");
    assert.notEqual((n.state as { code: string }).code, first);
    await n.cancel();
  });

  it("tells A when N cancels", async () => {
    const env = setup();
    const { n, a } = await toEmoji(env);
    await n.cancel();
    await env.until(() => phase(a) === "ended");
    assert.deepEqual(a.state, { phase: "ended", reason: "cancelled_by_other" });
  });

  it("tells N when A denies", async () => {
    const env = setup();
    const { n, a } = await toEmoji(env);
    await a.deny();
    await env.until(() => phase(n) === "ended");
    assert.deepEqual(n.state, { phase: "ended", reason: "cancelled_by_other" });
  });

  it("refuses a second scan of the same QR", async () => {
    const env = setup();
    const { n, qr } = await toEmoji(env);
    const second = env.approver();
    second.claim({ qr });
    await env.until(() => phase(second) === "ended");
    assert.deepEqual(second.state, { phase: "ended", reason: "already_claimed" });
    assert.equal(phase(n), "comparing");
  });

  it("refuses a code nobody is showing", async () => {
    const env = setup();
    const a = env.approver();
    a.claim({ code: "0000-0000" });
    await env.until(() => phase(a) === "ended");
    assert.deepEqual(a.state, { phase: "ended", reason: "unknown_code" });
  });

  it("refuses a QR that names another relay", async () => {
    const env = setup();
    const a = env.approver();
    a.claim({ qr: "GRYT:1:0000000000000000000000000G:00000000000000000000000000000000000000000000000000G0:HTTPS://EVIL.EXAMPLE" });
    await env.until(() => phase(a) === "ended");
    assert.deepEqual(a.state, { phase: "ended", reason: "wrong_relay" });
  });
});
