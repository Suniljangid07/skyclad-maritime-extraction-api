import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EXTRACTION_PROMPT, EXTRACTION_PROMPT_VERSION, VALIDATION_PROMPT } from '../constants.js';
import { config } from '../config.js';
import { Database } from '../db.js';
import type { LlmProvider } from '../llm/provider.js';
import type { ExtractionCompliance, ExtractionMedicalData, ExtractionPayload, ExtractionRecord, ExtractionValidity, ValidationResult } from '../types.js';
import { AppError, daysBetween, ensureJsonObject, generateId, nowIso, parseDdMmYyyy, serializeError, sha256 } from '../utils.js';

export interface UploadInput {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  sessionId?: string;
  webhookUrl?: string;
}

export class ExtractionService {
  constructor(private readonly db: Database, private readonly llmProvider: LlmProvider) {
    fs.mkdirSync(config.storageRoot, { recursive: true });
  }

  async createSyncExtraction(input: UploadInput): Promise<{ sessionId: string; result: ExtractionRecord; deduplicated: boolean }> {
    const sessionId = input.sessionId ?? generateId();
    this.db.ensureSession(sessionId);
    const fileHash = sha256(input.buffer);
    const existing = this.db.getExtractionBySessionHash(sessionId, fileHash);
    if (existing) {
      return { sessionId, result: existing, deduplicated: true };
    }

    const extractionId = generateId();
    const storedFilePath = this.persistUploadedFile(sessionId, extractionId, input.fileName, input.buffer);
    this.db.insertExtraction({
      id: extractionId,
      sessionId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      fileHash,
      storedFilePath,
      promptVersion: EXTRACTION_PROMPT_VERSION,
      rawLlmResponse: null,
      processingTimeMs: null,
      status: 'FAILED',
      fields: [],
      flags: []
    });

    const result = await this.processExtractionRecord({
      extractionId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      buffer: input.buffer
    });

    return { sessionId, result, deduplicated: false };
  }

  async createAsyncExtraction(input: UploadInput): Promise<{ sessionId: string; jobId: string; deduplicatedResult?: ExtractionRecord }> {
    const sessionId = input.sessionId ?? generateId();
    this.db.ensureSession(sessionId);
    const fileHash = sha256(input.buffer);
    const existing = this.db.getExtractionBySessionHash(sessionId, fileHash);
    if (existing) {
      return { sessionId, jobId: generateId(), deduplicatedResult: existing };
    }

    const extractionId = generateId();
    const jobId = generateId();
    const storedFilePath = this.persistUploadedFile(sessionId, extractionId, input.fileName, input.buffer);
    this.db.insertExtraction({
      id: extractionId,
      sessionId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      fileHash,
      storedFilePath,
      promptVersion: EXTRACTION_PROMPT_VERSION,
      rawLlmResponse: null,
      processingTimeMs: null,
      status: 'FAILED',
      fields: [],
      flags: []
    });
    this.db.insertJob({ id: jobId, sessionId, extractionId, webhookUrl: input.webhookUrl ?? null });
    return { sessionId, jobId };
  }

