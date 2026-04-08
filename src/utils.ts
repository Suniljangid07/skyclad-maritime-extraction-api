import crypto from 'node:crypto';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly retryAfterMs: number | null;
  public readonly extractionId: string | null;

  constructor(statusCode: number, code: string, message: string, options?: { retryAfterMs?: number | null; extractionId?: string | null }) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfterMs = options?.retryAfterMs ?? null;
    this.extractionId = options?.extractionId ?? null;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function ensureJsonObject(raw: string): string {
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new Error('No JSON object boundaries found');
  }
  return raw.slice(first, last + 1);
}

export function safeJsonParse<T>(raw: string): T {
  return JSON.parse(ensureJsonObject(raw)) as T;
}

export function normalizeIp(ip: string | undefined): string {
  if (!ip) {
    return 'unknown';
  }

  return ip.replace('::ffff:', '');
}

export function parseDdMmYyyy(value: string | null | undefined): Date | null {
  if (!value || value === 'No Expiry' || value === 'Lifetime') {
    return null;
  }

  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) {
    return null;
  }

  const [, dd, mm, yyyy] = match;
  const date = new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function daysBetween(start: Date, end: Date): number {
  const millisPerDay = 24 * 60 * 60 * 1000;
  return Math.ceil((end.getTime() - start.getTime()) / millisPerDay);
}

export function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}
