/**
 * Tests for run-ledger.ts and ledger-report.ts — Sub-Plan 12.
 */
jest.mock('../src/config', () => ({
    ...jest.requireActual('../src/config'),
    RUN_LEDGER_ENABLED: true,
    EVENT_BUFFER_SIZE: 100,
    EVENT_PRIORITY_BUFFER_SIZE: 50,
}));

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initLedger, appendLedger, readLedger, _resetLedger } from '../src/utils/run-ledger';
import { renderRunReport } from '../src/utils/ledger-report';
import type { LedgerEntry } from '../src/utils/run-ledger';

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
    _resetLedger();
    initLedger(tmpDir);
});

afterEach(() => {
    _resetLedger();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── appendLedger / readLedger ──────────────────────────────────────────────

describe('appendLedger', () => {
    it('writes JSONL entries to ledger.jsonl', () => {
        appendLedger({ kind: 'phase', phase: 'intake', event: 'start' });
        appendLedger({ kind: 'phase', phase: 'intake', event: 'end', durationMs: 1000 });

        const entries = readLedger(tmpDir);
        expect(entries).toHaveLength(2);
        expect(entries[0].kind).toBe('phase');
        expect((entries[0] as any).phase).toBe('intake');
        expect((entries[0] as any).event).toBe('start');
        expect(entries[0].t).toBeDefined();
        expect((entries[1] as any).durationMs).toBe(1000);
    });

    it('never throws on write failure', () => {
        _resetLedger();
        initLedger('/nonexistent/path/that/does/not/exist');
        expect(() => appendLedger({ kind: 'phase', phase: 'intake', event: 'start' })).not.toThrow();
    });

    it('does nothing when ledger is not initialized', () => {
        _resetLedger();
        expect(() => appendLedger({ kind: 'phase', phase: 'intake', event: 'start' })).not.toThrow();
    });

    it('writes all entry kinds correctly', () => {
        appendLedger({
            kind: 'acceptance',
            status: 'rejected',
            blockers: ['BUILD failed'],
            unrecoverable: false,
        });
        appendLedger({
            kind: 'plan-funnel',
            epics: 5, stories: 10, criteria: 20, tasks: 15, assignments: 8,
            unassignedStories: ['US-009', 'US-010'],
            unassignedTasks: ['TASK-014'],
        });
        appendLedger({
            kind: 'invariant',
            id: 'INV-PLAN-COVERAGE',
            phase: 'team-leader',
            detail: '2 stories have no assignment',
        });

        const entries = readLedger(tmpDir);
        expect(entries).toHaveLength(3);
        expect(entries[0].kind).toBe('acceptance');
        expect(entries[1].kind).toBe('plan-funnel');
        expect(entries[2].kind).toBe('invariant');
    });
});

describe('readLedger', () => {
    it('returns empty array for missing file', () => {
        expect(readLedger('/nonexistent')).toEqual([]);
    });

    it('skips malformed lines', () => {
        const ledgerPath = path.join(tmpDir, 'ledger.jsonl');
        fs.writeFileSync(ledgerPath, '{"t":"2026-01-01","kind":"phase","phase":"intake","event":"start"}\nnot-json\n{"t":"2026-01-02","kind":"phase","phase":"intake","event":"end"}\n');
        const entries = readLedger(tmpDir);
        expect(entries).toHaveLength(2);
    });
});

// ─── renderRunReport ────────────────────────────────────────────────────────

describe('renderRunReport', () => {
    it('renders a report with verdict and plan funnel', () => {
        const entries: LedgerEntry[] = [
            { t: '2026-01-01T00:00:00Z', kind: 'phase', phase: 'intake', event: 'start' },
            { t: '2026-01-01T00:01:00Z', kind: 'plan-funnel', epics: 5, stories: 10, criteria: 20, tasks: 15, assignments: 8, unassignedStories: ['US-009', 'US-010'], unassignedTasks: [] },
            { t: '2026-01-01T00:10:00Z', kind: 'acceptance', status: 'rejected', blockers: ['BUILD: npm run build failed', 'TESTS: 0 tests executed'], unrecoverable: false },
            { t: '2026-01-01T00:10:01Z', kind: 'phase', phase: 'finalize', event: 'end' },
        ];

        const md = renderRunReport(entries, 'pacman8');
        expect(md).toContain('# Run Report — pacman8 — REJECTED');
        expect(md).toContain('REJECTED — 2 blocker(s)');
        expect(md).toContain('BUILD: npm run build failed');
        expect(md).toContain('5 epics → 10 stories');
        expect(md).toContain('2 stories unassigned');
    });

    it('renders a passing report', () => {
        const entries: LedgerEntry[] = [
            { t: '2026-01-01T00:00:00Z', kind: 'acceptance', status: 'accepted', blockers: [], unrecoverable: false },
        ];
        const md = renderRunReport(entries, 'todo-app');
        expect(md).toContain('# Run Report — todo-app — ACCEPTED');
        expect(md).toContain('ACCEPTED — no blockers');
    });

    it('includes agent health data', () => {
        const entries: LedgerEntry[] = [
            { t: '2026-01-01T00:00:00Z', kind: 'agent', agentId: 'senior-frontend', phase: 'development', invocation: 1, toolCalls: { read: 10, write: 0, shell: 2 }, respawns: 3, poisoned: true, filesWritten: [], filesClaimed: ['src/App.tsx'], phantoms: ['src/App.tsx'], outcome: 'budget-exhausted' },
            { t: '2026-01-01T00:01:00Z', kind: 'acceptance', status: 'rejected', blockers: ['BUILD'], unrecoverable: false },
        ];
        const md = renderRunReport(entries, 'test');
        expect(md).toContain('Poisoned invocations: 1');
        expect(md).toContain('Phantom fileChanges: 1');
    });
});
