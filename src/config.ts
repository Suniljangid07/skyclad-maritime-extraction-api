import dotenv from 'dotenv';
import path from 'node:path';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('3000'),
  DATABASE_PATH: z.string().default(path.join(process.cwd(), 'data', 'app.db')),
  STORAGE_ROOT: z.string().default(path.join(process.cwd(), 'data', 'stored-files')),
  LLM_PROVIDER: z.string().default('mock'),
  LLM_MODEL: z.string().default('mock-vision'),
  LLM_API_KEY: z.string().default('mock-key'),
  LLM_BASE_URL: z.string().optional(),
  LLM_TIMEOUT_MS: z.string().default('30000'),
  QUEUE_POLL_INTERVAL_MS: z.string().default('1000'),
  MAX_FILE_SIZE_BYTES: z.string().default(String(10 * 1024 * 1024)),
  RATE_LIMIT_MAX_REQUESTS: z.string().default('10'),
  RATE_LIMIT_WINDOW_MS: z.string().default(String(60_000)),
  WEBHOOK_SECRET: z.string().default('dev-webhook-secret')
});

const parsed = envSchema.parse(process.env);

export const config = {
  port: Number(parsed.PORT),
  databasePath: parsed.DATABASE_PATH,
  storageRoot: parsed.STORAGE_ROOT,
  llmProvider: parsed.LLM_PROVIDER,
  llmModel: parsed.LLM_MODEL,
  llmApiKey: parsed.LLM_API_KEY,
  llmBaseUrl: parsed.LLM_BASE_URL,
  llmTimeoutMs: Number(parsed.LLM_TIMEOUT_MS),
  queuePollIntervalMs: Number(parsed.QUEUE_POLL_INTERVAL_MS),
  maxFileSizeBytes: Number(parsed.MAX_FILE_SIZE_BYTES),
  rateLimitMaxRequests: Number(parsed.RATE_LIMIT_MAX_REQUESTS),
  rateLimitWindowMs: Number(parsed.RATE_LIMIT_WINDOW_MS),
  webhookSecret: parsed.WEBHOOK_SECRET
} as const;
