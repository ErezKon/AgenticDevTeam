/**
 * Tests for tool-loop-guard.ts budget resolution (Plan 26, B4).
 *
 * Validates that complexity scaling is applied correctly to resolveToolBudgets.
 */
import { resolveToolBudgets, COMPLEXITY_MULTIPLIERS } from '../src/agents/_shared/tool-loop-guard';

describe('resolveToolBudgets', () => {
    it('returns default principal budgets when no override or complexity', () => {
        const budgets = resolveToolBudgets('principal');
        expect(budgets).toEqual({ reads: 60, writes: 30, shell: 14, turns: 28 });
    });

    it('returns default senior budgets', () => {
        const budgets = resolveToolBudgets('senior');
        expect(budgets).toEqual({ reads: 50, writes: 25, shell: 12, turns: 24 });
    });

    it('returns default junior budgets', () => {
        const budgets = resolveToolBudgets('junior');
        expect(budgets).toEqual({ reads: 40, writes: 20, shell: 12, turns: 20 });
    });

    it('falls back to default rank when rank is unknown', () => {
        const budgets = resolveToolBudgets('intern');
        expect(budgets).toEqual({ reads: 50, writes: 25, shell: 12, turns: 24 });
    });

    describe('complexity scaling (Plan 26, B4)', () => {
        it('applies 1.5x multiplier for complex assignments', () => {
            const budgets = resolveToolBudgets('principal', undefined, 'complex');
            // turns: 28 * 1.5 = 42, writes: 30 * 1.5 = 45
            expect(budgets.turns).toBe(42);
            expect(budgets.writes).toBe(45);
            // reads and shell stay at base
            expect(budgets.reads).toBe(60);
            expect(budgets.shell).toBe(14);
        });

        it('applies 2.0x multiplier for very-complex assignments', () => {
            const budgets = resolveToolBudgets('principal', undefined, 'very-complex');
            // turns: 28 * 2.0 = 56, writes: 30 * 2.0 = 60
            expect(budgets.turns).toBe(56);
            expect(budgets.writes).toBe(60);
            expect(budgets.reads).toBe(60);
            expect(budgets.shell).toBe(14);
        });

        it('applies 0.75x multiplier for trivial assignments', () => {
            const budgets = resolveToolBudgets('principal', undefined, 'trivial');
            // turns: 28 * 0.75 = 21, writes: 30 * 0.75 = 22.5 → 23 (rounded)
            expect(budgets.turns).toBe(21);
            expect(budgets.writes).toBe(23);
        });

        it('applies 0.75x multiplier for simple assignments', () => {
            const budgets = resolveToolBudgets('senior', undefined, 'simple');
            // turns: 24 * 0.75 = 18, writes: 25 * 0.75 = 18.75 → 19 (rounded)
            expect(budgets.turns).toBe(18);
            expect(budgets.writes).toBe(19);
        });

        it('applies 1.0x (no change) for moderate assignments', () => {
            const budgets = resolveToolBudgets('principal', undefined, 'moderate');
            expect(budgets.turns).toBe(28);
            expect(budgets.writes).toBe(30);
        });

        it('defaults to 1.0x when complexity is not provided', () => {
            const budgets = resolveToolBudgets('principal');
            const budgetsWithModerate = resolveToolBudgets('principal', undefined, 'moderate');
            expect(budgets).toEqual(budgetsWithModerate);
        });

        it('defaults to 1.0x for unknown complexity values', () => {
            const budgets = resolveToolBudgets('principal', undefined, 'unknown-complexity');
            expect(budgets.turns).toBe(28);
            expect(budgets.writes).toBe(30);
        });
    });

    describe('JSON override + complexity', () => {
        it('applies JSON override first, then complexity scaling', () => {
            const json = JSON.stringify({ principal: { turns: 40, writes: 40 } });
            const budgets = resolveToolBudgets('principal', json, 'complex');
            // Overridden: turns=40, writes=40, then scaled by 1.5x
            expect(budgets.turns).toBe(60);  // 40 * 1.5
            expect(budgets.writes).toBe(60); // 40 * 1.5
            // reads and shell still from base (JSON didn't override them)
            expect(budgets.reads).toBe(60);
            expect(budgets.shell).toBe(14);
        });

        it('handles invalid JSON gracefully and still applies complexity', () => {
            const budgets = resolveToolBudgets('principal', 'not-json', 'complex');
            expect(budgets.turns).toBe(42); // 28 * 1.5
            expect(budgets.writes).toBe(45); // 30 * 1.5
        });
    });
});

describe('COMPLEXITY_MULTIPLIERS', () => {
    it('exports the expected multipliers', () => {
        expect(COMPLEXITY_MULTIPLIERS['trivial']).toBe(0.75);
        expect(COMPLEXITY_MULTIPLIERS['simple']).toBe(0.75);
        expect(COMPLEXITY_MULTIPLIERS['moderate']).toBe(1.0);
        expect(COMPLEXITY_MULTIPLIERS['complex']).toBe(1.5);
        expect(COMPLEXITY_MULTIPLIERS['very-complex']).toBe(2.0);
    });
});
