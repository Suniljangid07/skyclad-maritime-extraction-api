# ADR

## Question 1 - Sync vs Async

Async should be the production default. LLM-backed document extraction has variable latency, provider-side slowdown risk, and much better operational characteristics when requests are decoupled from the extraction lifecycle. Defaulting to async gives us cleaner retries, safer backpressure, and more predictable UX under load. I kept sync because it is useful for demos and very small files, but in production it should be the exception rather than the norm.

I would force async regardless of the query param once either of these conditions is true: the file is larger than roughly 2MB, or the system already has more than 5 jobs queued or processing. Large PDFs and heavier concurrent traffic are exactly where the cost of blocking HTTP requests stops being worth it.

## Question 2 - Queue Choice

I used a SQLite-backed jobs table with an in-process polling worker. I chose it because the assignment allows SQLite, and this approach gives a durable visible job state machine without introducing external infrastructure into an empty repository. The key change I made after the initial pass was to store uploaded files durably on disk and persist their paths in the database, so queued jobs survive process restarts instead of depending on in-memory buffers.

If this service needed to handle 500 concurrent extractions per minute, I would migrate to a real distributed queue, most likely BullMQ on Redis or pg-boss on PostgreSQL. My preference would be BullMQ when Redis already exists in the platform because it gives better worker scaling, retry controls, delayed jobs, and operational tooling.

The current failure modes are straightforward. Local disk storage is durable on one machine but not sufficient for multi-instance deployments, so the next step would be object storage plus worker fetch by URI. The in-process worker is also a single-process bottleneck. Horizontal scaling would require a distributed queue or at least a shared storage and lease strategy.

## Question 3 - LLM Provider Abstraction

I built a provider interface rather than coding directly against one vendor. That decision was worth it here because provider switching is a hard requirement, and the service should not require route-level rewrites just to test Anthropic versus Gemini versus OpenAI-compatible providers.

The interface is intentionally small:

- `analyzeDocument(request)` accepts the extraction prompt plus file metadata and base64 content and returns raw model text.
- `repairJson(rawResponse, originalPrompt)` performs the parse-repair pass.
- `validateSession(prompt)` runs the cross-document compliance prompt.
- `healthCheck()` verifies that the provider is configured well enough for dependency health reporting.

That keeps vendor-specific payload shaping in one place while the extraction pipeline stays provider-agnostic.

I also versioned the extraction prompt with `EXTRACTION_PROMPT_VERSION` and persisted that value on each extraction record. That matters because prompt changes are effectively behavior changes. In production, prompt versioning helps with reproducibility, debugging regressions, comparing extraction quality over time, and running controlled A/B tests across prompt variants. Without prompt versioning, it becomes much harder to answer simple operational questions like why two extractions for the same document looked different a month apart.

## Question 4 - Schema Design

Storing dynamic fields as JSON text is flexible, but at scale it becomes a liability. The main risks are poor queryability, weak constraints, ambiguous field naming, and expensive reporting logic. Once too much business logic depends on JSON blobs, the database stops helping us enforce data quality and starts acting like a passive object store.

To reduce that risk, I kept long-tail fields in JSON but promoted operationally important attributes into first-class columns: `document_type`, `is_expired`, `date_of_expiry`, `days_until_expiry`, and related identifiers. That makes queries like "all sessions where any document has an expired COC" or "documents expiring within 90 days" cheap and indexable. If we needed full-text search across extracted field values, I would add a relational child table such as `extraction_fields(extraction_id, key, label, value, importance, status)` plus a full-text search index over `value` and `label`.

## Question 5 - What You Skipped

I deliberately skipped authentication and authorization. Real maritime document handling includes sensitive identity and medical data, so tenant isolation, access control, and audit logging are mandatory. It was deprioritized because the assignment focused on extraction architecture rather than identity.

I also skipped cloud object storage. The current implementation stores uploads durably on the local filesystem, which is enough to satisfy restart safety for a single-node service but not enough for a multi-instance production deployment. I would replace this with S3-compatible storage and signed access paths.

I skipped observability beyond the health endpoint. A production version would need structured logs, metrics, tracing, alerting on queue lag, provider failures, parse-repair rates, and webhook delivery outcomes.

I also did not upgrade Multer from 1.x to 2.x in this submission even though the package now carries a deprecation warning. I kept it because the current code is already integrated, tested, and working for the take-home, but in a production follow-up I would either upgrade to Multer 2.x or replace it with a maintained upload path so the service is not built on a deprecated multipart dependency.
