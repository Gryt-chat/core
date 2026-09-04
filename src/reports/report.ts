/* `POST /v1/reports`. Only `type` and `message` are required; the service
   truncates or drops a bad field rather than rejecting the report. So nothing
   here throws, and a diagnostic an app cannot work out is left off rather than
   guessed — a wrong Electron version is worse than no Electron version. */

export type ReportType = "bug" | "feedback";

/** The fields an app can fill. The service accepts more. */
export interface Report {
  type: ReportType;
  message: string;
  title?: string;
  app?: {
    version?: string;
    /** The build number, where the platform has one distinct from the version. */
    build?: string;
    channel?: string;
    /** Random per install, not per person. What rate limits are counted against. */
    installId?: string;
    locale?: string;
  };
  device?: {
    platform?: string;
    osVersion?: string;
    /** A crash only simulators produce is worth telling apart from a real one. */
    isEmulator?: boolean;
    screen?: { width: number; height: number; scale: number };
    timezone?: string;
  };
  runtime?: {
    engine?: string;
    chromeVersion?: string;
    electronVersion?: string;
    reactNativeVersion?: string;
    expoVersion?: string;
    userAgent?: string;
  };
  context?: {
    route?: string;
    serverVersion?: string;
    connected?: boolean;
    voiceActive?: boolean;
    online?: boolean;
    networkType?: string;
    /** "It broke twenty minutes in" and "it broke on launch" are different bugs. */
    sessionUptimeSec?: number;
  };
  /** The tail of the app's own log, where it keeps one. */
  logs?: string[];
  extra?: Record<string, unknown>;
}

/**
 * What an app knows about itself when somebody opens the form.
 *
 * Passed in rather than read here, so the assembly below stays readable and
 * testable: every one of these comes from somewhere that needs a running app —
 * the Electron bridge, `expo-constants`, `Platform`, the socket layer.
 */
export interface Diagnostics {
  version?: string | null;
  build?: string | null;
  channel?: string | null;
  installId?: string | null;
  locale?: string | null;
  platform?: string | null;
  /** A number on some platforms: Android's API level arrives as one. */
  osVersion?: string | number | null;
  isEmulator?: boolean | null;
  screen?: { width: number; height: number; scale: number } | null;
  timezone?: string | null;
  engine?: string | null;
  chromeVersion?: string | null;
  electronVersion?: string | null;
  reactNativeVersion?: string | null;
  expoVersion?: string | null;
  userAgent?: string | null;
  route?: string | null;
  serverVersion?: string | null;
  connected?: boolean | null;
  voiceActive?: boolean | null;
  online?: boolean | null;
  networkType?: string | null;
  sessionUptimeSec?: number | null;
  /** Whether this app is running the server it is connected to. */
  embeddedServer?: boolean | null;
  /** The version of that embedded server, which is not the app's. */
  embeddedServerVersion?: string | null;
  logs?: string[];
}

/**
 * The service truncates, but an app should not send a novel either.
 *
 * Generous rather than tight: somebody describing a bug properly is the good
 * case, and cutting them off at a tweet is how you get "it broke" instead. The
 * desktop's 8000 wins over the phone's 4000 on exactly that argument, which
 * both files made and only one of them followed.
 */
export const MESSAGE_MAX = 8000;
export const TITLE_MAX = 120;

