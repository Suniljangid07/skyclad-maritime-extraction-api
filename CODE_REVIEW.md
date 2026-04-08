# Code Review

## Summary

Thanks for pushing this through. You got the basic happy path working end-to-end, which is a good start, but I would not merge this PR in its current form because it introduces several production-critical risks around security, reliability, privacy, and operability. The biggest issues are the hardcoded API key, in-memory persistence, lack of timeout and retry handling around the LLM call, and the fact that we permanently copy PII-heavy files to disk without any retention policy or access controls.

The good news is that the shape is salvageable. You already proved the model can extract useful data from a maritime document. The next step is to wrap that capability in the controls we need for a real backend service.

## Findings

1. `src/routes/extract.ts:7`
Hardcoding `apiKey: 'sk-ant-REDACTED'` in source is a release blocker. Secrets cannot live in committed code, even temporarily, because they leak through git history, screenshots, logs, and local copies. This needs to move to environment-based config immediately.

2. `src/routes/extract.ts:7-8, 28`
The provider and model choice are both hardcoded to Anthropic plus `claude-opus-4-6`. That conflicts with the service requirement to switch providers through environment variables only, and it also defaults us to the most expensive class of model for a high-volume extraction endpoint. We need a provider boundary here, not a direct SDK dependency in the route.

3. `src/routes/extract.ts:10`
`req.file` is used without any visible upload middleware validation. I don’t see file size checks, MIME allowlisting, or protection against unsupported uploads. That means a large or invalid file could reach the route and fail unpredictably.

4. `src/routes/extract.ts:18-19`
Copying the uploaded file to `./uploads` permanently is risky for two reasons: it stores sensitive identity and medical documents on local disk, and it uses the original filename directly. That creates PII retention concerns and possible filename collisions. If we retain originals at all, they should go to controlled storage with generated IDs, access policy, and retention rules.

5. `src/routes/extract.ts:20-37`
The LLM call has no timeout, no retry behavior, and no handling for malformed JSON. For this kind of pipeline, those are not edge cases; they are normal operating conditions. Right now a slow or slightly messy model response can hang or crash the request path.

6. `src/routes/extract.ts:39`
`JSON.parse(response.content[0].text)` assumes the first content block is plain text containing perfect JSON. That is brittle. Vision models often wrap JSON in code fences or add explanatory text. We should strip to the outermost JSON object first and repair once if parsing still fails.

7. `src/routes/extract.ts:42-44`
Writing results into `global.extractions` means the data disappears on restart, is shared unsafely across requests, and does not support session-level querying or deduplication. This is fine for a five-minute spike, but not acceptable for a backend service that users depend on.

8. `src/routes/extract.ts:47-48`
The error handling logs the raw error and returns a generic 500. That makes debugging harder for clients and operators. We need structured error responses with stable error codes, and we should be careful not to leak raw provider details or document contents into logs.

9. `src/routes/extract.ts:20-37`
The prompt is too broad: "Extract all information from this maritime document and return as JSON." For a domain like maritime compliance, that will produce inconsistent shapes between document types. We need a stronger prompt contract with taxonomy, required keys, and compliance flags so downstream validation can trust the output schema.

## Teaching moment

The biggest mindset shift here is that "the model returned the right answer once" is only the starting point, not the finish line. LLM integrations fail in messy, repetitive ways: malformed JSON, slow responses, partial data, low-confidence guesses, and vendor outages. When we productionize an LLM workflow, most of the engineering is not the API call itself. It is the guardrails around the API call so the system behaves predictably even when the model does not.

## Suggested next changes

- Move credentials, model, and provider selection into environment config.
- Add upload validation for type and size before the route runs.
- Persist sessions, extractions, and job state in a database instead of global memory.
- Add timeout, JSON boundary extraction, parse-repair retry, and raw-response storage.
- Replace permanent local-disk copies with an intentional storage strategy.
- Narrow the prompt so downstream code receives a consistent schema.