  async processQueuedJob(job: { id: string; extraction_id: string; webhook_url: string | null }): Promise<void> {
    const extraction = this.db.getExtractionById(job.extraction_id);
    if (!extraction) {
      this.db.failJob(job.id, 'INTERNAL_ERROR', 'Extraction record missing for job', false);
      return;
    }

    if (!extraction.storedFilePath || !fs.existsSync(extraction.storedFilePath)) {
      this.db.failJob(job.id, 'INTERNAL_ERROR', 'Queued file payload is missing from durable storage', false);
      this.db.updateExtraction({
        id: extraction.id,
        status: 'FAILED',
        rawLlmResponse: 'Queued file payload is missing from durable storage',
        processingTimeMs: null,
        fields: [],
        flags: [{ severity: 'CRITICAL', message: 'Worker could not load queued file payload from durable storage.' }]
      });
      await this.deliverWebhook(job, {
        jobId: job.id,
        status: 'FAILED',
        error: 'INTERNAL_ERROR',
        message: 'Queued file payload is missing from durable storage'
      });
      return;
    }

    try {
      const buffer = fs.readFileSync(extraction.storedFilePath);
      await this.processExtractionRecord({
        extractionId: extraction.id,
        fileName: extraction.fileName,
        mimeType: extraction.mimeType,
        buffer
      });
      this.db.completeJob(job.id);
      await this.deliverWebhook(job, {
        jobId: job.id,
        status: 'COMPLETE',
        extractionId: extraction.id,
        result: this.toExtractionResponse(this.db.getExtractionById(extraction.id) ?? extraction),
        completedAt: nowIso()
      });
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError(500, 'INTERNAL_ERROR', serializeError(error));
      this.db.failJob(job.id, appError.code, appError.message, appError.code === 'INTERNAL_ERROR');
      await this.deliverWebhook(job, {
        jobId: job.id,
        status: 'FAILED',
        error: appError.code,
        message: appError.message,
        failedAt: nowIso(),
        retryable: appError.code === 'INTERNAL_ERROR'
      });
    }
  }

  async retryJob(jobId: string): Promise<{ jobId: string; sessionId: string; status: 'QUEUED'; pollUrl: string; estimatedWaitMs: number }> {
    const newJobId = generateId();
    const requeued = this.db.requeueFailedJob(jobId, newJobId);
    if (!requeued) {
      throw new AppError(409, 'JOB_NOT_RETRYABLE', 'Only FAILED jobs can be retried');
    }

    return {
      jobId: requeued.id,
      sessionId: requeued.sessionId,
      status: 'QUEUED',
      pollUrl: `/api/jobs/${requeued.id}`,
      estimatedWaitMs: 6000
    };
  }

  async validateSession(sessionId: string): Promise<ValidationResult> {
    if (!this.db.sessionExists(sessionId)) {
      throw new AppError(404, 'SESSION_NOT_FOUND', 'Session ID does not exist');
    }

    const extractions = this.db.listExtractionsBySession(sessionId).filter((item) => item.status === 'COMPLETE');
    if (extractions.length < 2) {
      throw new AppError(400, 'INSUFFICIENT_DOCUMENTS', 'Validation requires at least two extraction records');
    }

    const prompt = `${VALIDATION_PROMPT}\n\nExtraction records:\n${JSON.stringify(extractions.map((item) => this.toExtractionResponse(item)), null, 2)}`;
    const raw = await this.withProviderTimeout(() => this.llmProvider.validateSession(prompt));
    const parsed = await this.parseWithRepair<Record<string, unknown>>(raw.rawText, prompt);

    const result: ValidationResult = {
      sessionId,
      holderProfile: (parsed.holderProfile as Record<string, unknown>) ?? {},
      consistencyChecks: Array.isArray(parsed.consistencyChecks) ? parsed.consistencyChecks as Array<Record<string, unknown>> : [],
      missingDocuments: Array.isArray(parsed.missingDocuments) ? parsed.missingDocuments as Array<Record<string, unknown>> : [],
      expiringDocuments: Array.isArray(parsed.expiringDocuments) ? parsed.expiringDocuments as Array<Record<string, unknown>> : [],
      medicalFlags: Array.isArray(parsed.medicalFlags) ? parsed.medicalFlags as Array<Record<string, unknown>> : [],
      overallStatus: (parsed.overallStatus as ValidationResult['overallStatus']) ?? 'CONDITIONAL',
      overallScore: typeof parsed.overallScore === 'number' ? parsed.overallScore : 0,
      summary: typeof parsed.summary === 'string' ? parsed.summary : 'Validation completed.',
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.map((item: unknown) => String(item)) : [],
      validatedAt: nowIso()
    };

    this.db.insertValidation(generateId(), sessionId, result);
    return result;
  }

