# LangChain Upgrade Plan

> **Created:** 2026-08-16
> **Status:** COMPLETE -- dependency bump + `createAgent` migration done
> **Verified:** 65 test suites / 1049 tests passing, `tsc --noEmit` clean
> **Baseline:** 65 test suites / 1049 tests passing, `tsc --noEmit` clean

---

## 1. Problem Statement

The `@langchain/anthropic` (0.3.34) and `@langchain/google-genai` (0.2.18) packages have a **peer-dependency conflict** with the installed `@langchain/core@1.2.3`. Both old providers require `@langchain/core >=0.3.58 <0.4.0`, while everything else uses core `1.x`. This creates:

- `npm ls` showing `invalid` markers on every core resolution
- Latent runtime hazard: duplicate/mismatched core types, message-class `instanceof` breakage
- Blocked security patches and new features from upstream

Additionally, `createReactAgent` from `@langchain/langgraph/prebuilt` is marked `@deprecated` in favor of `createAgent` from the `langchain` package. The user has requested migrating to the new API as part of this upgrade.

---

## 2. Target Versions (2026-08-05 cohort, >=7 days published)

| Package | Was (package.json) | Was (installed) | Target | Bump Type |
|---|---|---|---|---|
| `langchain` | `^1.2.3` | `1.5.3` | `^1.5.5` | minor |
| `@langchain/core` | `^1.1.16` | `1.2.3` | `^1.2.5` | minor |
| `@langchain/openai` | `^1.2.0` | `1.5.5` | `^1.5.6` | minor |
| `@langchain/anthropic` | `^0.3.34` | `0.3.34` | `^1.5.4` | **MAJOR** |
| `@langchain/google-genai` | `^0.2.18` | `0.2.18` | `^2.2.0` | **MAJOR x2** |
| `@langchain/langgraph` | `^1.0.7` | `1.4.8` | `^1.4.9` | minor |
| `@langchain/mcp-adapters` | `^1.1.2` | `1.1.3` | `^1.1.3` | patch |

---

## 3. Completed Steps

### 3.1 Dependency Bump (DONE)

The `npm install` command has been run. `package.json` and `package-lock.json` are updated. `npm ls` shows a clean, single-deduped `@langchain/core@1.2.5` tree with zero `invalid` markers.

**Backup files saved at:**
- `/tmp/package.json.bak`
- `/tmp/package-lock.json.bak`

### 3.2 Anthropic topP/topK Workaround Removal (DONE)

In `src/agents/_shared/llm-provider.ts`, the following dead-code workaround has been removed:

```typescript
// REMOVED (was lines 93-97):
// ChatAnthropic 0.3.x defaults topP and topK to -1 (sentinel for "not set").
// Models not in its hardcoded list (e.g. claude-sonnet-5) send -1 to the API,
// which newer Anthropic models reject. Override via invocationKwargs so the
// API request omits these parameters (undefined is stripped by JSON.stringify).
invocationKwargs: { top_p: undefined, top_k: undefined },
```

**Reason:** In `@langchain/anthropic@1.x`, `topK` and `topP` are plain class fields initialized to `undefined` (not `-1`), so the workaround is no longer needed.

### 3.3 TypeScript Compilation Verified (DONE)

`npx tsc --noEmit` passes cleanly after the bump + workaround removal.

---

## 4. Migration Steps (DONE)

### 4.1 `agent-factory.ts`: `createReactAgent` -> `createAgent` (DONE)

```diff
-import { createReactAgent } from '@langchain/langgraph/prebuilt';
-import type { BaseMessage } from '@langchain/core/messages';
-import { RunnableLambda } from '@langchain/core/runnables';
+import { createAgent, createMiddleware } from 'langchain';
```

The `preModelHook` was replaced by a `wrapModelCall` middleware (not `beforeModel`).
`beforeModel` returns a **state update**, which would have written the compacted
messages back into the persisted graph state -- destructive. `wrapModelCall`
mutates only the outbound request, which is the exact semantic of the old
`preModelHook` returning `{ llmInputMessages }`.

```typescript
const historyCompaction = createMiddleware({
    name: 'history-compaction',
    wrapModelCall: (request, handler) => {
        const { messages, stats } = compactHistory(request.messages);
        recordCompaction(stats);
        // ... logging ...
        return handler({ ...request, messages });
    },
});

const agent = createAgent({
    model,                                  // was `llm`
    checkpointer,
    systemPrompt: prompt,                   // was `prompt`
    tools: guardedTools,
    middleware: HISTORY_COMPACTION_ENABLED ? [historyCompaction] : [],
});
```

Note: `HISTORY_COMPACTION_ENABLED` now gates the `middleware` array rather than
the middleware object, because `createMiddleware` must be called unconditionally
for type inference.

