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
      // Dropping a key with `{ key, ...rest }` is how we omit one.
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
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
      "src/pairing/interfaces.ts",
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
  // Tests and fakes may cast through unknown to hand a fake where the real type is wide.
  {
    files: ["**/*.test.ts", "**/*.fake.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
  // Tests and fakes may assert non-null: a wrong guess fails the test, which is the point.
  {
    files: ["**/*.test.ts", "**/*.fake.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
