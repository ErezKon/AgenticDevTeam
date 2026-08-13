/**
 * Context budget manager — replaces raw JSON.stringify state dumps with
 * compact, phase-appropriate summaries and enforces a character budget.
 *
 * Nodes previously concatenated `JSON.stringify(state.X, null, 2)` for up to
 * six state slices (PART A8). Pretty-printing roughly doubled the character
 * count for no benefit, every developer received every user story, and
 * `fileChanges` grew without bound across bug-fix iterations.
 *
 * All functions are pure (no I/O) and fully unit-testable.
 */
import { CONTEXT_MAX_DESC_CHARS, CONTRACT_PROMPT_MAX_CHARS } from '../config';
import { getLogger } from '../utils/logger';
import type {
    ArchitectureDoc, TechDecision, DbDesign, UserStory, Task,
    FileChange, CodebaseAnalysis,
} from '../agents/_shared/base-schemas';
import type { Epic } from '../agents/_shared/schemas/epic.schema';
import type { RepoContract } from '../agents/_shared/schemas/repo-contract.schema';
import { renderContractForPrompt } from '../utils/repo-contract-writer';

const log = getLogger('[context-builder]', 183);

// ─── Context Stats (module-level singleton, same pattern as llm-throttle) ───

let _totalCharsByPhase: Record<string, number> = {};

/** Record characters sent for a phase. */
export function recordContextChars(phase: string, chars: number): void {
    _totalCharsByPhase[phase] = (_totalCharsByPhase[phase] ?? 0) + chars;
}

/** Get accumulated context stats per phase. */
export function getContextStats(): Record<string, number> {
    return { ..._totalCharsByPhase };
}

/** Reset stats (for testing). */
export function _resetContextStats(): void {
    _totalCharsByPhase = {};
}

// ─── Summarisers ────────────────────────────────────────────────────────────

/**
 * Compact one-line-per-component view: name, type, and a clipped description.
 */
export function summariseArchitecture(arch: ArchitectureDoc | null, maxDescChars?: number): string {
    if (!arch) return '(no architecture available)';
    const cap = maxDescChars ?? CONTEXT_MAX_DESC_CHARS;
    const lines: string[] = [];
    lines.push(`Style: ${arch.style ?? 'unknown'}`);
    if (arch.components?.length) {
        lines.push('Components:');
        for (const c of arch.components) {
            const desc = clip(c.description ?? '', cap);
            lines.push(`  - ${c.name} (${c.type}): ${desc}`);
        }
    }
    if (arch.dataFlow) {
        lines.push(`Data flow: ${clip(arch.dataFlow, cap)}`);
    }
    if (arch.integrations?.length) {
        lines.push(`Integrations: ${arch.integrations.join(', ')}`);
    }
    if (arch.nonFunctional?.length) {
        lines.push(`NFRs: ${arch.nonFunctional.join(', ')}`);
    }
    return lines.join('\n');
}

/**
 * `- EPIC-001: title — one-sentence description` lines.
 */
export function summariseEpics(epics: Epic[]): string {
    if (!epics?.length) return '(no epics)';
    return epics.map(e => {
        const desc = firstSentence(e.description ?? '');
        return `- ${e.id}: ${e.title}${desc ? ` — ${desc}` : ''}`;
    }).join('\n');
}

/**
 * `layer: choice` lines; rationale clipped to one sentence.
 */
export function summariseTechStack(stack: TechDecision[]): string {
    if (!stack?.length) return '(no tech stack decisions)';
    return stack.map(t => {
        const rationale = firstSentence(t.rationale ?? '');
        return `- ${t.layer}: ${t.choice}${rationale ? ` — ${rationale}` : ''}`;
    }).join('\n');
}

/**
 * Entities as `Name(col1, col2, ...)`; full DDL only when `detail: 'full'`.
 */
export function summariseDbDesign(db: DbDesign | null, detail: 'compact' | 'full' = 'compact'): string {
    if (!db) return '(no database design)';
    const lines: string[] = [];
    lines.push(`Engine: ${db.engine ?? 'unknown'}`);
    if (detail === 'full') {
        // Full DDL for the DBA agent
        if (db.rationale) lines.push(`Rationale: ${db.rationale}`);
        if (db.entities?.length) {
            lines.push('Entities:');
            for (const e of db.entities) {
                const cols = (e.columns ?? []).map(c =>
                    `${c.name} ${c.type}${c.constraints ? ` ${c.constraints}` : ''}`
                ).join(', ');
                lines.push(`  - ${e.name}(${cols})`);
            }
        }
        if (db.relationships?.length) {
            lines.push('Relationships:');
            for (const r of db.relationships) {
                lines.push(`  - ${r.from} ${r.type} ${r.to}: ${r.description ?? ''}`);
            }
        }
        if (db.erdMermaid) {
            lines.push(`ERD:\n\`\`\`mermaid\n${db.erdMermaid}\n\`\`\``);
        }
    } else {
        // Compact: entity names with column names only
        if (db.entities?.length) {
            for (const e of db.entities) {
                const colNames = (e.columns ?? []).map(c => c.name).join(', ');
                lines.push(`  ${e.name}(${colNames})`);
            }
        }
        if (db.relationships?.length) {
            for (const r of db.relationships) {
                lines.push(`  ${r.from} ${r.type} ${r.to}`);
            }
        }
    }
    return lines.join('\n');
}