  getSessionSummary(sessionId: string): Record<string, unknown> {
    if (!this.db.sessionExists(sessionId)) {
      throw new AppError(404, 'SESSION_NOT_FOUND', 'Session ID does not exist');
    }

    const documents = this.db.listExtractionsBySession(sessionId);
    const pendingJobs = this.db.listPendingJobsForSession(sessionId);
    const detectedRole = this.detectSessionRole(documents);
    const overallHealth = this.deriveOverallHealth(documents);

    return {
      sessionId,
      documentCount: documents.length,
      detectedRole,
      overallHealth,
      documents: documents.map((item) => ({
        id: item.id,
        fileName: item.fileName,
        documentType: item.documentType,
        applicableRole: item.applicableRole,
        holderName: item.holderName,
        confidence: item.confidence,
        isExpired: item.isExpired,
        flagCount: item.flags.length,
        criticalFlagCount: item.flags.filter((flag) => flag.severity === 'CRITICAL').length,
        createdAt: item.createdAt
      })),
      pendingJobs
    };
  }

  getExpiringDocuments(sessionId: string, withinDays: number): Record<string, unknown> {
    if (!this.db.sessionExists(sessionId)) {
      throw new AppError(404, 'SESSION_NOT_FOUND', 'Session ID does not exist');
    }

    const documents = this.db.listExpiringExtractions(sessionId, withinDays);
    return {
      sessionId,
      withinDays,
      documentCount: documents.length,
      documents: documents.map((item) => ({
        extractionId: item.id,
        fileName: item.fileName,
        documentType: item.documentType,
        documentName: item.documentName,
        expiryDate: item.validity?.dateOfExpiry ?? null,
        daysUntilExpiry: item.validity?.daysUntilExpiry ?? null,
        isExpired: item.isExpired,
        urgency: this.expiryUrgency(item.validity?.daysUntilExpiry ?? null, item.isExpired)
      }))
    };
  }

  getReport(sessionId: string): Record<string, unknown> {
    if (!this.db.sessionExists(sessionId)) {
      throw new AppError(404, 'SESSION_NOT_FOUND', 'Session ID does not exist');
    }

    const documents = this.db.listExtractionsBySession(sessionId);
    const validation = this.db.getLatestValidation(sessionId);
    const expiredDocuments = documents.filter((item) => item.isExpired);
    const expiringSoon = this.db.listExpiringExtractions(sessionId, 90).filter((item) => !item.isExpired);

    return {
      sessionId,
      generatedAt: nowIso(),
      decision: validation?.overallStatus ?? 'PENDING_VALIDATION',
      overallScore: validation?.overallScore ?? null,
      hiringRecommendation: validation?.summary ?? 'Run validation to generate a cross-document hiring recommendation.',
      person: {
        holderName: documents.find((item) => item.holderName)?.holderName ?? null,
        detectedRole: this.detectSessionRole(documents),
        passportNumber: documents.find((item) => item.passportNumber)?.passportNumber ?? null,
        sirbNumber: documents.find((item) => item.sirbNumber)?.sirbNumber ?? null
      },
      readiness: {
        documentCount: documents.length,
        expiredDocumentCount: expiredDocuments.length,
        expiringWithin90DaysCount: expiringSoon.length,
        criticalFlagCount: documents.flatMap((item) => item.flags).filter((flag) => flag.severity === 'CRITICAL').length
      },
      requiredAttention: {
        expiredDocuments: expiredDocuments.map((item) => ({
          extractionId: item.id,
          fileName: item.fileName,
          documentType: item.documentType,
          expiryDate: item.validity?.dateOfExpiry ?? null
        })),
        expiringSoon: expiringSoon.map((item) => ({
          extractionId: item.id,
          fileName: item.fileName,
          documentType: item.documentType,
          expiryDate: item.validity?.dateOfExpiry ?? null,
          daysUntilExpiry: item.validity?.daysUntilExpiry ?? null
        })),
        flags: documents.flatMap((item) => item.flags.map((flag) => ({
          extractionId: item.id,
          fileName: item.fileName,
          severity: flag.severity,
          message: flag.message
        })))
      },
      validation,
      documents: documents.map((item) => ({
        extractionId: item.id,
        fileName: item.fileName,
        documentType: item.documentType,
        documentName: item.documentName,
        category: item.category,
        role: item.applicableRole,
        confidence: item.confidence,
        status: item.status,
        issuedBy: item.compliance?.issuingAuthority ?? null,
        expiryDate: item.validity?.dateOfExpiry ?? null,
        isExpired: item.isExpired,
        summary: item.summary
      }))
    };
  }

