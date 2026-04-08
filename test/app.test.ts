import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';

let createApp: typeof import('../src/app.js').createApp;

beforeEach(async () => {
  process.env.LLM_PROVIDER = 'mock';
  process.env.LLM_MODEL = 'mock-vision';
  process.env.LLM_API_KEY = 'mock-key';
  process.env.WEBHOOK_SECRET = 'test-secret';
  process.env.DATABASE_PATH = path.join(process.cwd(), 'data', `test-${Date.now()}-${Math.random()}.db`);
  process.env.STORAGE_ROOT = path.join(process.cwd(), 'data', `stored-${Date.now()}-${Math.random()}`);
  ({ createApp } = await import(`../src/app.js?ts=${Date.now()}`));
});

test('POST /api/extract sync returns assignment-shaped extraction result', async () => {
  const { app } = createApp();
  const response = await request(app)
    .post('/api/extract')
    .attach('document', Buffer.from('fake-image'), { filename: 'PEME_Samoya.png', contentType: 'image/png' });

  assert.equal(response.status, 200);
  assert.equal(response.body.documentType, 'PEME');
  assert.equal(response.body.promptVersion, undefined);
  assert.equal(typeof response.body.validity.isExpired, 'boolean');
  assert.equal(Array.isArray(response.body.fields), true);
  assert.equal(typeof response.body.compliance, 'object');
  assert.equal(typeof response.body.medicalData, 'object');
});

test('async job completes after app restart because payload is stored durably', async () => {
  const firstApp = createApp();
  const submit = await request(firstApp.app)
    .post('/api/extract?mode=async')
    .attach('document', Buffer.from('fake-image'), { filename: 'PEME_Samoya.png', contentType: 'image/png' });

  assert.equal(submit.status, 202);

  const restartedApp = createApp();
  const worker = restartedApp.makeJobWorker();
  worker.start();

  let finalResponse = await request(restartedApp.app).get(`/api/jobs/${submit.body.jobId}`);
  for (let index = 0; index < 20 && finalResponse.body.status !== 'COMPLETE'; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    finalResponse = await request(restartedApp.app).get(`/api/jobs/${submit.body.jobId}`);
  }

  worker.stop();

  assert.equal(finalResponse.status, 200);
  assert.equal(finalResponse.body.status, 'COMPLETE');
  assert.equal(finalResponse.body.result.documentType, 'PEME');
});

test('retry endpoint requeues failed jobs only', async () => {
  const { app, db, makeJobWorker } = createApp();
  const submit = await request(app)
    .post('/api/extract?mode=async')
    .attach('document', Buffer.from('fake-image'), { filename: 'PEME_Samoya.png', contentType: 'image/png' });

  const job = db.getJob(submit.body.jobId) as { extraction_id: string };
  const extraction = db.getExtractionById(String(job.extraction_id));
  assert.ok(extraction?.storedFilePath);
  fs.unlinkSync(String(extraction?.storedFilePath));

  const worker = makeJobWorker();
  worker.start();

  let failed = await request(app).get(`/api/jobs/${submit.body.jobId}`);
  for (let index = 0; index < 20 && failed.body.status !== 'FAILED'; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    failed = await request(app).get(`/api/jobs/${submit.body.jobId}`);
  }

  assert.equal(failed.body.status, 'FAILED');

  const retried = await request(app).post(`/api/jobs/${submit.body.jobId}/retry`);
  worker.stop();

  assert.equal(retried.status, 202);
  assert.equal(retried.body.status, 'QUEUED');

  const notFailed = await request(app).post(`/api/jobs/${retried.body.jobId}/retry`);
  assert.equal(notFailed.status, 409);
});

test('GET /api/sessions/:sessionId/expiring returns DB-backed expiry results', async () => {
  const { app, db } = createApp();
  const response = await request(app)
    .post('/api/extract')
    .attach('document', Buffer.from('fake-image'), { filename: 'PEME_Samoya.png', contentType: 'image/png' });

  db.run(
    'UPDATE extractions SET days_until_expiry = ?, date_of_expiry = ?, validity_json = ? WHERE id = ?',
    10,
    '10/04/2026',
    JSON.stringify({
      dateOfIssue: '06/01/2025',
      dateOfExpiry: '10/04/2026',
      isExpired: false,
      daysUntilExpiry: 10,
      revalidationRequired: false
    }),
    response.body.id
  );

  const expiring = await request(app).get(`/api/sessions/${response.body.sessionId}/expiring?withinDays=30`);

  assert.equal(expiring.status, 200);
  assert.equal(expiring.body.documentCount, 1);
  assert.equal(expiring.body.documents[0].daysUntilExpiry, 10);
});

test('POST /api/sessions/:sessionId/validate returns cross-document validation', async () => {
  const { app } = createApp();
  const first = await request(app)
    .post('/api/extract')
    .attach('document', Buffer.from('fake-image-one'), { filename: 'PEME_Samoya.png', contentType: 'image/png' });

  await request(app)
    .post('/api/extract')
    .field('sessionId', first.body.sessionId)
    .attach('document', Buffer.from('fake-image-two'), { filename: 'Passport_Samoya.png', contentType: 'image/png' });

  const validation = await request(app).post(`/api/sessions/${first.body.sessionId}/validate`);

  assert.equal(validation.status, 200);
  assert.equal(validation.body.sessionId, first.body.sessionId);
  assert.equal(validation.body.overallStatus, 'APPROVED');
});
