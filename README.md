# @gryt/core

Gryt's shared application logic. One implementation of the things the desktop
app and the phone app both do.

## What goes in here

Two questions, and a module needs both answers to be yes:

- Would it compile with no DOM and no React Native?
- Would both apps otherwise need a copy?

`tsconfig.json` enforces the first by leaving `DOM` out of `lib`, so `document`,
`window` and `localStorage` fail to typecheck rather than working in one app and
breaking in the other. The second is a judgement call, and the surface guard is
what stops it drifting: `scripts/check-public-surface.mjs` fails when an export
is missing *and* when one appears that nobody listed.

## What does not

Anything that needs a platform. Fetching is the clearest case — the desktop and
the phone reach a server differently, and neither way belongs here — so this
package decides what a link preview *means* and each app fetches it.

Artwork is the other one. A brand logo is a React component on the desktop and
an SVG path or a favicon on the phone. This package owns the hostnames, the
colours and the path rules; each app maps a provider `id` to its own icon.

`@gryt/voice` splits web and native behind two entry points because a media
engine genuinely cannot avoid the platform. This package has no such entry on
purpose. If one becomes necessary, that is a decision to make out loud.

## What is in it now

**Reports** — the shape `Gryt-chat/reports` takes, and how an app fills it in.
The two apps had a copy each with the same seven exports and different insides.
Most of the difference was real: a renderer knows its Chrome build, a phone
knows whether it is a simulator. Some of it was not — `MESSAGE_MAX` was 8000 on
the desktop and 4000 on the phone, and nothing recorded a reason.

**Links** — which site a URL belongs to, what colour to draw its card, what line
to read out of its path, and which of four shapes a preview earns. 73 sites,
seven of which also read a detail from the path.

## Working on it

```bash
npm install
npm test          # node --test, no runner to install
npm run typecheck
npm run build     # tsc to dist/, then rewrite specifiers for ESM
npm run check-surface
```

`prepublishOnly` runs the build, the tests and the surface guard, so a release
that would have shipped a missing export fails before it leaves.

## Versioning

Both apps pin this package. They should pin the *same* version: the point is one
implementation, and two apps on different versions is two implementations with
extra steps. `@gryt/voice` is currently `0.4.4` in the client and `^0.3.2` in
mobile, which is the failure this is meant to avoid.
