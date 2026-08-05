# API-only backend image. Unlike the root Dockerfile (which bakes the
# frontend build in for the single-container Render deploy), this one ships
# no frontend/dist at all -- app.py detects that and serves the API alone,
# with the React app running as its own nginx container that proxies /api
# here (see docker-compose.yml and frontend/nginx.conf).
FROM python:3.12-slim

WORKDIR /app

# Build context is the repo root (see docker-compose.yml's build.context),
# so requirements.txt resolves from there. Installed before the source copy
# so a code change doesn't invalidate the dependency layer.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./backend/

# Bind on all interfaces so the frontend container can reach it over the
# compose network; PORT also switches app.py's run() out of its local
# "open a browser tab" path, which makes no sense in a container.
ENV PORT=8000
EXPOSE 8000

CMD ["python", "-m", "backend.app"]
