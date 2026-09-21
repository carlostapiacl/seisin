# site/

The landing page, published to GitHub Pages by
[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) on every push to `main`
that touches this directory.

**One page, no build, no dependencies.** Everything is inline except the two GIFs and the
shields.io badges.

## Why `site/` and not `docs/`

Pointing Pages at `docs/` would hand its markdown to Jekyll, which would render a second,
worse copy of pages that are meant to be read on GitHub. This directory is the only thing
that has to be Pages-shaped.

## Previewing it

The GIFs are not checked in here — `docs/img/` holds the only copy, because two copies of a
binary drift the moment one is regenerated. The workflow copies them in; locally you do it
yourself:

```bash
cp -R docs/img site/img          # from the repo root; site/img/ is gitignored
python3 -m http.server -d site 8931
open http://localhost:8931/
```

## What it may claim

The same rule as the README: nothing on the page is a number or a behaviour that has not
been measured. If a claim here is not also in the README or `docs/`, it does not belong on
the page.
