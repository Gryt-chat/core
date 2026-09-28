import { randomBytes } from "node:crypto";

import {
  base64Url,
  base64UrlDecode,
  createPairingKey,
  decodePairingSessionId,
  encodePairingSessionId,
  pairingCommitment,
  startApproverSession,
  startNewDeviceSession,
  type PairingKey,
  type PairingSession,
} from "@gryt/crypto";
import { sha256 } from "@noble/hashes/sha2.js";

import type { PairingClock, PairingFetch, PairingOidc } from "./interfaces.ts";

/* In-memory stand-ins for the relay in auth#45 and the approve endpoint in auth#46, same
   statuses and error codes. Only what the pairing client touches. */

export class FakeClock implements PairingClock {
  t = 1_800_000_000_000;
  private timers: { at: number; resolve: () => void }[] = [];
  now = () => this.t;
  sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("aborted"));
      const timer = { at: this.t + ms, resolve };
      this.timers.push(timer);
      signal?.addEventListener("abort", () => {
        this.timers = this.timers.filter((x) => x !== timer);
        reject(new Error("aborted"));
      });
    });
  advance(ms: number) {
    this.t += ms;
    const due = this.timers.filter((x) => x.at <= this.t);
    this.timers = this.timers.filter((x) => x.at > this.t);
    for (const x of due) x.resolve();
  }
}

type Side = "n" | "a";
interface Msg {
  seq: number;
  type: "claim" | "reveal" | "sealed";
  pkA?: string;
  pkN?: string;
  body?: string;
}
interface Session {
  id: string;
  code: string | null;
  commit: string;
  tokens: { n: string; a: string | null };
  state: "open" | "claimed" | "revealed" | "approved";
  expiresAt: number;
  claimedAt: number;
  sent: Record<Side, Msg[]>;
  seq: Record<Side, number>;
  waiters: Set<() => void>;
  mitm?: { toA: PairingKey; toN: PairingKey; realCommit: string; pkA?: string; n?: PairingSession; a?: PairingSession };
}

class Refusal extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const reply = (status: number, body: unknown) => ({ status, json: async () => body });

export class FakeRelay {
  readonly origin = "https://id.example";
  readonly sessions = new Map<string, Session>();
  private codes = new Map<string, string>();
  private ended = new Map<string, string>();
  /** Sits in the middle with keys of its own, as a hostile relay would. */
  mitm = false;
  /** What a middle relay managed to read from A. */
  readByRelay: Uint8Array[] = [];
  readonly clock: FakeClock;
  constructor(clock: FakeClock) {
    this.clock = clock;
  }

