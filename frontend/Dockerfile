# Frontend image: build the React/Vite bundle, then serve it from nginx,
# which also reverse-proxies /api to the backend container so the browser
# talks to a single origin (see nginx.conf -- this is why no CORS config is
# needed anywhere, and why src/api.js's relative "/api/..." URLs work
# unchanged in both the split and single-container setups).
FROM node:20-slim AS build
WORKDIR /app

# Copied first so `npm ci` is cached until the lockfile itself changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . ./
RUN npm run build

# Compress every asset once, here, at the highest level -- rather than on every
# request, forever, at a level chosen to keep a request fast.
#
# Vite's output is content-hashed and served `immutable`, so a file's bytes never
# change after this line runs: compressing them per request was paying the same
# CPU repeatedly for an answer that could not differ. `-9 -k` keeps the original
# beside the .gz, because nginx needs it for any client that does not send
# Accept-Encoding, and gzip_static falls back to it.
#
# Only the types worth it. Fonts, PNGs and the like are already compressed, and a
# .gz sibling of a .woff2 is bytes on disk that nginx will never serve.
RUN find /app/dist -type f \
      '(' -name '*.js' -o -name '*.css' -o -name '*.html' \
          -o -name '*.svg' -o -name '*.json' -o -name '*.map' ')' \
      -size +1k -exec gzip -9 -k {} ';' \
    && du -sh /app/dist

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Included by both server blocks, same reasoning as the two files below it: a
# file of bare directives is not a valid top-level config.
COPY compression.conf /etc/nginx/compression.conf
# Included by both server blocks in nginx.conf. Outside conf.d/ on purpose:
# everything in that directory is loaded as a top-level config, and a file of
# bare proxy directives is not valid there.
COPY api-proxy.conf /etc/nginx/api-proxy.conf
# The response headers both listeners send, in a file for the same reason:
# included from several locations, and not valid as a top-level config.
COPY security-headers.conf /etc/nginx/security-headers.conf
# 80 is the private entry point (SSH tunnel), 8081 the public read-only one that
# the Cloudflare tunnel points at. See nginx.conf.
EXPOSE 80 8081
