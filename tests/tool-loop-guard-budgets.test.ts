/**
 * Tests for tool-loop-guard.ts budget resolution (Plan 26, B4; Plan 27-C).
 *
 * Validates that complexity scaling is applied correctly to resolveToolBudgets.
 * Plan 27-C: updated for raised base budgets and removed trivial/simple penalty.
 */
import { resolveToolBudgets, COMPLEXITY_MULTIPLIERS } from '../src/agents/_shared/tool-loop-guard';

describe('resolveToolBudgets', () => {
    it('returns default principal budgets when no override or complexity', () => {
        const budgets = resolveToolBudgets('principal');
        expect(budgets).toEqual({ reads: 80, writes: 40, shell: 20, turns: 45 });
    });

    it('returns default senior budgets', () => {
        const budgets = resolveToolBudgets('senior');
        expect(budgets).toEqual({ reads: 70, writes: 35, shell: 18, turns: 40 });
    });

    it('returns default junior budgets', () => {
        const budgets = resolveToolBudgets('junior');
        expect(budgets).toEqual({ reads: 60, writes: 30, shell: 16, turns: 35 });
    });

    it('falls back to default rank when rank is unknown', () => {
        const budgets = resolveToolBudgets('intern');
        expect(budgets).toEqual({ reads: 70, writes: 35, shell: 18, turns: 40 });
    });

    describe('complexity scaling (Plan 26, B4; Plan 27-C)', () => {
        it('applies 1.5x multiplier for complex assignments', () => {
            const budgets = resolveToolBudgets('principal', undefined, 'complex');
            // turns: 45 * 1.5 = 67.5 → 68, writes: 40 * 1.5 = 60
            expect(budgets.turns).toBe(68);
            expect(budgets.writes).toBe(60);
            // reads and shell stay at base
            expect(budgets.reads).toBe(80);
            expect(budgets.shell).toBe(20);
        });

        it('applies 2.0x multiplier for very-complex assignments', () => {
            const budgets = resolveToolBudgets('principal', undefined, 'very-complex');
            // turns: 45 * 2.0 = 90, writes: 40 * 2.0 = 80
            expect(budgets.turns).toBe(90);
            expect(budgets.writes).toBe(80);
            expect(budgets.reads).toBe(80);
            expect(budgets.shell).toBe(20);
        });

        it('applies 1.0x (no penalty) for trivial assignments (Plan 27-C)', () => {
            const budgets = resolveToolBudgets('principal', undefined, 'trivial');
            // Plan 27-C: trivial no longer penalised — stays at base
            expect(budgets.turns).toBe(45);
            expect(budgets.writes).toBe(40);
        });

        it('applies 1.0x (no penalty) for simple assignments (Plan 27-C)', () => {
            const budgets = resolveToolBudgets('senior', undefined, 'simple');
            // Plan 27-C: simple no longer penalised — stays at base
            expect(budgets.turns).toBe(40);
            expect(budgets.writes).toBe(35);
        });

        it('applies 1.0x (no change) for moderate assignments', () => {
            const budgets = resolveToolBudgets('principal', undefined, 'moderate');
            expect(budgets.turns).toBe(45);
            expect(budgets.writes).toBe(40);
        });

        it('defaults to 1.0x when complexity is not provided', () => {
            const budgets = resolveToolBudgets('principal');
            const budgetsWithModerate = resolveToolBudgets('principal', undefined, 'moderate');
            expect(budgets).toEqual(budgetsWithModerate);
        });

        it('defaults to 1.0x for unknown complexity values', () => {
            const budgets = resolveToolBudgets('principal', undefined, 'unknown-complexity');
            expect(budgets.turns).toBe(45);
            expect(budgets.writes).toBe(40);
        });
    });

    describe('JSON override + complexity', () => {
        it('applies JSON override first, then complexity scaling', () => {
            const json = JSON.stringify({ principal: { turns: 50, writes: 50 } });
            const budgets = resolveToolBudgets('principal', json, 'complex');
            // Overridden: turns=50, writes=50, then scaled by 1.5x
            expect(budgets.turns).toBe(75);  // 50 * 1.5
            expect(budgets.writes).toBe(75); // 50 * 1.5
            // reads and shell still from base (JSON didn't override them)
            expect(budgets.reads).toBe(80);
            expect(budgets.shell).toBe(20);
        });

        it('handles invalid JSON gracefully and still applies complexity', () => {
            const budgets = resolveToolBudgets('principal', 'not-json', 'complex');
            expect(budgets.turns).toBe(68); // 45 * 1.5 = 67.5 → 68
            expect(budgets.writes).toBe(60); // 40 * 1.5
        });
    });
});

describe('COMPLEXITY_MULTIPLIERS', () => {
    it('exports the expected multipliers (Plan 27-C: trivial/simple penalty removed)', () => {
        expect(COMPLEXITY_MULTIPLIERS['trivial']).toBe(1.0);
        expect(COMPLEXITY_MULTIPLIERS['simple']).toBe(1.0);
        expect(COMPLEXITY_MULTIPLIERS['moderate']).toBe(1.0);
        expect(COMPLEXITY_MULTIPLIERS['complex']).toBe(1.5);
        expect(COMPLEXITY_MULTIPLIERS['very-complex']).toBe(2.0);
    });
});
