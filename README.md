# Maritime Extraction Service

Production-oriented TypeScript service for maritime document extraction, async job processing, cross-document validation, session reporting, retry flows, expiry monitoring, and interactive Swagger testing.

## What a reviewer needs

This repo is set up so someone can clone it and run it locally without extra infrastructure.

The default `.env.example` uses the `mock` provider, which means the API, queue flow, Swagger UI, and tests all work out of the box for evaluation. To use a real vision LLM, copy `.env.example` to `.env` and replace the provider settings.

## Stack

- Node.js + TypeScript + Express
- SQLite via Node's built-in `node:sqlite`
- Durable job state in SQLite
- Durable uploaded-file storage on local disk for restart-safe async processing
- Configurable LLM provider via `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`
- Swagger UI for local API testing

## Run locally

1. Install dependencies

```bash
npm install
```

2. Copy the environment template

```bash
cp .env.example .env
```

3. Start the app

```bash
npm run dev
```

## Local URLs

- Swagger UI: `http://localhost:3000/docs`
- OpenAPI JSON: `http://localhost:3000/openapi.json`
- Root path: `http://localhost:3000/` redirects to `/docs`
- Health check: `http://localhost:3000/api/health`

## Supported providers

- `mock`
- `anthropic`
- `gemini`
- `openai`
- `groq`
- `mistral`
- `ollama`

## Environment variables

See [.env.example](./.env.example).

Important ones:

- `LLM_PROVIDER`
- `LLM_MODEL`
- `LLM_API_KEY`
- `DATABASE_PATH`
- `STORAGE_ROOT`
- `WEBHOOK_SECRET`

## Endpoints

- `POST /api/extract?mode=sync|async`
- `GET /api/jobs/:jobId`
- `POST /api/jobs/:jobId/retry`
- `GET /api/sessions/:sessionId`
- `GET /api/sessions/:sessionId/expiring?withinDays=90`
- `POST /api/sessions/:sessionId/validate`
- `GET /api/sessions/:sessionId/report`
- `GET /api/health`

## Notes

- Upload size limit is 10MB.
- Supported MIME types are JPEG, PNG, and PDF.
- Deduplication is per session using SHA-256 file hashes.
- `POST /api/extract` is rate-limited to 10 requests per minute per IP.
- Async uploads are stored durably under `STORAGE_ROOT`, so queued jobs can survive process restarts.
- Optional async webhook delivery is supported through `webhookUrl` on `POST /api/extract` plus HMAC signing with `WEBHOOK_SECRET` in the `x-skyclad-signature` header.
- Swagger UI supports trying all endpoints directly, including multipart upload for `POST /api/extract`.

## Test

```bash
npm test
```
