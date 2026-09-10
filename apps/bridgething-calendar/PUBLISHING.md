# Publishing Calendar to the Bridgething store

A Bridgething "source" is a repo that builds your app, hosts the bundles on
GitHub Pages, and serves a `catalog.v1.json` that the companion app reads.
This guide maps every part of the store listing to the file it comes from.

## What the store listing shows — field by field

| Store listing | Comes from |
|---|---|
| App icon | `apps/bridgething-calendar/public/icon.png` (wired via manifest `"icon"`) |
| Name ("Calendar") | `public/manifest.json` → `name` |
| Author ("Dharma Poudel") | `apps/bridgething-calendar/catalog.json` → `author` |
| Version badge | The published version in the catalog (automatic) |
| Description paragraph | `public/manifest.json` → `description` |
| WHAT THIS APP CAN DO ("use the internet") | `public/manifest.json` → `permissions` (`net.fetch` renders as internet access) |
| VERSIONS (version, release notes, date, "needs firmware X", size) | Each published version; release notes from `CHANGELOG.md`, firmware floor from `catalog.json` → `min_libbridgething_version` |
| WHERE THIS CAME FROM → homepage | `apps/bridgething-calendar/catalog.json` → `homepage` |
| WHERE THIS CAME FROM → source code | `apps/bridgething-calendar/catalog.json` → `source` |
| Screenshots (first one shown on the listing) | `apps/bridgething-calendar/screenshots/*.png` (800×480 landscape, auto-discovered) |

## Release checklist

1. `bun run check` — typecheck, build, bundle, and validate the catalog. This is exactly what CI runs.
2. `bun run bump bridgething-calendar <patch|minor|major|x.y.z> -m "note"` — moves `public/manifest.json` and `package.json` together and opens the changelog section. Never edit the version by hand.
3. Push to `main` — the `publish` workflow builds every unpublished version and pushes the catalog to the `gh-pages` branch.
4. Verify `https://dharmapoudel.github.io/bridgething-calendar-source/catalog.v1.json` serves the new version.
5. Submit the catalog URL at <https://bridgething.com/apps>.

## Rules that are not negotiable

- A published version is immutable. Changing the app means a new version, always.
- `site/` is generated and gitignored. Nothing about a release belongs on main.
- The app id in `public/manifest.json` (`01a0890e-4a23-7000-bd4e-439997d71981`) must never change: the device keys upgrades and stored data on it.
