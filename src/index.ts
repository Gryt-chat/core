/**
 * Gryt's shared application logic.
 *
 * One implementation of the things the desktop and the phone both do. What
 * lives here is decided by a single test: could this file compile with no DOM
 * and no React Native, and would the two apps otherwise both need a copy? If
 * either answer is no, it belongs in the app.
 *
 * The barrel is flat and named rather than a set of subpath exports, because
 * the two apps import from it by name and `check-public-surface.mjs` asserts
 * that everything they import is actually here. Subpaths would need that guard
 * per path for no gain at this size.
 */

export {
  buildReport,
  describeAttached,
  MESSAGE_MAX,
  TITLE_MAX,
  type Diagnostics,
  type Report,
  type ReportType,
} from "./reports/report.js";

export {
  getAccentColor,
  getLinkProvider,
  getProviderDetail,
  hostnameOf,
  LINK_PROVIDERS,
  type LinkProvider,
} from "./links/providers.js";

export {
  describePreviewFailure,
  extractUrls,
  getCardSubtitle,
  getLinkCardLayout,
  type LinkCardLayout,
  type LinkPreviewData,
} from "./links/preview.js";

export {
  normalizeCode,
  normalizeHost,
  parseServerInput,
  type ServerInput,
} from "./servers/address.js";

export { NAME_POOL, pickRandomName } from "./profile/randomName.js";

export {
  cellState,
  CUSTOM_VALUE,
  describeRules,
  EVERYONE_VALUE,
  indexRules,
  nextCellState,
  scopeChoiceFromValue,
  scopeChoiceValue,
  scopeOptions,
  scopeSetPayload,
  withCell,
  type CellState,
  type ChannelRule,
  type RuleEffect,
  type ScopeChoice,
} from "./permissions/channelRules.js";