  getJob(jobId: string): Record<string, unknown> {
    const job = this.db.getJob(jobId);
    if (!job) {
      throw new AppError(404, 'JOB_NOT_FOUND', 'Job ID does not exist');
    }

    if (job.status === 'COMPLETE') {
      const extraction = this.db.getExtractionById(String(job.extraction_id));
      return {
        jobId,
        status: 'COMPLETE',
        extractionId: job.extraction_id,
        result: extraction ? this.toExtractionResponse(extraction) : null,
        completedAt: job.completed_at
      };
    }

    if (job.status === 'FAILED') {
      return {
        jobId,
        status: 'FAILED',
        error: job.error_code,
        message: job.error_message,
        failedAt: job.completed_at,
        retryable: Number(job.retryable) === 1
      };
    }

    return {
      jobId,
      status: job.status,
      queuePosition: this.db.getQueuePosition(jobId),
      startedAt: job.started_at,
      estimatedCompleteMs: job.status === 'PROCESSING' ? 5000 : 6000
    };
  }

  toExtractionResponse(record: ExtractionRecord): Record<string, unknown> {
    const validity = this.normalizeValidity(record.validity);
    const compliance = this.normalizeCompliance(record.compliance);
    const medicalData = this.normalizeMedicalData(record.medicalData);

    return {
      id: record.id,
      sessionId: record.sessionId,
      fileName: record.fileName,
      documentType: record.documentType,
      documentName: record.documentName,
      applicableRole: record.applicableRole,
      category: record.category,
      confidence: record.confidence,
      holderName: record.holderName,
      dateOfBirth: record.dateOfBirth,
      sirbNumber: record.sirbNumber,
      passportNumber: record.passportNumber,
      fields: record.fields ?? [],
      validity,
      compliance,
      medicalData,
      flags: record.flags ?? [],
      isExpired: validity.isExpired,
      processingTimeMs: record.processingTimeMs,
      summary: record.summary,
      createdAt: record.createdAt
    };
  }