### 4.2 `llm-provider.ts`: dropped `openAIApiKey` (DONE)

Confirmed by grepping the shipped bundle: `@langchain/openai@1.5.6` no longer
reads `openAIApiKey` at runtime for `ChatOpenAI` (only `llms`, `embeddings`,
`azure/*`, and `tools/dalle` still honour the alias). The field remains in
`types.d.ts` so `tsc` stayed silent -- it was silently dead. Removed; `apiKey`
was already being set alongside it.

### 4.3 Downstream consumers (DONE -- no changes needed)

| File | Imports | Outcome |
|---|---|---|
| `src/conductor/state.ts` | `Annotation` | unchanged |
| `src/conductor/graph.ts` | `StateGraph`, `END`, `MemorySaver` | unchanged |
| `src/conductor/file-checkpointer.ts` | `MemorySaver` | unchanged |
| `tests/hitl-graph.test.ts` | `MemorySaver` | unchanged |

All call sites use `agent.invoke({ messages }, { configurable: { thread_id }, recursionLimit })`
and read `result.messages`. `createAgent` keeps both shapes, and the
`Object.assign(agent, { isCeilingReached, setInvocationId })` pattern still
works on the returned `ReactAgent` instance.

### 4.4 Runtime verification (DONE)

A throwaway Jest smoke test (`tests/tmp-createagent-smoke.test.ts`, since
deleted) drove a scripted fake model through a full tool loop and asserted:

- `wrapModelCall` fires once per model call (2 calls for a 1-tool loop)
- the model receives the **compacted** tool messages
- `result.messages` retains the **uncompacted** originals (state is not clobbered)
- `systemPrompt` arrives as a leading `SystemMessage`
- `Object.assign` extension + `.invoke()` still work

**Behavioural difference found:** `systemPrompt` now reaches the model as
content blocks (`[{ type: 'text', text: ... }]`) rather than a bare string.
Harmless for all three providers; noted here for anyone asserting on
`SystemMessage.content` (use `.text` instead).

### 4.5 Tests + docs (DONE)

`npx tsc --noEmit` clean; `npm run test:unit` -> 65 suites / 1049 tests passing
(identical to baseline). `AI_Context.md`, `README.md`, plus the stale
`preModelHook` comments in `src/config.ts` and
`src/agents/_shared/history-compactor.ts` were updated.

---

## 5. Breaking Change Analysis (Verified from Shipped Types)

### 5.1 `@langchain/anthropic` 0.3.34 -> 1.5.4

| API | Status | Notes |
|---|---|---|
| `anthropicApiKey` option | **Still supported** | Also aliased as `apiKey` |
| `clientOptions: { baseURL }` | **Still supported** | |
| `maxTokens` | **Still supported** | |
| `invocationKwargs` | **Still supported** | (but the topP/topK workaround using it is no longer needed) |
| `maxRetries` | **Still supported** | |
| `callbacks` | **Still supported** | |
| `topP` / `topK` defaults | **CHANGED** | Was `-1` (sentinel), now `undefined`. This is why the workaround was removed. |

### 5.2 `@langchain/google-genai` 0.2.18 -> 2.2.0

| API | Status | Notes |
|---|---|---|
| `model` | **Still supported** | |
| `apiKey` | **Still supported** | |
| `baseUrl` | **Still supported** | |
| `maxOutputTokens` | **Still supported** | |
| `maxRetries` | **Still supported** | |
| `callbacks` | **Still supported** | |
| Peer dep on `@langchain/core` | **Changed** | Now requires `^1.2.0` (was `>=0.3.58 <0.4.0`). This is the fix. |

### 5.3 `@langchain/openai` 1.2.0 -> 1.5.6

| API | Status | Notes |
|---|---|---|
| `apiKey` | **Still supported** | `openAIApiKey` is gone from types but `apiKey` works |
| `configuration: { baseURL, fetch }` | **Still supported** | |
| `modelKwargs` | **Still supported** | |
| `maxTokens` | **Still supported** | |
| `timeout` | **Still supported** | |
| `maxRetries` | **Still supported** | |
| `callbacks` | **Still supported** | |

**Note:** The code uses both `openAIApiKey` and `apiKey` in `llm-provider.ts` line 126-127. The `openAIApiKey` field no longer appears in the 1.5.6 types. However, since `tsc --noEmit` passes cleanly, either (a) it's still accepted at runtime via spread, or (b) it's been removed. **Verify this works at runtime** -- if not, remove the `openAIApiKey` line and keep only `apiKey`.

### 5.4 `@langchain/langgraph` 1.0.7 -> 1.4.9

| API | Status | Notes |
|---|---|---|
| `MemorySaver` | **Still exported** | |
| `StateGraph`, `END` | **Still exported** | |
| `Annotation` | **Still exported** | |
| `BaseCheckpointSaver` type | **Still exported** | |
| `createReactAgent` | **Deprecated** but still exported | Deprecation notice says to use `createAgent` from `langchain` |

