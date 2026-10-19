// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "**/*.js", "**/*.mjs", "**/*.cjs", "*.tgz"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  // Our own values get real types; existing debt is listed below, the goal is to empty it (GRYT-1792).
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-restricted-types": ["error", { types: { unknown: "Type it. If it's outside input being checked, list the file in the config with the reason." } }],
      "no-restricted-syntax": ["error", {
        selector: "TSAsExpression > TSAsExpression.expression[typeAnnotation.type='TSUnknownKeyword']",
        message: "Don't cast through unknown. Fix the types, or disable this line with the reason.",
      }],
      "no-nested-ternary": "error",
      eqeqeq: ["error", "smart"],
      "no-else-return": "error",
      "prefer-const": "error",
      "no-param-reassign": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports", disallowTypeAnnotations: false }],
    },
  },
  // unknown: tests build loose values on purpose.
  {
    files: [
      "src/mls/addOwnDevice.test.ts",
      "src/mls/content.test.ts",
      "src/mls/dmDriver.test.ts",
      "src/pairing/pairing.test.ts",
      "src/servers/address.test.ts",
    ],
    rules: { "@typescript-eslint/no-restricted-types": "off" },
  },
  // unknown: stored and parsed data arrives unchecked and is validated there.
  {
    files: [
      "src/mls/content.ts",
      "src/pairing/channel.ts",
      "src/pairing/newDevice.ts",
      "src/pairing/relay.fake.ts",
      "src/terms/termsAgreement.ts",
    ],
    rules: { "@typescript-eslint/no-restricted-types": "off" },
  },
  // unknown: socket payloads arrive unchecked and are validated there.
  {
    files: [
      "src/mls/deliveryService.fake.ts",
      "src/mls/dmDriver.ts",
      "src/mls/interfaces.ts",
    ],
    rules: { "@typescript-eslint/no-restricted-types": "off" },
  },
  // unknown: requests and responses arrive unchecked.
  {
    files: [
      "src/pairing/approver.ts",
      "src/pairing/relayClient.ts",
    ],
    rules: { "@typescript-eslint/no-restricted-types": "off" },
  },
  // unknown: caught errors are unknown until checked.
  {
    files: [
      "src/pairing/historyReceiver.ts",
    ],
    rules: { "@typescript-eslint/no-restricted-types": "off" },
  },
  // unknown: not typed yet.
  {
    files: [
      "src/pairing/interfaces.ts",
      "src/reports/report.ts",
    ],
    rules: { "@typescript-eslint/no-restricted-types": "off" },
  },
  // Casts through unknown where the types don't line up yet.
  {
    files: [
      "src/mls/addOwnDevice.test.ts",
      "src/mls/deliveryService.fake.ts",
      "src/pairing/approver.ts",
      "src/servers/address.test.ts",
    ],
    rules: { "no-restricted-syntax": "off" },
  },
  // Non-null assertions from before the rule.
  {
    files: [
      "src/mls/addOwnDevice.test.ts",
      "src/mls/deliveryService.fake.ts",
      "src/mls/dmDriver.test.ts",
      "src/pairing/approver.ts",
      "src/pairing/history.test.ts",
      "src/pairing/newDevice.ts",
      "src/pairing/pairing.test.ts",
      "src/pairing/relay.fake.ts",
    ],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
  // @typescript-eslint/no-unused-vars: from before ESLint ran here.
  {
    files: [
      "src/mls/addOwnDevice.test.ts",
      "src/pairing/historySender.ts",
    ],
    rules: { "@typescript-eslint/no-unused-vars": "off" },
  },
  // Nested ternaries from before the rule.
  {
    files: [
      "src/mls/deliveryService.fake.ts",
      "src/pairing/historySnapshot.ts",
      "src/reports/report.ts",
    ],
    rules: { "no-nested-ternary": "off" },
  },
  // Reassigned parameters from before the rule.
  {
    files: [
      "src/pairing/approver.ts",
      "src/pairing/relay.fake.ts",
    ],
    rules: { "no-param-reassign": "off" },
  },
  // @typescript-eslint/no-unused-expressions: from before ESLint ran here.
  {
    files: [
      "src/pairing/channel.ts",
      "src/pairing/relay.fake.ts",
    ],
    rules: { "@typescript-eslint/no-unused-expressions": "off" },
  },
  // let that could be const, from before the rule.
  {
    files: [
      "src/pairing/relay.fake.ts",
    ],
    rules: { "prefer-const": "off" },
  },
);
