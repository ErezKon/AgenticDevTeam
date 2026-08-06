# LLM Cassettes

This directory stores recorded LLM traffic for deterministic, offline pipeline tests.

## Format

Each cassette is a `.jsonl` file (one JSON object per line). Fields:

| Field     | Description                                      |
|-----------|--------------------------------------------------|
| `key`     | SHA-256 of `{url, method, body}` (volatile fields stripped) |
| `seq`     | Per-key sequence number (for repeated identical requests)  |
| `status`  | HTTP status code from the original response       |
| `headers` | Response headers (Authorization and sensitive keys redacted) |
| `body`    | Response body (sensitive fields redacted)          |

## Recording a cassette

```bash
npm run record:cassette
# or manually:
LLM_CASSETTE_MODE=record CASSETTE_NAME=my-test GITHUB_MODE=local npm run cli
```

## Replaying a cassette

```bash
LLM_CASSETTE_MODE=replay CASSETTE_NAME=my-test npm run test:replay
```

## Security

Cassettes are **redacted on write**: `Authorization` headers and any field matching
`/token|secret|key|password|credential|auth/i` are stripped or replaced with
`***REDACTED***` before the line is written to disk. Cassettes are safe to commit.

## Size warning

The system warns when a cassette file exceeds `CASSETTE_MAX_MB` (default: 25 MB).
For large cassettes, consider compressing to `.jsonl.gz` — the loader handles both formats.
