# Bridgething Calendar source

Calendar for the Spotify Car Thing running [bridgething](https://bridgething.com).

## First run

1. Push this repo to `https://github.com/dharmapoudel/bridgething-calendar-source`.
2. In **Settings > Pages**, set the source to **Deploy from a branch**, branch `gh-pages`, folder `/ (root)`.

The catalog is published to `https://dharmapoudel.github.io/bridgething-calendar-source/catalog.v1.json`, which can be submitted to <https://bridgething.com/apps>.

## Develop

```sh
bun run dev            # develop the app against a connected bridgething instance
bun run dev:device     # show the dev server on the car thing screen
bun run push           # build and install to the device
bun run check          # ensure the catalog is valid
```

Screenshot for the store listing:

```sh
bun run shot bridgething-calendar            # grabs what is on the screen
bun run shot bridgething-calendar --replace  # overwrite
```

## Publish a new version

```sh
bun run bump bridgething-calendar <major|minor|patch|x.y.z> -m "note"
git push   # CI builds, validates, and publishes to gh-pages
```

## Apps

| App | Description |
|---|---|
| [Calendar](apps/bridgething-calendar) | Month view, agenda, next-event countdown, and one-tap Join for meetings, via ICS feeds. |