  private async processExtractionRecord(input: {
    extractionId: string;
    fileName: string;
    mimeType: string;
    buffer: Buffer;
  }): Promise<ExtractionRecord> {
    const startedAt = Date.now();
    let rawResponse: string | null = null;

    try {
      const primary = await this.withProviderTimeout(() => this.llmProvider.analyzeDocument({
        prompt: EXTRACTION_PROMPT,
        fileName: input.fileName,
        mimeType: input.mimeType,
        base64Data: input.buffer.toString('base64')
      }));

      rawResponse = primary.rawText;
      let payload = await this.parseWithRepair<ExtractionPayload>(primary.rawText, EXTRACTION_PROMPT);

      if (payload.detection.confidence === 'LOW') {
        const focusedPrompt = `${EXTRACTION_PROMPT}\n\nHint: The uploaded file name is ${input.fileName} and MIME type is ${input.mimeType}. Use those hints only if the document evidence is ambiguous.`;
        const retryResponse = await this.withProviderTimeout(() => this.llmProvider.analyzeDocument({
          prompt: focusedPrompt,
          fileName: input.fileName,
          mimeType: input.mimeType,
          base64Data: input.buffer.toString('base64')
        }));
        const retryPayload = await this.parseWithRepair<ExtractionPayload>(retryResponse.rawText, focusedPrompt);
        if (this.confidenceScore(retryPayload.detection.confidence) >= this.confidenceScore(payload.detection.confidence)) {
          payload = retryPayload;
          rawResponse = retryResponse.rawText;
        }
      }

      const validity = this.enrichValidity(payload.validity, payload.medicalData.expiryDate ?? null);
      const processingTimeMs = Date.now() - startedAt;
      this.db.updateExtraction({
        id: input.extractionId,
        documentType: payload.detection.documentType,
        documentName: payload.detection.documentName,
        category: payload.detection.category,
        applicableRole: payload.detection.applicableRole,
        confidence: payload.detection.confidence,
        holderName: payload.holder.fullName,
        dateOfBirth: payload.holder.dateOfBirth,
        sirbNumber: payload.holder.sirbNumber,
        passportNumber: payload.holder.passportNumber,
        dateOfIssue: validity.dateOfIssue,
        dateOfExpiry: typeof validity.dateOfExpiry === 'string' ? validity.dateOfExpiry : null,
        daysUntilExpiry: validity.daysUntilExpiry,
        revalidationRequired: validity.revalidationRequired,
        fields: payload.fields,
        validity,
        compliance: payload.compliance,
        medicalData: payload.medicalData,
        flags: payload.flags,
        isExpired: validity.isExpired,
        summary: payload.summary,
        rawLlmResponse: rawResponse,
        processingTimeMs,
        status: 'COMPLETE'
      });

      const stored = this.db.getExtractionById(input.extractionId);
      if (!stored) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Extraction was not persisted');
      }
      return stored;
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError(500, 'INTERNAL_ERROR', serializeError(error));
      this.db.updateExtraction({
        id: input.extractionId,
        fields: [],
        flags: [{ severity: 'HIGH', message: appError.message }],
        rawLlmResponse: rawResponse ?? serializeError(error),
        processingTimeMs: Date.now() - startedAt,
        status: 'FAILED'
      });
      throw new AppError(
        appError.code === 'LLM_JSON_PARSE_FAIL' ? 422 : appError.statusCode,
        appError.code,
        appError.message,
        { extractionId: input.extractionId }
      );
    }
  }

  private async parseWithRepair<T>(rawText: string, originalPrompt: string): Promise<T> {
    try {
      return JSON.parse(ensureJsonObject(rawText)) as T;
    } catch {
      const repaired = await this.withProviderTimeout(() => this.llmProvider.repairJson(rawText, originalPrompt));
      try {
        return JSON.parse(ensureJsonObject(repaired.rawText)) as T;
      } catch {
        throw new AppError(422, 'LLM_JSON_PARSE_FAIL', 'Document extraction failed after retry. The raw response has been stored for review.');
      }
    }
  }

  private async withProviderTimeout<T>(fn: () => Promise<T>): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new AppError(500, 'INTERNAL_ERROR', 'LLM request timed out after 30 seconds')), config.llmTimeoutMs);
    });

    try {
      return await Promise.race([fn(), timeoutPromise]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private enrichValidity(validity: ExtractionPayload['validity'], medicalExpiry: string | null): ExtractionValidity {
    const effectiveExpiry = validity.dateOfExpiry ?? medicalExpiry;
    const expiryDate = parseDdMmYyyy(effectiveExpiry);
    const today = new Date();
    const computedDays = expiryDate ? daysBetween(today, expiryDate) : validity.daysUntilExpiry;
    const isExpired = expiryDate ? expiryDate.getTime() < today.getTime() : validity.isExpired;

    return {
      ...validity,
      dateOfExpiry: effectiveExpiry,
      daysUntilExpiry: computedDays,
      isExpired
    };
  }

  private normalizeValidity(validity: ExtractionValidity | null): ExtractionValidity {
    return {
      dateOfIssue: validity?.dateOfIssue ?? null,
      dateOfExpiry: validity?.dateOfExpiry ?? null,
      isExpired: validity?.isExpired ?? false,
      daysUntilExpiry: validity?.daysUntilExpiry ?? null,
      revalidationRequired: validity?.revalidationRequired ?? null
    };
  }

  private normalizeCompliance(compliance: ExtractionCompliance | null): ExtractionCompliance {
    return {
      issuingAuthority: compliance?.issuingAuthority ?? null,
      regulationReference: compliance?.regulationReference ?? null,
      imoModelCourse: compliance?.imoModelCourse ?? null,
      recognizedAuthority: compliance?.recognizedAuthority ?? null,
      limitations: compliance?.limitations ?? null
    };
  }

  private normalizeMedicalData(medicalData: ExtractionMedicalData | null): ExtractionMedicalData {
    return {
      fitnessResult: medicalData?.fitnessResult ?? 'N/A',
      drugTestResult: medicalData?.drugTestResult ?? 'N/A',
      restrictions: medicalData?.restrictions ?? null,
      specialNotes: medicalData?.specialNotes ?? null,
      expiryDate: medicalData?.expiryDate ?? null
    };
  }

  private persistUploadedFile(sessionId: string, extractionId: string, fileName: string, buffer: Buffer): string {
    const sessionDir = path.join(config.storageRoot, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const extension = path.extname(fileName) || '.bin';
    const storedPath = path.join(sessionDir, `${extractionId}${extension.toLowerCase()}`);
    fs.writeFileSync(storedPath, buffer);
    return storedPath;
  }

  private confidenceScore(confidence: string): number {
    switch (confidence) {
      case 'HIGH':
        return 3;
      case 'MEDIUM':
        return 2;
      default:
        return 1;
    }
  }

  private detectSessionRole(documents: ExtractionRecord[]): string {
    const counts = documents.reduce<Record<string, number>>((acc, doc) => {
      if (doc.applicableRole && doc.applicableRole !== 'N/A' && doc.applicableRole !== 'BOTH') {
        acc[doc.applicableRole] = (acc[doc.applicableRole] ?? 0) + 1;
      }
      return acc;
    }, {});

    if ((counts.DECK ?? 0) === (counts.ENGINE ?? 0)) {
      return 'MIXED';
    }

    return (counts.DECK ?? 0) > (counts.ENGINE ?? 0) ? 'DECK' : 'ENGINE';
  }

  private deriveOverallHealth(documents: ExtractionRecord[]): 'OK' | 'WARN' | 'CRITICAL' {
    const hasCriticalFlag = documents.some((doc) => doc.flags.some((flag) => flag.severity === 'CRITICAL'));
    const hasExpired = documents.some((doc) => doc.isExpired);
    if (hasCriticalFlag || hasExpired) {
      return 'CRITICAL';
    }

    const hasMediumOrHighFlag = documents.some((doc) => doc.flags.some((flag) => flag.severity === 'HIGH' || flag.severity === 'MEDIUM'));
    const expiringSoon = documents.some((doc) => {
      const days = doc.validity?.daysUntilExpiry;
      return typeof days === 'number' && days >= 0 && days <= 90;
    });

    return hasMediumOrHighFlag || expiringSoon ? 'WARN' : 'OK';
  }

  private expiryUrgency(daysUntilExpiry: number | null, isExpired: boolean): 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' {
    if (isExpired || (typeof daysUntilExpiry === 'number' && daysUntilExpiry < 0)) {
      return 'CRITICAL';
    }
    if (typeof daysUntilExpiry === 'number' && daysUntilExpiry <= 30) {
      return 'HIGH';
    }
    if (typeof daysUntilExpiry === 'number' && daysUntilExpiry <= 90) {
      return 'MEDIUM';
    }
    return 'LOW';
  }

  private async deliverWebhook(job: { id: string; webhook_url: string | null }, payload: Record<string, unknown>): Promise<void> {
    if (!job.webhook_url) {
      return;
    }

    const body = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', config.webhookSecret).update(body).digest('hex');

    try {
      const response = await fetch(job.webhook_url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-skyclad-signature': signature
        },
        body
      });

      if (!response.ok) {
        throw new Error(`Webhook returned ${response.status}`);
      }

      this.db.recordWebhookDelivery(job.id, 'DELIVERED', null);
    } catch (error) {
      this.db.recordWebhookDelivery(job.id, 'FAILED', serializeError(error));
    }
  }
}
