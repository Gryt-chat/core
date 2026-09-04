/* What belongs here: it must compile with no DOM and no React Native, and both
   apps must otherwise need a copy. The barrel is flat and named because
   `check-public-surface.mjs` asserts against it. */

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
  getProviderLogo,
  LINK_PROVIDER_LOGOS,
  LOGO_VIEW_BOX,
} from "./links/logos.js";

export {
  describePreviewFailure,
  extractUrls,
  getCardSubtitle,
  getLinkCardLayout,
  type LinkCardLayout,
  type LinkPreviewData,
} from "./links/preview.js";

export {
  conversationTitle,
  type DirectConversation,
} from "./conversations/title.js";

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

export {
  groupMembersByRole,
  OFFLINE_GROUP_KEY,
  UNGROUPED_GROUP_KEY,
  type GroupableMember,
  type GroupableRole,
  type MemberGroup,
} from "./members/groups.js";
