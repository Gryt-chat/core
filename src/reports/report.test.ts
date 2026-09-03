import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildReport,
  describeAttached,
  MESSAGE_MAX,
  TITLE_MAX,
  type Diagnostics,
} from "./report.ts";

test("sends the two fields the service requires and nothing it did not learn", () => {
  const report = buildReport("bug", { message: "It broke" });
  assert.equal(report.type, "bug");
  assert.equal(report.message, "It broke");
  // An empty `device` object claims "this app collects no device information",
  // which is a different and wronger claim than leaving the key off.
  assert.equal(report.app, undefined);
  assert.equal(report.device, undefined);
  assert.equal(report.runtime, undefined);
  assert.equal(report.context, undefined);
});

test("trims and caps rather than rejecting", () => {
  const long = "x".repeat(MESSAGE_MAX + 500);
  const report = buildReport("feedback", { message: `  ${long}  `, title: "y".repeat(TITLE_MAX + 50) });
  assert.equal(report.message.length, MESSAGE_MAX);
  assert.equal(report.title?.length, TITLE_MAX);
});

test("an empty message stays empty rather than becoming undefined", () => {
  // The form is what stops it being empty; the service rejects only this.
  assert.equal(buildReport("bug", { message: "   " }).message, "");
});

test("carries the desktop's fields", () => {
  const report = buildReport("bug", { message: "m" }, {
    version: "1.9.12",
    channel: "stable",
    installId: "abc",
    locale: "en-GB",
    platform: "win32",
    osVersion: "10.0.26200",
    electronVersion: "38.0.0",
    chromeVersion: "140.0.0",
    userAgent: "Mozilla/5.0",
    online: true,
    networkType: "wifi",
    logs: ["a", "b"],
    embeddedServer: true,
    embeddedServerVersion: "0.9.1",
  });

  assert.equal(report.app?.version, "1.9.12");
  assert.equal(report.runtime?.electronVersion, "38.0.0");
  assert.equal(report.context?.networkType, "wifi");
  assert.deepEqual(report.logs, ["a", "b"]);
  assert.deepEqual(report.extra, { embeddedServer: true, embeddedServerVersion: "0.9.1" });
  // Nothing only the phone knows leaked in.
  assert.equal(report.runtime?.expoVersion, undefined);
  assert.equal(report.device?.isEmulator, undefined);
});

test("carries the phone's fields", () => {
  const report = buildReport("bug", { message: "m" }, {
    version: "1.4.0",
    build: "231",
    platform: "ios",
    osVersion: 18,
    isEmulator: true,
    reactNativeVersion: "0.86.2",
    expoVersion: "57.0.15",
    screen: { width: 390, height: 844, scale: 3 },
  });

  assert.equal(report.app?.build, "231");
  // Android hands its API level over as a number.
  assert.equal(report.device?.osVersion, "18");
  assert.equal(report.device?.isEmulator, true);
  assert.equal(report.runtime?.expoVersion, "57.0.15");
  // And nothing only the desktop knows leaked in.
  assert.equal(report.runtime?.electronVersion, undefined);
  assert.equal(report.extra, undefined);
});

test("a false boolean is a value, not a missing field", () => {
  // `connected: false` is the interesting case in a bug report, and an
  // truthiness check would drop exactly that one.
  const report = buildReport("bug", { message: "m" }, { connected: false, voiceActive: false });
  assert.equal(report.context?.connected, false);
  assert.equal(report.context?.voiceActive, false);
});

test("drops a nonsense uptime rather than sending NaN", () => {
  const bad = buildReport("bug", { message: "m" }, { sessionUptimeSec: Number.NaN });
  assert.equal(bad.context, undefined);
  const good = buildReport("bug", { message: "m" }, { sessionUptimeSec: 0 });
  assert.equal(good.context?.sessionUptimeSec, 0);
});

test("an empty log array is no log at all", () => {
  assert.equal(buildReport("bug", { message: "m" }, { logs: [] }).logs, undefined);
});

test("describeAttached lists only what is actually going", () => {
  const report = buildReport("bug", { message: "m" }, {
    version: "1.9.12",
    platform: "win32",
    osVersion: "11",
    sessionUptimeSec: 3600,
    logs: ["a", "b", "c"],
  });
  const rows = describeAttached(report);
  const asMap = Object.fromEntries(rows.map((r) => [r.label, r.value]));

  assert.equal(asMap["Gryt"], "v1.9.12");
  assert.equal(asMap["System"], "Windows 11");
  assert.equal(asMap["Running for"], "60 min");
  assert.equal(asMap["Log"], "last 3 lines");
  // Nothing that was never set gets a row.
  assert.equal(asMap["Electron"], undefined);
  assert.equal(asMap["Expo"], undefined);
});

test("names every platform either app runs on", () => {
  const label = (platform: string) => {
    const rows = describeAttached(buildReport("bug", { message: "m" }, { platform }));
    return rows.find((r) => r.label === "System")?.value;
  };
  // Each app used to know only its own, so the desktop on macOS printed
  // "Macos" and the phone had no word for win32 at all.
  assert.equal(label("darwin"), "macOS");
  assert.equal(label("macos"), "macOS");
  assert.equal(label("win32"), "Windows");
  assert.equal(label("linux"), "Linux");
  assert.equal(label("ios"), "iOS");
  assert.equal(label("android"), "Android");
  assert.equal(label("freebsd"), "Freebsd");
});

test("shows the build number beside the version when there is one", () => {
  const withBuild = describeAttached(
    buildReport("bug", { message: "m" }, { version: "1.4.0", build: "231" }),
  );
  assert.equal(withBuild.find((r) => r.label === "Gryt")?.value, "v1.4.0 (231)");
});

test("reads uptime the way somebody says it", () => {
  const at = (sessionUptimeSec: number) =>
    describeAttached(buildReport("bug", { message: "m" }, { sessionUptimeSec }))
      .find((r) => r.label === "Running for")?.value;
  assert.equal(at(30), "30 sec");
  assert.equal(at(120), "2 min");
  assert.equal(at(7200), "2 h");
});

test("the diagnostics type accepts what each app can find out", () => {
  // A compile-time check as much as a runtime one: if a field is removed from
  // the union, this stops typechecking rather than silently going unsent.
  const desktop: Diagnostics = { electronVersion: "38", chromeVersion: "140", logs: [] };
  const phone: Diagnostics = { expoVersion: "57", reactNativeVersion: "0.86", isEmulator: false };
  assert.ok(buildReport("bug", { message: "m" }, desktop));
  assert.ok(buildReport("bug", { message: "m" }, phone));
});
