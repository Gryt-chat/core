<div align="center">
  <img src="https://raw.githubusercontent.com/Gryt-chat/client/main/public/logo.svg" width="80" alt="Gryt logo" />
  <h1>@gryt/core</h1>
  <p>The application logic from <a href="https://github.com/Gryt-chat/gryt">Gryt</a> that the desktop and the phone both run.<br />One implementation of the things they were each doing separately.</p>
</div>

<br />

```sh
npm install @gryt/core
```

The desktop app and the mobile app carried a copy each of the same decisions.
Some were real copies, some were the same idea written twice, and nothing told
the two apart until somebody diffed them by hand. `report.ts` had the same seven
exports on both sides and a different `MESSAGE_MAX` on each, 8000 against 4000,
with nothing recording why.

They run this, not two ports of it. Both apps should pin the same version: a
shared package on two versions is two implementations again.

## What goes in here

Two questions, and a module needs both answers to be yes:

- Would it compile with no DOM and no React Native?
- Would both apps otherwise need a copy?

`tsconfig.json` enforces the first by leaving `DOM` out of `lib`, so `document`,
`window` and `localStorage` fail to typecheck rather than working in one app and
breaking in the other. The second is a judgement call, and the surface guard is
what stops it drifting: `scripts/check-public-surface.mjs` fails when an export
goes missing **and** when one appears that nobody listed.

## What it is

- **`reports`** — the shape [`Gryt-chat/reports`](https://github.com/Gryt-chat/reports)
  takes, and how an app fills it in. `Diagnostics` is the union of what each
  platform can find out, so a renderer sends its Chrome build, a phone sends
  whether it's a simulator, and a field neither fills can be seen to be dead.
- **`links`** — which site a URL belongs to, what colour to draw its card, what
  line to read out of its path, and which of four shapes a preview earns. 73
  sites, seven of which also read a detail from the path.

## What deliberately isn't

Anything needing a platform. Fetching is the clearest case: the desktop and the
phone reach a server differently, so this decides what a link preview *means*
and each app goes and gets it.

Artwork is the other one. A brand logo is a React component on the desktop and
an SVG path or a favicon on the phone, so the package owns the hostnames, the
colours and the path rules, and each app maps a provider `id` to its own icon.

[`@gryt/voice`](https://github.com/Gryt-chat/voice) splits web and native behind
two entry points because a media engine can't avoid the platform. This package
has no such entry, on purpose. If one becomes necessary, that's a decision to
make out loud rather than by adding `DOM` to the tsconfig.

## Checks

```bash
npm test          # node --test, no runner to install
npm run typecheck
npm run build     # tsc to dist/, then rewrite specifiers for ESM
npm run check-surface
```

`prepublishOnly` runs the build, the tests and the surface guard, so a release
that would have shipped a missing export fails before it leaves.

## Issues

Please report bugs and request features in the
[main Gryt repository](https://github.com/Gryt-chat/gryt/issues).

## Sponsors

What sponsoring pays for, the tiers, and everyone who has sponsored:
[gryt.chat/sponsors](https://gryt.chat/sponsors). To sponsor:
[GitHub Sponsors](https://github.com/sponsors/Gryt-chat).

The list itself lives in the [Gryt README](https://github.com/Gryt-chat/gryt#sponsors),
in one place rather than ten, so it cannot fall out of step across repositories.

## License

[AGPL-3.0](https://github.com/Gryt-chat/gryt/blob/main/LICENSE) — Part of [Gryt](https://github.com/Gryt-chat/gryt)

[`@gryt/ui`](https://github.com/Gryt-chat/ui) is the exception in this org, and
deliberately so: it's generic components with nothing of Gryt in them, and
copyleft there would rule out most of the people who might use it.

This isn't that. It's the decisions the Gryt apps make, which is the product
rather than scaffolding around it. It's still yours to embed, self-host and
modify. The licence only bites for running a modified version as a closed
service.