/**
 * `US-001 -- title (3 AC)` lines.
 */
export function summariseStories(stories: UserStory[]): string {
    if (!stories?.length) return '(no user stories)';
    return stories.map(s => {
        const acCount = s.acceptanceCriteria?.length ?? 0;
        return `- ${s.id}: As a ${s.asA}, I want ${s.iWant} (${acCount} AC)`;
    }).join('\n');
}

/**
 * Only the stories referenced by these ids, WITH their acceptance criteria.
 *
 * Returns `{ text, missing }` — `missing` lists ids that matched no story
 * (P12: callers must log error for dangling storyId references).
 */
export function storiesForIds(stories: UserStory[], ids: string[]): { text: string; missing: string[] } {
    if (!stories?.length || !ids?.length) return { text: '(no stories)', missing: [...(ids ?? [])] };
    const idSet = new Set(ids);
    const matched = stories.filter(s => idSet.has(s.id));
    const matchedIds = new Set(matched.map(s => s.id));
    const missing = ids.filter(id => !matchedIds.has(id));
    if (matched.length === 0) return { text: '(no matching stories)', missing };
    const text = matched.map(s => {
        const acLines = (s.acceptanceCriteria ?? []).map(ac => `    - ${ac}`).join('\n');
        return `- ${s.id}: As a ${s.asA}, I want ${s.iWant}\n  So that: ${s.soThat}\n  Acceptance Criteria:\n${acLines}`;
    }).join('\n');
    return { text, missing };
}

/**
 * Full stories with numbered acceptance criteria — for the Team Leader (P8).
 * More expensive than `summariseStories` but the TL needs AC detail to size and cover work.
 */
export function storiesWithCriteria(stories: UserStory[]): string {
    if (!stories?.length) return '(no user stories)';
    return stories.map(s => {
        const acLines = (s.acceptanceCriteria ?? []).map((ac, i) => `    AC${i}: ${ac}`).join('\n');
        return `- ${s.id}: As a ${s.asA}, I want ${s.iWant}\n${acLines}`;
    }).join('\n');
}

/**
 * Tasks for specific ids, INCLUDING the full description (P11).
 * Clipped to `maxDescChars` per description (default 800).
 */
export function tasksForIds(tasks: Task[], ids: string[], maxDescChars: number = 800): string {
    if (!tasks?.length || !ids?.length) return '(no tasks)';
    const idSet = new Set(ids);
    const matched = tasks.filter(t => idSet.has(t.id));
    if (matched.length === 0) return '(no matching tasks)';
    return matched.map(t => {
        const desc = clip(t.description ?? '', maxDescChars);
        return `- ${t.id} [${t.layer}/${t.suggestedTech}] ${t.title}\n    ${desc}`;
    }).join('\n');
}

/**
 * `TASK-004 [backend/Go] title` lines.
 */
export function summariseTasks(tasks: Task[]): string {
    if (!tasks?.length) return '(no tasks)';
    return tasks.map(t =>
        `- ${t.id} [${t.layer}/${t.suggestedTech}] ${t.title}`
    ).join('\n');
}

/**
 * Group file changes by directory: `src/components/ (8 files)`.
 * Falls back to individual paths when under the limit.
 */
export function summariseFileChanges(changes: FileChange[], limit: number): string {
    if (!changes?.length) return '(no file changes)';
    const recent = changes.slice(-limit);
    const header = changes.length > limit
        ? `(${changes.length} total, showing last ${limit})`
        : `(${changes.length} total)`;

    // Group by parent directory
    const byDir = new Map<string, number>();
    for (const c of recent) {
        const p = (c as any).path ?? '?';
        const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : './';
        byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
    }

    // If grouped output is compact enough, use it; otherwise list individual paths
    if (byDir.size <= limit && recent.length > byDir.size) {
        const lines = [...byDir.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([dir, count]) => `- ${dir} (${count} file${count > 1 ? 's' : ''})`);
        return `${header}\n${lines.join('\n')}`;
    }

    // Fallback: individual paths (newest first)
    const lines = recent.reverse().map(c => `- ${(c as any).action ?? 'modify'} ${(c as any).path ?? '?'}`);
    return `${header}\n${lines.join('\n')}`;
}

/**
 * Module list + known issues; drops file trees and per-file detail.
 */