  fetch: PairingFetch = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\/v1\/pairing\/sessions/, "");
    const body = init.body ? JSON.parse(init.body) : {};
    const token = init.headers?.authorization?.replace(/^Bearer /, "");
    try {
      if (init.method === "POST" && path === "") return reply(201, this.create(body.commit));
      if (init.method === "POST" && path === "/claim") return reply(200, this.claim(body));
      const [, id, rest] = path.match(/^\/([^/]+)(\/messages)?$/) ?? [];
      if (init.method === "POST" && rest) return reply(201, this.post(id, token, body));
      if (init.method === "GET" && rest) {
        const wait = Number(u.searchParams.get("wait")) * 1000;
        return reply(200, { messages: await this.poll(id, token, Number(u.searchParams.get("after")), wait, init.signal) });
      }
      if (init.method === "DELETE" && id) return (this.end(this.find(id, token).s, "closed"), reply(204, null));
      return reply(404, { error: "not_found" });
    } catch (e) {
      if (e instanceof Refusal) return reply(e.status, { error: e.code });
      throw e;
    }
  };

  private create(commit: string) {
    const id = encodePairingSessionId(randomBytes(16));
    const code = encodePairingSessionId(randomBytes(16)).slice(0, 8);
    const token = randomBytes(32).toString("base64url");
    const s: Session = {
      id, code, commit, tokens: { n: token, a: null }, state: "open",
      expiresAt: this.clock.now() + 5 * 60_000, claimedAt: 0,
      sent: { n: [], a: [] }, seq: { n: 0, a: 0 }, waiters: new Set(),
    };
    if (this.mitm) {
      const toA = createPairingKey();
      s.mitm = { toA, toN: createPairingKey(), realCommit: commit };
      s.commit = base64Url(pairingCommitment(toA.publicKey));
    }
    this.sessions.set(id, s);
    this.codes.set(code, id);
    return { id, code, token, expiresAt: new Date(s.expiresAt).toISOString() };
  }

  private claim(input: { id?: string; code?: string; pkA: string }) {
    const id = input.code !== undefined ? this.codes.get(input.code) : input.id;
    if (input.code !== undefined && (!id || !this.sessions.has(id))) throw new Refusal(404, "not_found");
    const s = this.live(id!);
    if (s.state !== "open") throw new Refusal(409, "already_claimed");
    const token = randomBytes(32).toString("base64url");
    this.codes.delete(s.code!);
    Object.assign(s, { code: null, state: "claimed", claimedAt: this.clock.now(), expiresAt: this.clock.now() + 2 * 60_000 });
    s.tokens.a = token;
    let pkA = input.pkA;
    if (s.mitm) (s.mitm.pkA = pkA), (pkA = base64Url(s.mitm.toN.publicKey));
    this.push(s, "a", { type: "claim", pkA });
    return { id: s.id, token, commit: s.commit, location: "Oslo, Norway", yourLocation: "Bergen, Norway" };
  }

  private post(id: string, token: string | undefined, m: { type: string; pkN?: string; body?: string }) {
    const { s, side } = this.find(id, token);
    if (m.type === "reveal") {
      if (side !== "n" || s.state !== "claimed") throw new Refusal(409, "already_revealed");
      if (s.mitm) {
        const sessionId = decodePairingSessionId(s.id)!;
        const pkN = base64UrlDecode(m.pkN!);
        s.mitm.n = startApproverSession(s.mitm.toN, { sessionId, commitment: base64UrlDecode(s.mitm.realCommit), newDevicePublicKey: pkN });
        s.mitm.a = startNewDeviceSession(s.mitm.toA, { sessionId, approverPublicKey: base64UrlDecode(s.mitm.pkA!) });
        m = { type: "reveal", pkN: base64Url(s.mitm.toA.publicKey) };
      }
      s.state = "revealed";
      return this.push(s, "n", { type: "reveal", pkN: m.pkN });
    }
    if (s.state === "open" || s.state === "claimed") throw new Refusal(409, "not_revealed");
    if (side === "a" && s.state === "revealed") Object.assign(s, { state: "approved", expiresAt: s.claimedAt + 60 * 60_000 });
    let body = m.body!;
    if (s.mitm) {
      const [from, to] = side === "n" ? [s.mitm.n!, s.mitm.a!] : [s.mitm.a!, s.mitm.n!];
      const plain = from.open(base64UrlDecode(body));
      if (side === "a") this.readByRelay.push(plain);
      body = base64Url(to.seal(plain));
    }
    return this.push(s, side, { type: "sealed", body });
  }

  /** Delivers a sealed body as if `side` had sent it: a replay, from the relay's seat. */
  inject(id: string, side: Side, body: string) {
    this.push(this.sessions.get(id)!, side, { type: "sealed", body });
  }

  /** Everything `side` has posted to a session, including what was already fetched. */
  readonly log: { id: string; side: Side; msg: Msg }[] = [];

  private async poll(id: string, token: string | undefined, after: number, waitMs: number, signal?: AbortSignal) {
    let { s, side } = this.find(id, token);
    const from: Side = side === "n" ? "a" : "n";
    s.sent[from] = s.sent[from].filter((m) => m.seq > after);
    const deadline = this.clock.now() + waitMs;
    while (s.sent[from].length === 0 && this.clock.now() < deadline) {
      await new Promise<void>((resolve, reject) => {
        const stop = new AbortController();
        const wake = () => (s.waiters.delete(wake), stop.abort(), resolve());
        s.waiters.add(wake);
        this.clock.sleep(deadline - this.clock.now(), stop.signal).then(wake, () => undefined);
        signal?.addEventListener("abort", () => (s.waiters.delete(wake), stop.abort(), reject(new Error("aborted"))));
      });
      ({ s } = this.find(id, token));
    }
    return s.sent[from];
  }

  private live(id: string): Session {
    const s = this.sessions.get(id);
    if (s && s.expiresAt <= this.clock.now()) this.end(s, "expired");
    else if (s) return s;
    const ended = this.ended.get(id);
    throw ended ? new Refusal(410, ended) : new Refusal(404, "not_found");
  }

  private find(id: string, token: string | undefined): { s: Session; side: Side } {
    const s = this.live(id);
    if (token && token === s.tokens.n) return { s, side: "n" };
    if (token && token === s.tokens.a) return { s, side: "a" };
    throw new Refusal(401, "unauthorized");
  }

  private push(s: Session, side: Side, m: Omit<Msg, "seq">) {
    const msg = { seq: ++s.seq[side], ...m };
    s.sent[side].push(msg);
    this.log.push({ id: s.id, side, msg });
    for (const wake of [...s.waiters]) wake();
    return { seq: msg.seq };
  }

  private end(s: Session, reason: string) {
    this.sessions.delete(s.id);
    if (s.code) this.codes.delete(s.code);
    this.ended.set(s.id, reason);
    for (const wake of [...s.waiters]) wake();
  }
}

