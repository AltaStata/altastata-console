# syntax=docker/dockerfile:1.6
#
# Multi-stage build:
#   1. node: build the React frontend → /frontend/dist
#   2. python: install backend + altastata, copy frontend dist into /app/static
#
# Single container in prod (Option A): FastAPI/Uvicorn serves both
# /api/* and the static React app on the same port (8000).

FROM node:20-bookworm-slim AS frontend
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build


FROM python:3.11-slim-bookworm AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
        openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/pyproject.toml ./
COPY backend/src ./src
RUN pip install --no-cache-dir -e .

COPY --from=frontend /frontend/dist ./static
ENV STATIC_DIR=/app/static

EXPOSE 8000

CMD ["uvicorn", "altastata_console.main:app", \
     "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
