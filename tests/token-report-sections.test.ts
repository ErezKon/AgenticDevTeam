/**
 * Token accounting and report numbers (Plan 30-06): effective input per
 * invocation, attribution to dispatch rounds and branches, list price vs billed
 * cost, the median uncached input per call and the unmerged-branch counter.
 *
 * In the claudeopus5 run the report's "List price" was the sum of billed costs,
 * so the cache savings read $1.10 where the run really saved about $12.
 */
jest.mock('../src/config', () => ({
    ...jest.requireActual('../src/config'),
    MODEL_PRICING: {
        'claude-haiku-4-5': { inputPer1k: 0.001, outputPer1k: 0.005, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
    },
}));
jest.mock('../src/utils/logger');

import { TokenTracker, withTokenAttribution, type TokenCallRecord } from '../src/utils/token-tracker';
import {
    computeReportTotals, renderAttributionTables, renderTotalsCards, renderUnpricedWarning,
} from '../src/utils/token-report-sections';

const rec = (over: Partial<TokenCallRecord> = {}): TokenCallRecord => ({
    agentId: 'junior-angular', model: 'claude-haiku-4-5', phase: 'development',
    inputTokens: 10_000, outputTokens: 100, totalTokens: 10_100, cacheReadTokens: 8_000, cacheCreationTokens: 0,
    timestamp: '2026-01-01T00:00:00Z', ...over,
});

let tracker: TokenTracker;
beforeEach(() => { tracker = new TokenTracker(); });
afterEach(() => tracker.reset());   // clears the flush timers recordCall schedules

describe('TokenTracker — effective input and attribution (Plan 30-06)', () => {
    it('sums raw and effective (cache-weighted) input per invocation', () => {
        const inv = tracker.startInvocation('junior-angular', 'development');
        tracker.recordCall(rec({ invocationId: inv }));                                        // 2,000 + 0.1 × 8,000
        tracker.recordCall(rec({ invocationId: inv, cacheReadTokens: 0, cacheCreationTokens: 10_000 })); // 1.25 × 10,000

        expect(tracker.getInvocationInputTokens(inv)).toBe(20_000);
        expect(tracker.getInvocationEffectiveTokens(inv)).toBeCloseTo(2_800 + 12_500, 6);
        expect(tracker.getInvocationEffectiveTokens('inv-unknown')).toBe(0);
    });

    it('never joins a previous run\'s records to this session\'s invocations (ids restart at 0)', () => {
        const inv = tracker.startInvocation('junior-angular', 'development');   // inv-junior-angular-0
        tracker.recordFromPreviousRun({ ...rec(), invocationId: 'inv-junior-angular-0' });

        expect(tracker.getInvocationInputTokens(inv)).toBe(0);
        expect(tracker.getSnapshot()[0].invocationId).toBe('prev:inv-junior-angular-0');
    });

    it('stamps the dispatch round and branch on the invocations started in their scope (nested scopes merge)', async () => {
        const ids = await withTokenAttribution({ round: 2 }, async () => {
            const triage = tracker.startInvocation('tech-lead', 'development');
            const onBranch = await withTokenAttribution({ branch: 'app/feature/a' }, async () => {
                await Promise.resolve();
                return tracker.startInvocation('junior-angular', 'development');
            });
            tracker.recordBranchOutcome('app/feature/a', 'blocked');
            return { triage, onBranch };
        });
        const outside = tracker.startInvocation('qa-unit', 'qa');
        const byId = new Map(tracker.getInvocations().map(i => [i.id, i] as const));

        expect(byId.get(ids.onBranch)).toMatchObject({ round: 2, branch: 'app/feature/a' });
        expect(byId.get(ids.triage)).toMatchObject({ round: 2 });
        expect(byId.get(ids.triage)!.branch).toBeUndefined();
        expect(byId.get(outside)!.round).toBeUndefined();
        expect(tracker.getBranchOutcomes()).toEqual([{ branch: 'app/feature/a', status: 'blocked', round: 2 }]);
    });

    it('keeps one summary row per agent and model, so each row prices exactly', () => {
        tracker.recordCall(rec({ model: 'claude-haiku-4-5' }));
        tracker.recordCall(rec({ model: 'claude-opus-5' }));
        expect(tracker.getRunSummary().byAgent.map(a => a.model).sort()).toEqual(['claude-haiku-4-5', 'claude-opus-5']);
    });
});

describe('report numbers (Plan 30-06)', () => {
    /** Two branches in round 1 — a merged, b blocked (budget-capped) — and a QA call outside any round. */
    function scenario() {
        const invA = withTokenAttribution({ round: 1, branch: 'app/feature/a' }, () => tracker.startInvocation('junior-angular', 'development'));
        const invB = withTokenAttribution({ round: 1, branch: 'app/feature/b' }, () => tracker.startInvocation('senior-backend', 'development'));
        tracker.markBudgetCapped(invB);
        withTokenAttribution({ round: 1 }, () => {
            tracker.recordBranchOutcome('app/feature/a', 'merged');
            tracker.recordBranchOutcome('app/feature/b', 'blocked');
        });
        const records = [
            rec({ invocationId: invA }),
            rec({ invocationId: invB, inputTokens: 4_000, cacheReadTokens: 0, outputTokens: 200, totalTokens: 4_200 }),
            rec({ agentId: 'qa-unit', phase: 'qa', inputTokens: 6_000, cacheReadTokens: 3_000, cacheCreationTokens: 1_000, outputTokens: 300, totalTokens: 6_300 }),
        ];
        return { records, invocations: tracker.getInvocations(), outcomes: tracker.getBranchOutcomes() };
    }

    it('list price is the list price; savings = list − billed; effective input and median uncached per call', () => {
        const { records, invocations, outcomes } = scenario();
        const t = computeReportTotals(records, invocations, outcomes);

        // list: (10 + 0.5 + 4 + 1 + 6 + 1.5) / 1000
        expect(t.listCost).toBeCloseTo(0.023, 10);
        // billed: 0.0033 + 0.005 + 0.00505
        expect(t.billedCost).toBeCloseTo(0.01335, 10);
        expect(t.savings).toBeCloseTo(0.00965, 10);
        // effective: 2,800 + 4,000 + (2,000 + 1,250 + 300)
        expect(t.effectiveInput).toBeCloseTo(10_350, 6);
        // uncached per call: 2,000 / 4,000 / 2,000
        expect(t.medianUncachedPerCall).toBe(2_000);
        expect(t.unmergedBranchTokens).toBe(4_200);
        expect(t.budgetCappedInvocations).toBe(1);
        expect(t.unpriced).toEqual([]);
    });

    it('renders the round and branch tables from the attribution', () => {
        const { records, invocations, outcomes } = scenario();
        const html = renderAttributionTables(records, invocations, outcomes);

        expect(html).toContain('Tokens by Development Round');
        expect(html).toMatch(/Round 1<\/td><td class="num">1 \/ 2<\/td><td class="num">2<\/td><td class="num">14,000<\/td>/);
        expect(html).toContain('Tokens by Branch');
        expect(html.indexOf('app/feature/a')).toBeLessThan(html.indexOf('app/feature/b'));   // by input, descending
        expect(html).toMatch(/app\/feature\/b<\/td><td>1<\/td><td>blocked<\/td>/);
    });

    it('renders a placeholder when nothing is attributed, and the new summary cards', () => {
        expect(renderAttributionTables([rec()], [], [])).toBe('<!-- No round/branch attribution -->');
        const cards = renderTotalsCards(computeReportTotals([rec()], [], []));
        for (const label of ['Effective Input', 'Median Uncached Input / Call', 'Tokens on Unmerged Branches', 'Budget-Capped Invocations']) {
            expect(cards).toContain(label);
        }
    });

    it('warns about unpriced models instead of pricing them', () => {
        const t = computeReportTotals([rec({ model: 'claude-opus-9-9' })], [], []);
        expect(t.unpriced).toEqual(['claude-opus-9-9']);
        expect(t.billedCost).toBe(0);
        expect(renderUnpricedWarning(t.unpriced)).toContain('MODEL_PRICING_OVERRIDES');
        expect(renderUnpricedWarning([])).toBe('');
    });
});
