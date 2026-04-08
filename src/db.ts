import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ExtractionRecord, ValidationResult } from './types.js';
import { nowIso } from './utils.js';

type SqlValue = string | number | null;

export class Database {
  private readonly db: DatabaseSync;

  constructor(private readonly databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS extractions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        stored_file_path TEXT,
        document_type TEXT,
        document_name TEXT,
        category TEXT,
        applicable_role TEXT,
        confidence TEXT,
        holder_name TEXT,
        date_of_birth TEXT,
        sirb_number TEXT,
        passport_number TEXT,
        date_of_issue TEXT,
        date_of_expiry TEXT,
        days_until_expiry INTEGER,
        revalidation_required INTEGER,
        fields_json TEXT NOT NULL,
        validity_json TEXT,
        compliance_json TEXT,
        medical_data_json TEXT,
        flags_json TEXT NOT NULL,
        is_expired INTEGER NOT NULL DEFAULT 0,
        summary TEXT,
        raw_llm_response TEXT,
        prompt_version TEXT NOT NULL,
        processing_time_ms INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        extraction_id TEXT NOT NULL REFERENCES extractions(id),
        webhook_url TEXT,
        status TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        retryable INTEGER NOT NULL DEFAULT 0,
        delivery_status TEXT,
        delivery_error TEXT,
        delivered_at TEXT,
        queued_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS validations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    this.addColumnIfMissing('extractions', 'stored_file_path', 'TEXT');
    this.addColumnIfMissing('extractions', 'date_of_issue', 'TEXT');
    this.addColumnIfMissing('extractions', 'date_of_expiry', 'TEXT');
    this.addColumnIfMissing('extractions', 'days_until_expiry', 'INTEGER');
    this.addColumnIfMissing('extractions', 'revalidation_required', 'INTEGER');
    this.addColumnIfMissing('jobs', 'webhook_url', 'TEXT');
    this.addColumnIfMissing('jobs', 'delivery_status', 'TEXT');
    this.addColumnIfMissing('jobs', 'delivery_error', 'TEXT');
    this.addColumnIfMissing('jobs', 'delivered_at', 'TEXT');

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_extractions_session_created ON extractions(session_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_extractions_session_hash ON extractions(session_id, file_hash);
      CREATE INDEX IF NOT EXISTS idx_extractions_document_type_expiry ON extractions(document_type, is_expired);
      CREATE INDEX IF NOT EXISTS idx_extractions_session_days_until_expiry ON extractions(session_id, days_until_expiry);
      CREATE INDEX IF NOT EXISTS idx_jobs_status_queued ON jobs(status, queued_at);
      CREATE INDEX IF NOT EXISTS idx_validations_session_created ON validations(session_id, created_at DESC);
    `);
  }

  private addColumnIfMissing(tableName: string, columnName: string, definition: string): void {
    const columns = this.all<{ name: string }>(`PRAGMA table_info(${tableName})`);
    if (!columns.some((column) => column.name === columnName)) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  }

  run(sql: string, ...params: SqlValue[]): void {
    this.db.prepare(sql).run(...params);
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  ensureSession(id: string): void {
    const existing = this.get<{ id: string }>('SELECT id FROM sessions WHERE id = ?', id);
    if (!existing) {
      this.run('INSERT INTO sessions (id, created_at) VALUES (?, ?)', id, nowIso());
    }
  }

  sessionExists(id: string): boolean {
    return Boolean(this.get<{ id: string }>('SELECT id FROM sessions WHERE id = ?', id));
  }

  insertExtraction(record: {
    id: string;
    sessionId: string;
    fileName: string;
    mimeType: string;
    fileHash: string;
    storedFilePath: string | null;
    promptVersion: string;
    status: 'COMPLETE' | 'FAILED';
    rawLlmResponse: string | null;
    processingTimeMs: number | null;
    documentType?: string | null;
    documentName?: string | null;
    category?: string | null;
    applicableRole?: string | null;
    confidence?: string | null;
    holderName?: string | null;
    dateOfBirth?: string | null;
    sirbNumber?: string | null;
    passportNumber?: string | null;
    dateOfIssue?: string | null;
    dateOfExpiry?: string | null;
    daysUntilExpiry?: number | null;
    revalidationRequired?: boolean | null;
    fields?: unknown;
    validity?: unknown;
    compliance?: unknown;
    medicalData?: unknown;
    flags?: unknown;
    isExpired?: boolean;
    summary?: string | null;
  }): void {
    this.run(
      `INSERT INTO extractions (
        id, session_id, file_name, mime_type, file_hash, stored_file_path, document_type, document_name, category,
        applicable_role, confidence, holder_name, date_of_birth, sirb_number, passport_number,
        date_of_issue, date_of_expiry, days_until_expiry, revalidation_required,
        fields_json, validity_json, compliance_json, medical_data_json, flags_json, is_expired,
        summary, raw_llm_response, prompt_version, processing_time_ms, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
      record.id,
      record.sessionId,
      record.fileName,
      record.mimeType,
      record.fileHash,
      record.storedFilePath,
      record.documentType ?? null,
      record.documentName ?? null,
      record.category ?? null,
      record.applicableRole ?? null,
      record.confidence ?? null,
      record.holderName ?? null,
      record.dateOfBirth ?? null,
      record.sirbNumber ?? null,
      record.passportNumber ?? null,
      record.dateOfIssue ?? null,
      record.dateOfExpiry ?? null,
      record.daysUntilExpiry ?? null,
      record.revalidationRequired === null || record.revalidationRequired === undefined ? null : (record.revalidationRequired ? 1 : 0),
      JSON.stringify(record.fields ?? []),
      record.validity ? JSON.stringify(record.validity) : null,
      record.compliance ? JSON.stringify(record.compliance) : null,
      record.medicalData ? JSON.stringify(record.medicalData) : null,
      JSON.stringify(record.flags ?? []),
      record.isExpired ? 1 : 0,
      record.summary ?? null,
      record.rawLlmResponse,
      record.promptVersion,
      record.processingTimeMs ?? null,
      record.status,
      nowIso()
    );
  }

  updateExtraction(record: {
    id: string;
    status: 'COMPLETE' | 'FAILED';
    rawLlmResponse: string | null;
    processingTimeMs: number | null;
    documentType?: string | null;
    documentName?: string | null;
    category?: string | null;
    applicableRole?: string | null;
    confidence?: string | null;
    holderName?: string | null;
    dateOfBirth?: string | null;
    sirbNumber?: string | null;
    passportNumber?: string | null;
    dateOfIssue?: string | null;
    dateOfExpiry?: string | null;
    daysUntilExpiry?: number | null;
    revalidationRequired?: boolean | null;
    fields?: unknown;
    validity?: unknown;
    compliance?: unknown;
    medicalData?: unknown;
    flags?: unknown;
    isExpired?: boolean;
    summary?: string | null;
  }): void {
    this.run(
      `UPDATE extractions SET
        document_type = ?, document_name = ?, category = ?, applicable_role = ?, confidence = ?,
        holder_name = ?, date_of_birth = ?, sirb_number = ?, passport_number = ?,
        date_of_issue = ?, date_of_expiry = ?, days_until_expiry = ?, revalidation_required = ?,
        fields_json = ?, validity_json = ?, compliance_json = ?, medical_data_json = ?, flags_json = ?, is_expired = ?,
        summary = ?, raw_llm_response = ?, processing_time_ms = ?, status = ?
      WHERE id = ?`,
      record.documentType ?? null,
      record.documentName ?? null,
      record.category ?? null,
      record.applicableRole ?? null,
      record.confidence ?? null,
      record.holderName ?? null,
      record.dateOfBirth ?? null,
      record.sirbNumber ?? null,
      record.passportNumber ?? null,
      record.dateOfIssue ?? null,
      record.dateOfExpiry ?? null,
      record.daysUntilExpiry ?? null,
      record.revalidationRequired === null || record.revalidationRequired === undefined ? null : (record.revalidationRequired ? 1 : 0),
      JSON.stringify(record.fields ?? []),
      record.validity ? JSON.stringify(record.validity) : null,
      record.compliance ? JSON.stringify(record.compliance) : null,
      record.medicalData ? JSON.stringify(record.medicalData) : null,
      JSON.stringify(record.flags ?? []),
      record.isExpired ? 1 : 0,
      record.summary ?? null,
      record.rawLlmResponse,
      record.processingTimeMs ?? null,
      record.status,
      record.id
    );
  }

  getExtractionBySessionHash(sessionId: string, fileHash: string): ExtractionRecord | undefined {
    const row = this.get<Record<string, unknown>>('SELECT * FROM extractions WHERE session_id = ? AND file_hash = ?', sessionId, fileHash);
    return row ? this.mapExtraction(row) : undefined;
  }

  getExtractionById(id: string): ExtractionRecord | undefined {
    const row = this.get<Record<string, unknown>>('SELECT * FROM extractions WHERE id = ?', id);
    return row ? this.mapExtraction(row) : undefined;
  }

  listExtractionsBySession(sessionId: string): ExtractionRecord[] {
    return this.all<Record<string, unknown>>('SELECT * FROM extractions WHERE session_id = ? ORDER BY created_at ASC', sessionId).map((row) => this.mapExtraction(row));
  }

  listExpiringExtractions(sessionId: string, withinDays: number): ExtractionRecord[] {
    return this.all<Record<string, unknown>>(
      `SELECT * FROM extractions
       WHERE session_id = ?
         AND status = ?
         AND days_until_expiry IS NOT NULL
         AND days_until_expiry <= ?
       ORDER BY CASE WHEN days_until_expiry < 0 THEN 0 ELSE 1 END, days_until_expiry ASC`,
      sessionId,
      'COMPLETE',
      withinDays
    ).map((row) => this.mapExtraction(row));
  }

  insertJob(job: { id: string; sessionId: string; extractionId: string; webhookUrl: string | null }): void {
    this.run(
      'INSERT INTO jobs (id, session_id, extraction_id, webhook_url, status, retryable, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      job.id,
      job.sessionId,
      job.extractionId,
      job.webhookUrl,
      'QUEUED',
      0,
      nowIso()
    );
  }

  claimNextQueuedJob(): { id: string; session_id: string; extraction_id: string; queued_at: string; webhook_url: string | null } | undefined {
    const queued = this.get<{ id: string; session_id: string; extraction_id: string; queued_at: string; webhook_url: string | null }>(
      'SELECT id, session_id, extraction_id, queued_at, webhook_url FROM jobs WHERE status = ? ORDER BY queued_at ASC LIMIT 1',
      'QUEUED'
    );
    if (!queued) {
      return undefined;
    }

    this.run('UPDATE jobs SET status = ?, started_at = ? WHERE id = ? AND status = ?', 'PROCESSING', nowIso(), queued.id, 'QUEUED');
    const claimed = this.get<{ status: string }>('SELECT status FROM jobs WHERE id = ?', queued.id);
    return claimed?.status === 'PROCESSING' ? queued : undefined;
  }

  completeJob(id: string): void {
    this.run('UPDATE jobs SET status = ?, completed_at = ?, retryable = 0 WHERE id = ?', 'COMPLETE', nowIso(), id);
  }

  failJob(id: string, errorCode: string, errorMessage: string, retryable: boolean): void {
    this.run(
      'UPDATE jobs SET status = ?, error_code = ?, error_message = ?, retryable = ?, completed_at = ? WHERE id = ?',
      'FAILED',
      errorCode,
      errorMessage,
      retryable ? 1 : 0,
      nowIso(),
      id
    );
  }

  recordWebhookDelivery(jobId: string, status: 'DELIVERED' | 'FAILED', errorMessage: string | null): void {
    this.run(
      'UPDATE jobs SET delivery_status = ?, delivery_error = ?, delivered_at = ? WHERE id = ?',
      status,
      errorMessage,
      status === 'DELIVERED' ? nowIso() : null,
      jobId
    );
  }

  requeueFailedJob(previousJobId: string, newJobId: string): { id: string; sessionId: string; extractionId: string; webhookUrl: string | null } | undefined {
    const failedJob = this.get<{ id: string; session_id: string; extraction_id: string; status: string; webhook_url: string | null }>(
      'SELECT id, session_id, extraction_id, status, webhook_url FROM jobs WHERE id = ?',
      previousJobId
    );
    if (!failedJob || failedJob.status !== 'FAILED') {
      return undefined;
    }

    this.run(
      'INSERT INTO jobs (id, session_id, extraction_id, webhook_url, status, retryable, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      newJobId,
      failedJob.session_id,
      failedJob.extraction_id,
      failedJob.webhook_url,
      'QUEUED',
      0,
      nowIso()
    );

    return {
      id: newJobId,
      sessionId: failedJob.session_id,
      extractionId: failedJob.extraction_id,
      webhookUrl: failedJob.webhook_url
    };
  }

  getJob(id: string): Record<string, unknown> | undefined {
    return this.get<Record<string, unknown>>('SELECT * FROM jobs WHERE id = ?', id);
  }

  getQueuePosition(jobId: string): number {
    const job = this.get<{ queued_at: string }>('SELECT queued_at FROM jobs WHERE id = ?', jobId);
    if (!job) {
      return 0;
    }

    const row = this.get<{ count: number }>('SELECT COUNT(*) AS count FROM jobs WHERE status = ? AND queued_at <= ?', 'QUEUED', job.queued_at);
    return row?.count ?? 0;
  }

  listPendingJobsForSession(sessionId: string): Array<{ id: string; status: string }> {
    return this.all<{ id: string; status: string }>(
      'SELECT id, status FROM jobs WHERE session_id = ? AND status IN (?, ?) ORDER BY queued_at ASC',
      sessionId,
      'QUEUED',
      'PROCESSING'
    );
  }

  insertValidation(id: string, sessionId: string, result: ValidationResult): void {
    this.run('INSERT INTO validations (id, session_id, result_json, created_at) VALUES (?, ?, ?, ?)', id, sessionId, JSON.stringify(result), nowIso());
  }

  getLatestValidation(sessionId: string): ValidationResult | undefined {
    const row = this.get<{ result_json: string }>('SELECT result_json FROM validations WHERE session_id = ? ORDER BY created_at DESC LIMIT 1', sessionId);
    return row ? JSON.parse(row.result_json) as ValidationResult : undefined;
  }

  ping(): boolean {
    const row = this.get<{ ok: number }>('SELECT 1 AS ok');
    return row?.ok === 1;
  }

  private mapExtraction(row: Record<string, unknown>): ExtractionRecord {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      fileName: String(row.file_name),
      mimeType: String(row.mime_type),
      fileHash: String(row.file_hash),
      storedFilePath: row.stored_file_path ? String(row.stored_file_path) : null,
      documentType: row.document_type ? String(row.document_type) : null,
      documentName: row.document_name ? String(row.document_name) : null,
      applicableRole: row.applicable_role ? String(row.applicable_role) as ExtractionRecord['applicableRole'] : null,
      category: row.category ? String(row.category) : null,
      confidence: row.confidence ? String(row.confidence) as ExtractionRecord['confidence'] : null,
      holderName: row.holder_name ? String(row.holder_name) : null,
      dateOfBirth: row.date_of_birth ? String(row.date_of_birth) : null,
      sirbNumber: row.sirb_number ? String(row.sirb_number) : null,
      passportNumber: row.passport_number ? String(row.passport_number) : null,
      fields: JSON.parse(String(row.fields_json)),
      validity: row.validity_json ? JSON.parse(String(row.validity_json)) : null,
      compliance: row.compliance_json ? JSON.parse(String(row.compliance_json)) : null,
      medicalData: row.medical_data_json ? JSON.parse(String(row.medical_data_json)) : null,
      flags: JSON.parse(String(row.flags_json)),
      isExpired: Number(row.is_expired) === 1,
      summary: row.summary ? String(row.summary) : null,
      rawLlmResponse: row.raw_llm_response ? String(row.raw_llm_response) : null,
      promptVersion: String(row.prompt_version),
      processingTimeMs: row.processing_time_ms === null ? null : Number(row.processing_time_ms),
      status: String(row.status) as ExtractionRecord['status'],
      createdAt: String(row.created_at)
    };
  }
}
