/**
 * Tests for src/agents/_shared/persona.ts
 *
 * Covers: buildDevPersona, buildDevPersonaCompact, buildReviewerPersona.
 * Validates the compact persona stays under budget and retains load-bearing
 * phrases that enforce correct agent behaviour.
 */

// Must set env BEFORE importing persona (which imports config at module level)
process.env.PERSONA_COMPACT = 'true';

import { buildDevPersona, buildDevPersonaCompact, buildReviewerPersona } from '../src/agents/_shared/persona';

// ─── Shared test config ─────────────────────────────────────────────────────

const baseCfg = {
    rank: 'senior' as const,
    domain: 'frontend' as const,
    languages: ['TypeScript', 'React'],
    tag: '[SeniorFrontend]',
};

// ─── buildDevPersonaCompact ──────────────────────────────────────────────────

describe('buildDevPersonaCompact', () => {
    test('compact persona is under 3000 chars without conventions', () => {
        const persona = buildDevPersonaCompact(baseCfg);
        expect(persona.length).toBeLessThan(3000);
    });

    test('compact persona is under 3500 chars with conventions', () => {
        const persona = buildDevPersonaCompact({
            ...baseCfg,
            conventionFiles: ['Universal.md', 'React.md'],
        });
        // The conventions digest (extracted headings/rules) adds content, but
        // the total should still be well under the ~7000 of the old persona
        expect(persona.length).toBeLessThan(3500);
    });

    test('retains NO DEAD CODE rule', () => {
        const persona = buildDevPersonaCompact(baseCfg);
        expect(persona).toContain('NO DEAD CODE');
    });

    test('retains at least one it/test rule', () => {
        const persona = buildDevPersonaCompact(baseCfg);
        expect(persona).toMatch(/at least one.*`it`.*`test`/i);
    });

    test('retains tech stack fidelity rule', () => {
        const persona = buildDevPersonaCompact(baseCfg);
        expect(persona).toContain('tech stack EXACTLY');
    });

    test('does NOT contain git_workflow section', () => {
        const persona = buildDevPersonaCompact(baseCfg);
        expect(persona).not.toContain('<git_workflow>');
        expect(persona).not.toContain('git_checkout_branch');
        expect(persona).not.toContain('git_add');
    });

    test('contains conductor-handles-git instruction', () => {
        const persona = buildDevPersonaCompact(baseCfg);
        expect(persona).toContain('Do not run git commands');
        expect(persona).toContain('conductor commits and pushes');
    });

    test('does NOT contain output_rules section', () => {
        const persona = buildDevPersonaCompact(baseCfg);
        expect(persona).not.toContain('<output_rules>');
    });

    test('does NOT contain maintain_mode when isMaintainMode is false', () => {
        const persona = buildDevPersonaCompact({ ...baseCfg, isMaintainMode: false });
        expect(persona).not.toContain('<maintain_mode>');
    });

    test('contains maintain_mode when isMaintainMode is true', () => {
        const persona = buildDevPersonaCompact({ ...baseCfg, isMaintainMode: true });
        expect(persona).toContain('<maintain_mode>');
        expect(persona).toContain('edit_file');
        expect(persona).toContain('surgical changes');
    });

    test('contains batch work instruction', () => {
        const persona = buildDevPersonaCompact(baseCfg);
        expect(persona).toContain('Batch your work');
        expect(persona).toContain('one write_file call');
    });

    test('identity section includes rank, domain, and languages', () => {
        const persona = buildDevPersonaCompact(baseCfg);
        expect(persona).toContain('[SeniorFrontend]');
        expect(persona).toContain('Senior developer');
        expect(persona).toContain('frontend');
        expect(persona).toContain('TypeScript, React');
    });

    test('all three ranks produce valid compact personas', () => {
        for (const rank of ['principal', 'senior', 'junior'] as const) {
            const persona = buildDevPersonaCompact({ ...baseCfg, rank });
            expect(persona.length).toBeGreaterThan(500);
            expect(persona.length).toBeLessThan(3000);
        }
    });
});

// ─── buildDevPersona (delegating to compact) ────────────────────────────────

describe('buildDevPersona with PERSONA_COMPACT=true', () => {
    test('delegates to compact variant', () => {
        const persona = buildDevPersona(baseCfg);
        // Compact persona does NOT have <git_workflow> or <tdd_rules>
        expect(persona).not.toContain('<git_workflow>');
        expect(persona).not.toContain('<tdd_rules>');
        expect(persona.length).toBeLessThan(3000);
    });
});

// ─── buildReviewerPersona ───────────────────────────────────────────────────

describe('buildReviewerPersona', () => {
    test('contains compact tool_usage section', () => {
        const persona = buildReviewerPersona(baseCfg);
        expect(persona).toContain('<tool_usage>');
        // The compact version should be much shorter than 9 lines
        const toolSection = persona.match(/<tool_usage>([\s\S]*?)<\/tool_usage>/)?.[1] ?? '';
        const lines = toolSection.trim().split('\n').filter(l => l.trim());
        expect(lines.length).toBeLessThanOrEqual(3);
    });

    test('tool_usage mentions HARD BUDGET', () => {
        const persona = buildReviewerPersona(baseCfg);
        expect(persona).toContain('HARD BUDGET');
        expect(persona).toContain('6 tool calls');
    });

    test('tool_usage mentions baseBranch restriction', () => {
        const persona = buildReviewerPersona(baseCfg);
        expect(persona).toContain('baseBranch');
    });

    test('reviewer persona includes review_guidelines', () => {
        const persona = buildReviewerPersona(baseCfg);
        expect(persona).toContain('<review_guidelines>');
        expect(persona).toContain('APPROVE');
        expect(persona).toContain('REQUEST_CHANGES');
    });

    test('reviewer persona includes identity and mission', () => {
        const persona = buildReviewerPersona(baseCfg);
        expect(persona).toContain('CODE REVIEWER MODE');
        expect(persona).toContain('<mission>');
    });
});