export function summariseCodebaseAnalysis(a: CodebaseAnalysis | null): string {
    if (!a) return '(no codebase analysis)';
    const lines: string[] = [];
    if (a.projectName) lines.push(`Project: ${a.projectName} (${a.projectType ?? 'unknown'})`);
    if (a.primaryLanguages?.length) lines.push(`Languages: ${a.primaryLanguages.join(', ')}`);
    if (a.frameworks?.length) lines.push(`Frameworks: ${a.frameworks.join(', ')}`);
    if (a.architecture?.style) lines.push(`Architecture: ${a.architecture.style}`);
    if (a.modules?.length) {
        lines.push(`Modules (${a.modules.length}):`);
        for (const m of a.modules) {
            lines.push(`  - ${m.name} (${m.path}): ${clip(m.responsibility ?? '', 120)}`);
        }
    }
    if (a.knownIssues?.length) {
        lines.push(`Known issues (${a.knownIssues.length}):`);
        for (const i of a.knownIssues) {
            lines.push(`  - ${clip(i, 200)}`);
        }
    }
    return lines.join('\n');
}

// ─── Repo Contract ──────────────────────────────────────────────────────────

/**
 * Render the repo contract for an agent prompt.
 * When `moduleIds` is provided, owning modules are rendered in full; others compactly.
 */
export function summariseRepoContract(
    contract: RepoContract | null,
    opts?: { moduleIds?: string[]; maxChars?: number },
): string {
    if (!contract) return '(no repo contract)';
    return renderContractForPrompt(contract, {
        moduleIds: opts?.moduleIds,
        maxChars: opts?.maxChars ?? CONTRACT_PROMPT_MAX_CHARS,
    });
}

// ─── Build Context ──────────────────────────────────────────────────────────

export interface ContextSection {
    title: string;
    body: string;
    /** 1 = never clip, 2 = clip last, 3 = clip first. */
    priority: number;
}

/**
 * Assemble a phase's user message from titled sections under a hard character
 * budget, clipping the largest sections first and annotating every clip.
 *
 * Nodes previously concatenated `JSON.stringify(state.X, null, 2)` for up to
 * six state slices (PART A8). Pretty-printing roughly doubles the character
 * count for no benefit, every developer received every user story, and
 * `fileChanges` grew without bound across bug-fix iterations.
 */
export function buildContext(
    sections: ContextSection[],
    maxChars: number,
): string {
    // Format sections with headers
    const formatted = sections.map(s => ({
        ...s,
        text: `## ${s.title}\n\n${s.body}`,
    }));

    // Check if we're under budget
    const totalChars = formatted.reduce((sum, s) => sum + s.text.length, 0);
    if (totalChars <= maxChars) {
        return formatted.map(s => s.text).join('\n\n');
    }

    // Over budget — clip the lowest-priority (highest number) sections first
    // Sort clippable sections by priority (desc) then by size (desc)
    const clippable = formatted
        .map((s, i) => ({ idx: i, priority: s.priority, size: s.text.length }))
        .filter(s => s.priority > 1) // Priority 1 = never clip
        .sort((a, b) => b.priority - a.priority || b.size - a.size);

    let currentTotal = totalChars;
    const clippedTexts = formatted.map(s => s.text);

    for (const entry of clippable) {
        if (currentTotal <= maxChars) break;
        const excess = currentTotal - maxChars;
        const original = clippedTexts[entry.idx];
        const header = `## ${formatted[entry.idx].title}\n\n`;

        // Keep at least the header + 100 chars of body
        const minKeep = header.length + 100;
        if (original.length <= minKeep) continue;

        const maxCut = original.length - minKeep;
        const cutAmount = Math.min(excess, maxCut);

        // Clip from the MIDDLE (not the tail) for list-shaped sections (P15).
        // Keep the first third and the last third so both the start and end
        // of the list survive, and the model sees the pattern.
        const lines = original.split('\n');
        if (lines.length > 6) {
            const keepLines = Math.max(4, Math.floor(lines.length * (1 - cutAmount / original.length)));
            const headCount = Math.ceil(keepLines / 2);
            const tailCount = keepLines - headCount;
            const omitted = lines.length - headCount - tailCount;
            const headPart = lines.slice(0, headCount).join('\n');
            const tailPart = lines.slice(lines.length - tailCount).join('\n');
            const annotation = `\n... [${omitted} items omitted] ...\n`;
            clippedTexts[entry.idx] = headPart + annotation + tailPart;
            log.warn(`buildContext: clipped "${formatted[entry.idx].title}" — ${omitted} lines omitted from middle`);
        } else {
            // Short section: clip from end as before
            const kept = original.slice(0, original.length - cutAmount);
            const annotation = `\n... [clipped ${cutAmount} chars — ask for specifics if you need more]`;
            clippedTexts[entry.idx] = kept + annotation;
        }
        currentTotal = clippedTexts.reduce((sum, t) => sum + t.length, 0);
    }

    // Final safety: if still over budget after all clips, force-clip lowest-priority sections
    const finalTotal = clippedTexts.reduce((sum, t) => sum + t.length, 0);
    if (finalTotal > maxChars) {
        log.error(`buildContext: still ${finalTotal - maxChars} chars over budget after clipping — force-truncating`);
    }

    return clippedTexts.join('\n\n');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Clip a string to `max` characters, appending `...` if truncated. */
function clip(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 3) + '...';
}

/** Extract the first sentence (up to the first `.` followed by a space or end). */
function firstSentence(s: string): string {
    const m = s.match(/^[^.]*\./);
    return m ? m[0] : s;
}
