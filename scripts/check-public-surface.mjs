// Asserts the package exports everything the two apps import from it.
//
// The same guard @gryt/voice carries, and for the same reason: two releases of
// that package built, typechecked and published while missing exports the
// client needed, and each was found by installing the package and waiting for
// tsc to complain. That is a slow way to learn something a list can check.
//
// This one has a second job voice's does not. The point of the package is that
// the desktop and the phone use one implementation, so an export dropping off
// this list because only one app still imports it is the drift becoming
// visible. Cut it deliberately, not by forgetting.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REQUIRED = [
  // reports
  "MESSAGE_MAX",
  "TITLE_MAX",
  "buildReport",
  "describeAttached",
  // links
  "LINK_PROVIDERS",
  "describePreviewFailure",
  "extractUrls",
  "getAccentColor",
  "getCardSubtitle",
  "getLinkCardLayout",
  "getLinkProvider",
  "getProviderDetail",
  "hostnameOf",
  // profile
  "NAME_POOL",
  "pickRandomName",
  // permissions
  "CUSTOM_VALUE",
  "EVERYONE_VALUE",
  "cellState",
  "describeRules",
  "indexRules",
  "nextCellState",
  "scopeChoiceFromValue",
  "scopeChoiceValue",
  "scopeOptions",
  "scopeSetPayload",
  "withCell",
];

// Types are erased at runtime, so they are checked against the .d.ts instead.
const REQUIRED_TYPES = [
  "Diagnostics",
  "LinkCardLayout",
  "LinkPreviewData",
  "LinkProvider",
  "Report",
  "ReportType",
  "CellState",
  "ChannelRule",
  "RuleEffect",
  "ScopeChoice",
];

const dist = resolve("dist/index.js");
const types = resolve("dist/index.d.ts");

let failed = false;

const mod = await import(`file://${dist}`).catch((err) => {
  console.error(`cannot import ${dist}: ${err.message}`);
  console.error("run `npm run build` first");
  process.exit(1);
});

const missing = REQUIRED.filter((name) => !(name in mod));
if (missing.length) {
  console.error(`missing runtime exports: ${missing.join(", ")}`);
  failed = true;
}

const declarations = await readFile(types, "utf8");
const missingTypes = REQUIRED_TYPES.filter(
  (name) => !new RegExp(`\\b${name}\\b`).test(declarations),
);
if (missingTypes.length) {
  console.error(`missing type exports: ${missingTypes.join(", ")}`);
  failed = true;
}

// A barrel that grew an export nobody listed is the same drift in reverse: it
// means something was added without deciding it was shared.
const extra = Object.keys(mod).filter((name) => !REQUIRED.includes(name));
if (extra.length) {
  console.error(`exported but not listed as required: ${extra.join(", ")}`);
  console.error("add it to REQUIRED here once both apps use it, or keep it internal");
  failed = true;
}

if (failed) process.exit(1);
console.log(
  `public surface: ok (${REQUIRED.length} values, ${REQUIRED_TYPES.length} types)`,
);
