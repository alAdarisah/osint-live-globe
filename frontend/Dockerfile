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

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
