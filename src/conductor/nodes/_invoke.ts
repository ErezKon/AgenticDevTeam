/**
 * Agent invocation — the core function that calls an LLM agent,
 * parses its JSON output, validates against a Zod schema, and
 * runs a repair loop when validation fails.
 */
import { z } from 'zod';
import { getLogger } from '../../utils/logger';
import { retryWithBackoff } from '../../utils/retry';
import {
    PIPELINE_RECURSION_LIMIT,
    ARCHITECT_MODEL, PRODUCT_MANAGER_MODEL, DBA_MODEL, TEAM_LEADER_MODEL,
    DEVOPS_MODEL, CODEBASE_ANALYZER_MODEL, QA_MODEL, LLM_MODEL,
    AGENT_OUTPUT_REPAIR_ATTEMPTS,
} from '../../config';
import { tokenTracker, type TokenCallRecord } from '../../utils/token-tracker';
import { extractTokenUsageFromMessages } from '../../utils/token-usage-extractor';
import { logAgentResponse } from '../../utils/response-log';
import { emitRunEvent } from '../../utils/event-bus';
import {
    parseAgentJson, validateAgentOutput, buildRepairMessage,
    repairFieldViolations, extractAgentText, trimTruncatedArrayTails,
    _recordValidated, _recordRepaired, _recordFailed,
} from '../../utils/structured-output';
import type { ParseResult } from '../../utils/structured-output';

// ─── Model resolution ───────────────────────────────────────────────────────

/** Resolve the configured model name for a pipeline agent. */
export function getModelForAgent(agentId: string): string {
    const modelMap: Record<string, string | undefined> = {
        'codebase-analyzer': CODEBASE_ANALYZER_MODEL ?? ARCHITECT_MODEL,
        'architect': ARCHITECT_MODEL,
        'product-manager': PRODUCT_MANAGER_MODEL,
        'dba': DBA_MODEL,
        'team-leader': TEAM_LEADER_MODEL,
        'devops': DEVOPS_MODEL,
        'qa-lead': QA_MODEL,
        'qa-unit': QA_MODEL,
        'qa-e2e': QA_MODEL,
    };
    return modelMap[agentId] ?? LLM_MODEL;
}

// ─── Agent invocation ───────────────────────────────────────────────────────

const invokeLog = getLogger('[InvokeAgent]', 183);

