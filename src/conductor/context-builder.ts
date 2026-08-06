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
import { CONTEXT_MAX_DESC_CHARS } from '../config';
import type {
    ArchitectureDoc, TechDecision, DbDesign, UserStory, Task,
    FileChange, CodebaseAnalysis,
} from '../agents/_shared/base-schemas';

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
 */
export function storiesForIds(stories: UserStory[], ids: string[]): string {
    if (!stories?.length || !ids?.length) return '(no stories)';
    const idSet = new Set(ids);
    const matched = stories.filter(s => idSet.has(s.id));
    if (matched.length === 0) return '(no matching stories)';
    return matched.map(s => {
        const acLines = (s.acceptanceCriteria ?? []).map(ac => `    - ${ac}`).join('\n');
        return `- ${s.id}: As a ${s.asA}, I want ${s.iWant}\n  So that: ${s.soThat}\n  Acceptance Criteria:\n${acLines}`;
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
 * `<action> <path>` lines, newest first, capped.
 */
export function summariseFileChanges(changes: FileChange[], limit: number): string {
    if (!changes?.length) return '(no file changes)';
    const recent = changes.slice(-limit).reverse();
    const header = changes.length > limit
        ? `(${changes.length} total, showing last ${limit})`
        : `(${changes.length} total)`;
    const lines = recent.map(c => `- ${(c as any).action ?? 'modify'} ${(c as any).path ?? '?'}`);
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
        const kept = original.slice(0, original.length - cutAmount);
        const annotation = `\n... [clipped ${cutAmount} chars — ask for specifics if you need more]`;
        clippedTexts[entry.idx] = kept + annotation;
        currentTotal -= cutAmount;
        // The annotation adds chars but we accept that overhead
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