interface DeviceCode {
  deviceCode: string;
  challenge: string;
  nonce: string;
  clientId: string;
  sub?: string;
  state: "pending" | "approved" | "denied";
  used: boolean;
}

/** Keycloak's device grant plus the gryt-pairing extension. Access tokens are just `token:<sub>`. */
export class FakeKeycloak {
  readonly issuer = "https://auth.example/realms/gryt";
  extension = true;
  readonly codes = new Map<string, DeviceCode>();

  oidc: PairingOidc = {
    deviceAuthorization: async (req) => {
      if (req.codeChallengeMethod !== "S256" || !req.codeChallenge) throw new Error("invalid_request");
      const userCode = randomBytes(4).toString("hex").toUpperCase();
      const deviceCode = randomBytes(16).toString("hex");
      this.codes.set(userCode, { deviceCode, challenge: req.codeChallenge, nonce: req.nonce, clientId: req.clientId, state: "pending", used: false });
      return { deviceCode, userCode, expiresIn: 300, interval: 5 };
    },
    deviceToken: async (req) => {
      const code = [...this.codes.values()].find((c) => c.deviceCode === req.deviceCode);
      if (!code) return { status: "expired" };
      if (base64Url(sha256(new TextEncoder().encode(req.codeVerifier))) !== code.challenge) return { status: "denied" };
      if (code.state !== "approved") return { status: code.state === "denied" ? "denied" : "pending" };
      const claims = { iss: this.issuer, aud: code.clientId, sub: code.sub, nonce: code.nonce };
      const idToken = `e30.${base64Url(new TextEncoder().encode(JSON.stringify(claims)))}.sig`;
      return { status: "ok", tokens: { idToken, accessToken: `token:${code.sub}`, refreshToken: "refresh" } };
    },
  };

  fetch: PairingFetch = async (url, init) => {
    if (!this.extension || url !== `${this.issuer}/gryt-pairing/approve`) return reply(404, null);
    const { user_code, binding } = JSON.parse(init.body ?? "{}");
    const code = this.codes.get(user_code);
    if (code?.used) return reply(409, { error: "code_used" });
    if (code) code.used = true;
    const sub = init.headers?.authorization?.match(/^Bearer token:(.+)$/)?.[1];
    if (!sub) return reply(401, { error: "invalid_token" });
    if (!code) return reply(400, { error: "unknown_code" });
    if (code.nonce !== binding) return (code.state = "denied"), reply(403, { error: "binding_mismatch" });
    Object.assign(code, { state: "approved", sub });
    return reply(204, null);
  };

  /** Keycloak's own device page, signed in as `sub`. */
  approveInBrowser(userCode: string, sub: string) {
    Object.assign(this.codes.get(userCode)!, { state: "approved", sub });
  }
}
