import express from 'express';
import multer from 'multer';
import swaggerUi from 'swagger-ui-express';
import { config } from './config.js';
import { Database } from './db.js';
import { createLlmProvider } from './llm/provider.js';
import { openApiDocument } from './openapi.js';
import { InMemoryRateLimiter } from './rate-limit.js';
import { ExtractionService } from './services/extraction-service.js';
import type { HealthResponse } from './types.js';
import { AppError, normalizeIp, nowIso } from './utils.js';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/', (_req, res) => {
    res.redirect('/docs');
  });
  app.get('/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument, {
    explorer: true,
    customSiteTitle: 'SkyClad Maritime Extraction API Docs'
  }));

  const db = new Database(config.databasePath);
  const provider = createLlmProvider();
  const rateLimiter = new InMemoryRateLimiter();
  const service = new ExtractionService(db, provider);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxFileSizeBytes },
    fileFilter: (_req, file, callback) => {
      const accepted = ['image/jpeg', 'image/png', 'application/pdf'].includes(file.mimetype);
      if (!accepted) {
        callback(new AppError(400, 'UNSUPPORTED_FORMAT', 'File type not accepted'));
        return;
      }
      callback(null, true);
    }
  });

  app.get('/api/health', async (_req, res) => {
    let llmStatus: 'OK' | 'ERROR' = 'OK';
    try {
      await provider.healthCheck();
    } catch {
      llmStatus = 'ERROR';
    }

    const databaseOk = db.ping();
    const response: HealthResponse = {
      status: llmStatus === 'OK' && databaseOk ? 'OK' : 'WARN',
      version: '1.0.0',
      uptime: Math.floor(process.uptime()),
      dependencies: {
        database: databaseOk ? 'OK' : 'ERROR',
        llmProvider: llmStatus,
        queue: 'OK'
      },
      timestamp: nowIso()
    };
    res.json(response);
  });

  app.post('/api/extract', (req, res, next) => {
    const ip = normalizeIp(req.ip);
    const limit = rateLimiter.check(ip);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
      next(new AppError(429, 'RATE_LIMITED', 'Too many requests. Please retry later.', { retryAfterMs: limit.retryAfterMs }));
      return;
    }
    next();
  }, upload.single('document'), async (req, res, next) => {
    try {
      const file = req.file;
      if (!file) {
        throw new AppError(400, 'UNSUPPORTED_FORMAT', 'A document file is required');
      }

      const sessionId = typeof req.body.sessionId === 'string' && req.body.sessionId.length > 0 ? req.body.sessionId : undefined;
      const webhookUrl = typeof req.body.webhookUrl === 'string' && req.body.webhookUrl.length > 0 ? req.body.webhookUrl : undefined;
      const mode = req.query.mode === 'async' ? 'async' : 'sync';

      if (sessionId && !db.sessionExists(sessionId)) {
        throw new AppError(404, 'SESSION_NOT_FOUND', 'Session ID does not exist');
      }

      if (mode === 'async') {
        const result = await service.createAsyncExtraction({
          buffer: file.buffer,
          fileName: file.originalname,
          mimeType: file.mimetype,
          sessionId,
          webhookUrl
        });

        if (result.deduplicatedResult) {
          res.setHeader('X-Deduplicated', 'true');
          res.status(200).json(service.toExtractionResponse(result.deduplicatedResult));
          return;
        }

        res.status(202).json({
          jobId: result.jobId,
          sessionId: result.sessionId,
          status: 'QUEUED',
          pollUrl: `/api/jobs/${result.jobId}`,
          estimatedWaitMs: 6000
        });
        return;
      }

      const result = await service.createSyncExtraction({
        buffer: file.buffer,
        fileName: file.originalname,
        mimeType: file.mimetype,
        sessionId
      });

      if (result.deduplicated) {
        res.setHeader('X-Deduplicated', 'true');
      }

      res.status(200).json(service.toExtractionResponse(result.result));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/jobs/:jobId', (req, res, next) => {
    try {
      res.json(service.getJob(req.params.jobId));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/jobs/:jobId/retry', async (req, res, next) => {
    try {
      res.status(202).json(await service.retryJob(req.params.jobId));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/sessions/:sessionId', (req, res, next) => {
    try {
      res.json(service.getSessionSummary(req.params.sessionId));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/sessions/:sessionId/expiring', (req, res, next) => {
    try {
      const rawWithinDays = typeof req.query.withinDays === 'string' ? Number(req.query.withinDays) : 90;
      const withinDays = Number.isFinite(rawWithinDays) && rawWithinDays >= 0 ? rawWithinDays : 90;
      res.json(service.getExpiringDocuments(req.params.sessionId, withinDays));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/sessions/:sessionId/validate', async (req, res, next) => {
    try {
      res.json(await service.validateSession(req.params.sessionId));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/sessions/:sessionId/report', (req, res, next) => {
    try {
      res.json(service.getReport(req.params.sessionId));
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        error: 'FILE_TOO_LARGE',
        message: 'File exceeds 10MB',
        extractionId: null,
        retryAfterMs: null
      });
      return;
    }

    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        error: error.code,
        message: error.message,
        extractionId: error.extractionId,
        retryAfterMs: error.retryAfterMs
      });
      return;
    }

    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Unexpected server error',
      extractionId: null,
      retryAfterMs: null
    });
  });

  return { app, db, service, provider, makeJobWorker: () => new JobWorker(db, service) };
}

class JobWorker {
  private interval: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly db: Database, private readonly service: ExtractionService) {}

  start(): void {
    this.interval = setInterval(async () => {
      if (this.running) {
        return;
      }

      const job = this.db.claimNextQueuedJob();
      if (!job) {
        return;
      }

      this.running = true;
      try {
        await this.service.processQueuedJob(job);
      } finally {
        this.running = false;
      }
    }, config.queuePollIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }
}
