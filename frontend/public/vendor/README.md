# Vendored map libraries

Leaflet and its three plugins, committed here and served from this origin
instead of being fetched from unpkg.com at page load.

They are loaded as plain `<script>` tags rather than npm imports for a reason
that has not changed -- see `src/map/leafletGlobal.js`: the plugins predate ESM
and extend a global `L`, and mixing that with a separately imported `L` risks
two live Leaflet instances that do not know about each other. What changed is
only *where the files come from*.

## Why they are here rather than on a CDN

A `<script src="https://unpkg.com/...">` with no integrity attribute is an
open instruction to run whatever that host returns. It does not take a
malicious CDN for that to matter: a compromised npm publish, a hijacked package
name, or a DNS answer that is not unpkg's all produce the same outcome, and the
code that runs has exactly the authority our own bundle has -- it can read the
admin configuration, rewrite what the map shows, and reach every endpoint the
page can reach. On a map shared by public link, that is every reader at once.

Serving them from here also lets `frontend/security-headers.conf` set
`script-src 'self'`, which is a meaningfully stronger statement than
`'self' https://unpkg.com`: with no third-party origin in the list, injected
markup has nowhere to pull code in from at all.

The side benefit is that the build and the running app no longer depend on
unpkg being up or reachable.

## What is here

| Path | Package | Version |
|------|---------|---------|
| `leaflet/` | leaflet | 1.9.4 |
| `leaflet.markercluster/` | leaflet.markercluster | 1.5.3 |
| `leaflet.heat/` | leaflet.heat | 0.2.0 |
| `leaflet-velocity/` | leaflet-velocity | 2.1.4 |

`leaflet/images/` is Leaflet's own icon set. `leaflet.css` references it by
relative path, so it has to sit next to the stylesheet or the layers control and
the default marker lose their graphics.

Everything is byte-for-byte as published on unpkg for those versions. Nothing
here is patched, and nothing here should be: a local edit would be invisible to
every tool that knows these as released packages.

## Updating a version

Replace the files from `https://unpkg.com/<package>@<version>/dist/...`, update
the table above, and rebuild. Check the release notes first -- these are pinned
versions and a plugin that expects a different Leaflet major will fail at
runtime rather than at build time, because none of this passes through the
bundler.
