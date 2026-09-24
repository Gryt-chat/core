import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  agreementAt,
  coversTerms,
  createTermsGate,
  GUIDELINES_URL,
  parseAgreement,
  TERMS_STORAGE_KEY,
  TERMS_URL,
  TERMS_VERSION,
  type TermsStorage,
} from "./termsAgreement.ts";

const NOW = new Date("2026-09-16T10:00:00.000Z");
const AGREED = JSON.stringify({ version: "2026-09-03", agreedAt: NOW.toISOString() });

function syncStorage(initial: string | null = null) {
  const storage = {
    value: initial,
    reads: 0,
    writes: [] as string[],
    read: () => {
      storage.reads++;
      return storage.value;
    },
    write: (value: string) => {
      storage.writes.push(value);
      storage.value = value;
    },
  };
  return storage;
}

function asyncStorage(value: string | null) {
  const storage = {
    reads: 0,
    read: () => {
      storage.reads++;
      return Promise.resolve(value);
    },
    write: async () => {},
  };
  return storage;
}

function counter() {
  const post: { (): void; calls: number } = Object.assign(
    () => {
      post.calls++;
    },
    { calls: 0 },
  );
  return post;
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("what is asked about", () => {
  it("links the two pages and keys the answer by their date", () => {
    assert.equal(TERMS_URL, "https://gryt.chat/terms");
    assert.equal(GUIDELINES_URL, "https://gryt.chat/community-guidelines");
    assert.match(TERMS_VERSION, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(TERMS_STORAGE_KEY, "gryt.termsAgreement");
  });
});

describe("parseAgreement", () => {
  const cases: Array<[string | null, string]> = [
    [null, "nothing stored"],
    ["", "an empty string"],
    ["{not json", "a broken write"],
    ["42", "a number"],
    ['"2026-09-03"', "a bare version"],
    ["[]", "an array"],
    ['{"agreedAt":"2026-09-16T10:00:00.000Z"}', "no version"],
    ['{"version":"latest","agreedAt":"2026-09-16T10:00:00.000Z"}', "a version that is not a date"],
    ['{"version":"2026-09-03"}', "no time"],
  ];
  for (const [raw, why] of cases) {
    it(`reads ${JSON.stringify(raw)} as no agreement (${why})`, () => {
      assert.equal(parseAgreement(raw), null, why);
    });
  }

  it("keeps the version and the time and nothing else", () => {
    assert.deepEqual(
      parseAgreement('{"version":"2026-09-03","agreedAt":"2026-09-16T10:00:00.000Z","extra":true}'),
      { version: "2026-09-03", agreedAt: "2026-09-16T10:00:00.000Z" },
    );
  });
});

describe("coversTerms", () => {
  it("needs an agreement to these terms or newer ones", () => {
    assert.equal(coversTerms(null), false);
    assert.equal(coversTerms({ version: TERMS_VERSION, agreedAt: "x" }), true);
    assert.equal(coversTerms({ version: "2026-09-02", agreedAt: "x" }, "2026-09-03"), false);
    assert.equal(coversTerms({ version: "2026-10-01", agreedAt: "x" }, "2026-09-03"), true);
  });

  it("stamps an agreement with the version and when", () => {
    assert.deepEqual(agreementAt(NOW, "2026-09-03"), {
      version: "2026-09-03",
      agreedAt: "2026-09-16T10:00:00.000Z",
    });
  });
});

describe("createTermsGate", () => {
  it("asks instead of posting, and Not now posts nothing", () => {
    const storage = syncStorage();
    const gate = createTermsGate(storage, "2026-09-03", () => NOW);
    let heard = 0;
    gate.subscribe(() => heard++);

    const post = counter();
    gate.postAfterAgreeing(post);
    assert.equal(post.calls, 0);
    assert.equal(gate.asking(), true);
    assert.equal(heard, 1);

    gate.decline();
    assert.equal(gate.asking(), false);
    assert.equal(post.calls, 0);
    assert.deepEqual(storage.writes, []);
  });

  it("posts what was waiting on Agree, remembers it, and stops reading storage", () => {
    const storage = syncStorage();
    const gate = createTermsGate(storage, "2026-09-03", () => NOW);

    const declined = counter();
    gate.postAfterAgreeing(declined);
    gate.decline();

    const post = counter();
    gate.postAfterAgreeing(post);
    gate.agree();
    assert.equal(post.calls, 1);
    assert.equal(declined.calls, 0);
    assert.deepEqual(JSON.parse(storage.writes[0]), { version: "2026-09-03", agreedAt: NOW.toISOString() });

    const reads = storage.reads;
    const next = counter();
    gate.postAfterAgreeing(next);
    assert.equal(next.calls, 1);
    assert.equal(storage.reads, reads);
  });

  it("remembers across a restart, and asks again when the terms move", () => {
    const relaunched = createTermsGate(syncStorage(AGREED), "2026-09-03");
    const post = counter();
    relaunched.postAfterAgreeing(post);
    assert.equal(post.calls, 1);

    const newer = createTermsGate(syncStorage(AGREED), "2026-12-01");
    const underNewTerms = counter();
    newer.postAfterAgreeing(underNewTerms);
    assert.equal(underNewTerms.calls, 0);
    assert.equal(newer.asking(), true);
  });

  it("asks when storage throws, and doesn't ask again in a loop when the write fails", () => {
    const broken: TermsStorage = {
      read: () => {
        throw new Error("unreadable");
      },
      write: () => {
        throw new Error("full");
      },
    };
    const gate = createTermsGate(broken, "2026-09-03");
    const post = counter();
    gate.postAfterAgreeing(post);
    assert.equal(post.calls, 0);
    gate.agree();
    assert.equal(post.calls, 1);

    const again = counter();
    gate.postAfterAgreeing(again);
    assert.equal(again.calls, 1);
  });

  it("sends a double tap once while storage is still answering", async () => {
    const storage = asyncStorage(AGREED);
    const gate = createTermsGate(storage, "2026-09-03");
    const tap = counter();
    const doubleTap = counter();
    gate.postAfterAgreeing(tap);
    gate.postAfterAgreeing(doubleTap);
    assert.equal(tap.calls + doubleTap.calls, 0);

    await settled();
    assert.equal(storage.reads, 1);
    assert.equal(tap.calls + doubleTap.calls, 1);
    assert.equal(gate.asking(), false);
  });

  it("asks once late storage says nothing was agreed, or fails", async () => {
    const empty = createTermsGate(asyncStorage(null), "2026-09-03");
    const post = counter();
    empty.postAfterAgreeing(post);
    await settled();
    assert.equal(empty.asking(), true);
    empty.agree();
    assert.equal(post.calls, 1);

    const failing = createTermsGate(
      { read: () => Promise.reject(new Error("gone")), write: async () => {} },
      "2026-09-03",
    );
    const lost = counter();
    failing.postAfterAgreeing(lost);
    await settled();
    assert.equal(lost.calls, 0);
    assert.equal(failing.asking(), true);
  });

  it("doesn't bring back a post that was answered when storage is read again", () => {
    const gate = createTermsGate(syncStorage(), "2026-09-03");
    const declined = counter();
    gate.postAfterAgreeing(declined);
    gate.decline();
    gate.load();
    assert.equal(gate.asking(), false);
    assert.equal(declined.calls, 0);

    const agreed = counter();
    gate.postAfterAgreeing(agreed);
    gate.agree();
    gate.load();
    assert.equal(agreed.calls, 1);
  });

  it("posts straight away after load() has read storage", async () => {
    const gate = createTermsGate(asyncStorage(AGREED), "2026-09-03");
    gate.load();
    await settled();
    const post = counter();
    gate.postAfterAgreeing(post);
    assert.equal(post.calls, 1);
  });
});