export async function invokeAgent<S extends z.ZodTypeAny = z.ZodAny>(
    agent: any, userMessage: string, threadSuffix: string,
    agentId: string, phase: string,
    opts?: { recursionLimit?: number; schema?: S },
): Promise<{ output: z.infer<S>; tokenUsage: TokenCallRecord | null }> {
    const recursionLimit = opts?.recursionLimit ?? PIPELINE_RECURSION_LIMIT;
    return retryWithBackoff(async () => {
        const threadId = `conductor-${threadSuffix}-${Date.now()}`;
        const model = getModelForAgent(agentId);
        const startMs = Date.now();
        emitRunEvent('agent:start', { agentId, phase, model });

        // Track this invocation for the Invocation Efficiency report
        const invocationId = tokenTracker.startInvocation(agentId, phase);
        agent.setInvocationId?.(invocationId);

        const result = await agent.invoke(
            { messages: [{ role: 'user', content: userMessage }] },
            { configurable: { thread_id: threadId }, recursionLimit },
        );

        tokenTracker.endInvocation(invocationId);
        agent.setInvocationId?.(undefined);

        // Extract per-invocation token usage from messages (complementary to callback tracking)
        const tokenUsage = extractTokenUsageFromMessages(result, agentId, model, phase);

        const emitEnd = (extra?: Record<string, unknown>) => {
            const durationMs = Date.now() - startMs;
            emitRunEvent('agent:end', {
                agentId, phase, model, durationMs,
                inputTokens: tokenUsage?.inputTokens ?? 0,
                outputTokens: tokenUsage?.outputTokens ?? 0,
                ...extra,
            });
        };

        // Normalise content: Anthropic streaming and OpenAI Responses API
        // return AIMessage.content as an array of content blocks instead of
        // a plain string.  Extract the text so JSON parsing can proceed.
        const extraction = extractAgentText(result.messages);
        const schema = opts?.schema;

        logAgentResponse({
            agentId, phase, model, threadId, invocationId,
            kind: 'invoke', userMessage, systemPrompt: agent.systemPromptText,
            durationMs: Date.now() - startMs,
        }, result);

        if (extraction.truncatedByTokenLimit) {
            invokeLog.warn(
                `Agent "${threadSuffix}" response was cut off by the output-token limit ` +
                `— raise PLANNING_MAX_OUTPUT_TOKENS/LLM_MAX_OUTPUT_TOKENS if this repeats.`,
            );
        }
        if (extraction.text === null && !schema) {
            // No schema — the caller wants whatever structured data came back
            // (e.g. tool calls), so pass the raw content through unchanged.
            const last = result.messages[result.messages.length - 1];
            invokeLog.warn(
                `Agent "${threadSuffix}" returned no text content ` +
                `(final message content: ${extraction.blockTypes}) — passing raw content through.`,
            );
            emitEnd();
            return { output: last?.content, tokenUsage };
        }
        if (extraction.text !== null && extraction.source !== 'string') {
            invokeLog.debug(
                `Extracted ${extraction.text.length} chars from ${extraction.source} ` +
                `(${extraction.blockTypes}) for "${threadSuffix}"`,
            );
        }

        // Extract JSON from the response using the shared parser
        const raw = extraction.text?.trim() ?? '';
        const parseResult: ParseResult = extraction.text === null
            ? { ok: false, error: `Response carried no text content (final message content: ${extraction.blockTypes}).` }
            : parseAgentJson(raw);

        // If JSON parsing failed and no schema is provided, throw immediately
        if (!parseResult.ok && !schema) {
            emitEnd({ error: parseResult.error });
            throw new SyntaxError(
                `Agent "${threadSuffix}" did not return valid JSON. ${parseResult.error}`
            );
        }

        // Determine initial parse + validation state
        let parsed = parseResult.ok ? parseResult.value : undefined;
        let issuesForRepair: string;

        if (extraction.text === null) {
            // Content blocks with no text at all: a reasoning-only response, or
            // an output budget consumed entirely by thinking. Returning the raw
            // blocks here is what silently produced empty phases — re-ask instead.
            invokeLog.error(
                `Agent "${threadSuffix}" returned no text content ` +
                `(final message content: ${extraction.blockTypes}) — re-asking.`,
            );
            issuesForRepair = `Your previous response contained no text output at all `
                + `(content blocks: ${extraction.blockTypes}). No JSON payload was received.`;
        } else if (!parseResult.ok) {
            // JSON parsing failed but we have a schema — route into repair loop
            invokeLog.warn(`Agent "${threadSuffix}" returned unparseable JSON — entering repair loop. ${parseResult.error}`);
            issuesForRepair = `Response was not valid JSON. ${parseResult.error}`;
        } else if (schema) {
            _recordValidated();
            const validation = validateAgentOutput(schema, parsed);
            if (validation.ok) {
                emitEnd();
                return { output: validation.value, tokenUsage };
            }
            invokeLog.warn(`Agent "${threadSuffix}" output failed schema validation:\n${validation.issues}`);

            // Attempt deterministic field-level repair before LLM repair (P1/P2)
            const fieldFix = repairFieldViolations(parsed, schema);
            if (fieldFix.repaired.length > 0) {
                invokeLog.info(`Field-level repair: fixed ${fieldFix.repaired.length} violation(s) for "${threadSuffix}": ${fieldFix.repaired.map(r => `${r.path}: ${JSON.stringify(r.from)} → ${JSON.stringify(r.to)}`).join(', ')}`);
            }
            if (fieldFix.unrepairable.length === 0) {
                // All issues fixed deterministically — validate the repaired value
                const rv = validateAgentOutput(schema, fieldFix.value);
                if (rv.ok) {
                    _recordRepaired();
                    invokeLog.info(`Agent "${threadSuffix}" repaired deterministically (${fieldFix.repaired.length} field fixes)`);
                    emitEnd({ repaired: true, fieldRepair: true });
                    return { output: rv.value, tokenUsage };
                }
            }
            // Fall through to LLM repair with remaining issues
            issuesForRepair = validation.issues;
        } else {
            // No schema, JSON parsed fine — return as-is
            emitEnd();
            return { output: parsed, tokenUsage };
        }

        // ── Truncation recovery: trim incomplete trailing array elements ──
        // When jsonrepair salvaged a truncated response, the last element(s)
        // of arrays (e.g. tasks, userStories) are often incomplete — missing
        // required fields. Rather than rejecting the entire 32K+ token output
        // or burning LLM repair attempts, trim those incomplete tails.
        if (parseResult.ok && parseResult.wasTruncated && schema && parsed !== undefined) {
            const trimResult = trimTruncatedArrayTails(parsed, schema);
            if (trimResult.ok && trimResult.trimmed.length > 0) {
                _recordRepaired();
                for (const t of trimResult.trimmed) {
                    invokeLog.info(`Truncation recovery: trimmed ${t.removedCount} incomplete element(s) from "${t.path}" for "${threadSuffix}"`);
                }
                if (extraction.truncatedByTokenLimit) {
                    invokeLog.warn(
                        `Agent "${threadSuffix}" output was truncated by token limit — `
                        + `accepted valid prefix after trimming ${trimResult.trimmed.length} array tail(s). `
                        + `Consider raising PLANNING_MAX_OUTPUT_TOKENS if this repeats.`,
                    );
                }
                emitEnd({ repaired: true, truncationRecovery: true });
                return { output: trimResult.value, tokenUsage };
            }
        }

        // ── Repair loop: fix JSON parse failures OR schema violations ─────
        // Attempt repair on a FRESH thread: avoid replaying the entire ReAct
        // history just to fix a schema violation. The repair message carries
        // the previous raw JSON so the model corrects rather than regenerates.
        for (let attempt = 0; attempt < AGENT_OUTPUT_REPAIR_ATTEMPTS; attempt++) {
            invokeLog.info(`Repair attempt ${attempt + 1}/${AGENT_OUTPUT_REPAIR_ATTEMPTS} for "${threadSuffix}"...`);
            const repairThreadId = `${threadId}-repair-${attempt}`;
            const repairMsg = buildRepairMessage(issuesForRepair, userMessage, raw);
            let repairResult: any;
            try {
                repairResult = await agent.invoke(
                    { messages: [{ role: 'user', content: repairMsg }] },
                    // Use PIPELINE_RECURSION_LIMIT to accommodate input processing +
                    // pre_model_hook + agent node steps. The previous value of 6 was
                    // too low for planning agents with large outputs (P2).
                    { configurable: { thread_id: repairThreadId }, recursionLimit: PIPELINE_RECURSION_LIMIT },
                );
            } catch (repairErr: any) {
                invokeLog.warn(`Repair attempt ${attempt + 1} for "${threadSuffix}" threw: ${repairErr?.message ?? repairErr}`);
                continue;
            }
            logAgentResponse({
                agentId, phase, model, threadId: repairThreadId, invocationId,
                kind: 'repair', attempt: attempt + 1, userMessage: repairMsg,
                systemPrompt: agent.systemPromptText,
            }, repairResult);
            // Normalise content blocks (same as main path above)
            const repairExtraction = extractAgentText(repairResult.messages);
            if (repairExtraction.text === null) {
                const repairLast = repairResult.messages[repairResult.messages.length - 1];
                invokeLog.warn(
                    `Repair attempt ${attempt + 1} for "${threadSuffix}" returned no text ` +
                    `(${repairExtraction.blockTypes})`,
                );
                // Non-text content — try validating it directly
                const rv = validateAgentOutput(schema!, repairLast?.content);
                if (rv.ok) {
                    _recordRepaired();
                    invokeLog.info(`Agent "${threadSuffix}" repaired on attempt ${attempt + 1}`);
                    emitEnd({ repaired: true, repairAttempt: attempt + 1 });
                    return { output: rv.value, tokenUsage };
                }
                continue;
            }
            const repairParse = parseAgentJson(repairExtraction.text.trim());
            if (!repairParse.ok) continue;
            const rv = validateAgentOutput(schema!, repairParse.value);
            if (rv.ok) {
                _recordRepaired();
                invokeLog.info(`Agent "${threadSuffix}" repaired on attempt ${attempt + 1}`);
                emitEnd({ repaired: true, repairAttempt: attempt + 1 });
                return { output: rv.value, tokenUsage };
            }
        }

        // All repair attempts failed — strict enforcement: throw instead of
        // returning unvalidated data that silently corrupts downstream state.
        _recordFailed();
        const errMsg = `Agent "${threadSuffix}" output invalid after ${AGENT_OUTPUT_REPAIR_ATTEMPTS} repair attempt(s). Issues: ${issuesForRepair}`;
        invokeLog.error(errMsg);
        emitEnd({ validationFailed: true });
        throw new Error(errMsg);
    }, threadSuffix);
}
