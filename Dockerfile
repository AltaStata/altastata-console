# syntax=docker/dockerfile:1.6
#
# Multi-stage build for the AltaStata Console UI:
#
#   1. builder  — Node stage that runs `npm ci` and `npm run build`.
#                 This is an internal stage; it carries the whole
#                 toolchain (node_modules, TypeScript, Vite, etc.) and
#                 is not meant to be published.
#   2. dist     — Tiny `scratch`-based stage that contains *only* the
#                 built bundle in /app/dist. Use this target when
#                 embedding the UI into another image (e.g. a Jupyter
#                 image) via `COPY --from=...`.
#   3. runtime  — Self-contained nginx image that serves the SPA on
#                 port 8080 with SPA history-API fallback. This is the
#                 default target.
#
# Build a standalone container:
#     docker build -t altastata-console:latest .
#
# Build only the static bundle for embedding:
#     docker build --target dist -t altastata-console:dist .
# Then in another image:
#     COPY --from=altastata-console:dist /app/dist /target/path
#
# The UI talks directly to the AltaStata gRPC server (gRPC-Web). The
# gRPC URL is configurable at runtime from the in-app Settings dialog,
# so this image needs no gRPC-related environment variables.

FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build


FROM scratch AS dist
COPY --from=builder /app/dist /app/dist


FROM nginx:alpine AS runtime
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx/default.conf /etc/nginx/conf.d/default.conf

# Listen on an unprivileged port so the image runs under arbitrary
# non-root UIDs (e.g. on OpenShift) without extra capabilities.
EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