/** Trimmed, capped, and undefined rather than empty. */
function text(value: string | null | undefined, max: number): string | undefined {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Only the keys that have a value, or undefined if none of them do. */
function some<T extends object>(entries: T): T | undefined {
  const kept = Object.entries(entries).filter(([, v]) => v !== undefined);
  return kept.length ? (Object.fromEntries(kept) as T) : undefined;
}

function str(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  return s ? s : undefined;
}

function bool(value: boolean | null | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function count(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Assemble what gets sent.
 *
 * `type` and `message` always; every diagnostic only if it is actually known.
 * An empty `device` object says "this app does not collect device
 * information", which is a different and wronger claim than leaving it off.
 */
export function buildReport(
  type: ReportType,
  input: { message: string; title?: string },
  diagnostics: Diagnostics = {},
): Report {
  /* The embedded server is two fields on the wire rather than one, because
   * "running its own server" and "which version that server is" answer
   * different questions and the second is often the one that matters. Neither
   * has a column on the service, so they go in `extra`, which is what it is
   * for. Only the desktop can run one, and the phone simply never sets them. */
  const extra = some({
    embeddedServer: bool(diagnostics.embeddedServer),
    embeddedServerVersion: str(diagnostics.embeddedServerVersion),
  });

  return {
    type,
    // Capped rather than validated. The service rejects only an empty message,
    // and the form is what stops it being empty.
    message: text(input.message, MESSAGE_MAX) ?? "",
    title: text(input.title, TITLE_MAX),
    app: some({
      version: str(diagnostics.version),
      build: str(diagnostics.build),
      channel: str(diagnostics.channel),
      installId: str(diagnostics.installId),
      locale: str(diagnostics.locale),
    }),
    device: some({
      platform: str(diagnostics.platform),
      osVersion: str(diagnostics.osVersion),
      isEmulator: bool(diagnostics.isEmulator),
      screen: diagnostics.screen ?? undefined,
      timezone: str(diagnostics.timezone),
    }),
    runtime: some({
      engine: str(diagnostics.engine),
      chromeVersion: str(diagnostics.chromeVersion),
      electronVersion: str(diagnostics.electronVersion),
      reactNativeVersion: str(diagnostics.reactNativeVersion),
      expoVersion: str(diagnostics.expoVersion),
      userAgent: str(diagnostics.userAgent),
    }),
    context: some({
      route: str(diagnostics.route),
      serverVersion: str(diagnostics.serverVersion),
      connected: bool(diagnostics.connected),
      voiceActive: bool(diagnostics.voiceActive),
      online: bool(diagnostics.online),
      networkType: str(diagnostics.networkType),
      sessionUptimeSec: count(diagnostics.sessionUptimeSec),
    }),
    logs: diagnostics.logs?.length ? diagnostics.logs : undefined,
    extra,
  };
}

/** "2 min", not "127 s". A duration somebody reads, not a field. */
function uptime(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  if (seconds < 90) return `${seconds} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

/* Display only; the wire keeps the service's lowercase enum. */
function platformLabel(platform: string): string {
  if (platform === "darwin" || platform === "macos") return "macOS";
  if (platform === "win32" || platform === "windows") return "Windows";
  if (platform === "linux") return "Linux";
  if (platform === "ios") return "iOS";
  if (platform === "android") return "Android";
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

/* Built from the report rather than the inputs, so it cannot drift from what
   actually goes. Every row is conditional. */
export function describeAttached(report: Report): { label: string; value: string }[] {
  const lines: { label: string; value: string }[] = [];
  const add = (label: string, value: string | undefined) => {
    if (value) lines.push({ label, value });
  };

  const device = report.device;
  add(
    "Gryt",
    report.app?.version
      ? `v${report.app.version}${report.app.build ? ` (${report.app.build})` : ""}`
      : undefined,
  );
  add("Channel", report.app?.channel);
  add(
    "System",
    device?.platform && device?.osVersion
      ? `${platformLabel(device.platform)} ${device.osVersion}`
      : device?.platform
        ? platformLabel(device.platform)
        : undefined,
  );
  add("Simulator", device?.isEmulator ? "yes" : undefined);
  add("Electron", report.runtime?.electronVersion);
  add("Chrome", report.runtime?.chromeVersion);
  add("React Native", report.runtime?.reactNativeVersion);
  add("Expo", report.runtime?.expoVersion);
  add(
    "Window",
    device?.screen
      ? `${device.screen.width}×${device.screen.height} @${device.screen.scale}x`
      : undefined,
  );
  add("Timezone", device?.timezone);
  add("Where you were", report.context?.route);
  add("Running for", uptime(report.context?.sessionUptimeSec));
  add("Server", report.context?.serverVersion);
  add("In voice", report.context?.voiceActive ? "yes" : undefined);
  add(
    "Own server",
    report.extra?.embeddedServer
      ? String(report.extra.embeddedServerVersion ?? "yes")
      : undefined,
  );
  add("Log", report.logs?.length ? `last ${report.logs.length} lines` : undefined);
  add("Install", report.app?.installId);

  return lines;
}