### 5.5 `@langchain/core` 1.1.16 -> 1.2.5

No breaking changes detected in APIs consumed by this project:
- `tool()` from `@langchain/core/tools`
- `StructuredToolInterface` type
- `BaseCallbackHandler` from `@langchain/core/callbacks/base`
- `LLMResult` from `@langchain/core/outputs`
- `RunnableLambda` from `@langchain/core/runnables`
- Message classes: `AIMessage`, `HumanMessage`, `ToolMessage`, `SystemMessage`
- `usage_metadata` on `AIMessage`

---

## 6. `createAgent` Middleware API Reference (from shipped types)

### `createMiddleware()` -- from `langchain`

Creates a middleware instance. Key hooks:

```typescript
createMiddleware({
    name?: string,
    
    // Called once before agent starts
    beforeAgent?: (state, runtime) => stateUpdate | undefined,
    
    // Called before each model call (before wrapModelCall)
    beforeModel?: (state, runtime) => stateUpdate | undefined,
    
    // Wraps each model call -- can modify request and post-process response
    wrapModelCall?: (request: ModelRequest, handler) => AIMessage | Command,
    
    // Called after each model call
    afterModel?: (state, runtime) => stateUpdate | undefined,
    
    // Called once after agent finishes
    afterAgent?: (state, runtime) => stateUpdate | undefined,
})
```

### `ModelRequest` shape (in `wrapModelCall`)

```typescript
interface ModelRequest {
    model: AgentLanguageModelLike;
    messages: BaseMessage[];       // <-- this is what we need to compact
    systemPrompt: string;
    systemMessage: SystemMessage | undefined;
    toolChoice?: ...;
    tools: (ServerTool | ClientTool)[];
    modelSettings?: Record<string, unknown>;
}
```

### Recommended Migration

Use `wrapModelCall` because it gives direct access to `request.messages` and lets us replace them before the handler runs. This is the closest analog to the old `preModelHook` which returned `{ llmInputMessages: messages }`:

```typescript
const historyCompactionMiddleware = createMiddleware({
    name: 'history-compaction',
    wrapModelCall: async (request, handler) => {
        const { messages, stats } = compactHistory(request.messages);
        recordCompaction(stats);
        if (stats.originalChars !== stats.compactedChars) {
            factoryLog.debug(
                `${cfg.id}: history ${stats.originalChars} -> ${stats.compactedChars} chars ` +
                `(${stats.toolResultsStubbed} results, ${stats.writeArgsStubbed} write args stubbed)`,
            );
        }
        return handler({ ...request, messages });
    },
});
```

---

## 7. Files Changed

| File | Change |
|---|---|
| `package.json` | Version bumps for 7 LangChain packages |
| `package-lock.json` | Regenerated |
| `src/agents/_shared/agent-factory.ts` | `createReactAgent` -> `createAgent`; `preModelHook` -> `wrapModelCall` middleware |
| `src/agents/_shared/llm-provider.ts` | Removed dead `openAIApiKey` field |
| `src/agents/_shared/history-compactor.ts` | Doc comment: `preModelHook` -> middleware |
| `src/config.ts` | Doc comment: `preModelHook` -> middleware |
| `AI_Context.md` | Agent Framework row, factory description |
| `README.md` | Technology Stack, Agent Factory row, compaction section, tree comments, env tables |

---

## 9. Risk Assessment (post-migration)

| Risk | Status |
|---|---|
| `createAgent` return shape differs | **Resolved** -- `.invoke()` signature and `result.messages` verified identical |
| `openAIApiKey` removed from ChatOpenAI | **Resolved** -- confirmed dead at runtime, removed |
| `wrapModelCall` doesn't compact the same way | **Resolved** -- smoke test proves the model sees compacted messages while state keeps originals |
| Runtime behaviour change in Anthropic/Google providers | **Open** -- unit tests do not hit live providers. Run a real greenfield/maintain pipeline against each provider before relying on this in production. |
| `systemPrompt` now delivered as content blocks | **Low** -- no code asserts on `SystemMessage.content` |

---

## 10. Quick Resume Commands

```bash
cd /home/sio/Code/AgenticDevTeam
source ~/.nvm/nvm.sh && nvm use 22.22.0

# Check current state
npm ls langchain @langchain/core @langchain/openai @langchain/anthropic @langchain/google-genai @langchain/langgraph
npx tsc --noEmit
npm run test:unit

# If you need to revert
cp /tmp/package.json.bak package.json
cp /tmp/package-lock.json.bak package-lock.json
npm install
git checkout -- src/agents/_shared/llm-provider.ts
```
