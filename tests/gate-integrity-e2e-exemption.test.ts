/**
 * Integrity gate — browser-test exemption and severity split (Plan 22, F2/F3).
 *
 * ## The bug these tests pin
 *
 * `detectTrivialTests` applied the `no-product-import` rule to every test file. A
 * Playwright spec imports nothing from the product source tree *by construction* —
 * it navigates to a URL and asserts on the DOM. In the pacmanclaude run that
 * produced four CRITICAL findings; the gate deleted
 * `tests/e2e/{accessibility,gameplay,offline,responsive}.spec.ts` plus
 * `tests/unit/main.test.ts`, committed the deletion (`59223d51`), and the reviewer
 * then filed `[MAJOR] No test files exist` — a review failure the gate created.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../src/config', () => ({
    REJECT_TRIVIAL_TESTS: true,
    GATE_INTEGRITY_MODE: 'enforce',
    GATE_INTEGRITY_DELETE_TRIVIAL_TESTS: false,
}));

import {
    detectTrivialTests, isBrowserDrivenTest, trivialTestSeverity,
} from '../src/conductor/gate-integrity';

// ─── Fixtures ───────────────────────────────────────────────────────────────

let ws: string;

/** The real shape of a Playwright spec: no product imports, real assertions. */
const PLAYWRIGHT_SPEC = `import { test, expect } from '@playwright/test';

test('[US-014#1] loads the game shell', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#game-canvas')).toBeVisible();
});

test('[US-014#2] responds to arrow keys', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#score')).toContainText('0');
});
`;

const CYPRESS_SPEC = `describe('gameplay', () => {
    it('starts a game', () => {
        cy.visit('/');
        cy.get('#start').click();
        cy.get('#score').should('contain', '0');
    });
});
`;

const REAL_UNIT_TEST = `import { describe, it, expect } from 'vitest';
import { ScoreManager } from '../../src/scoring/ScoreManager';

describe('ScoreManager', () => {
    it('adds dot points', () => {
        const m = new ScoreManager();
        m.addDot();
        expect(m.score).toBe(10);
    });
});
`;

const TAUTOLOGICAL_TEST = `import { describe, it, expect } from 'vitest';

describe('math', () => {
    it('works', () => {
        expect(1 + 1).toBe(2);
    });
});
`;

function write(rel: string, content: string): string {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
    return rel;
}

beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'adt-integrity-'));
    // A minimal but real product tree so the import graph resolves.
    write('index.html', '<script type="module" src="/src/main.ts"></script>');
    write('src/main.ts', "import { ScoreManager } from './scoring/ScoreManager';\nnew ScoreManager();\n");
    write('src/scoring/ScoreManager.ts', 'export class ScoreManager { score = 0; addDot() { this.score += 10; } }\n');
});

afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

// ─── F2: browser-test detection ─────────────────────────────────────────────

describe('isBrowserDrivenTest (Plan 22 F2)', () => {
    it('detects by path', () => {
        expect(isBrowserDrivenTest('tests/e2e/gameplay.spec.ts', 'nothing here')).toBe(true);
        expect(isBrowserDrivenTest('cypress/integration/a.js', 'nothing here')).toBe(true);
        expect(isBrowserDrivenTest('tests/app.e2e.spec.ts', 'nothing here')).toBe(true);
    });

    it('detects by import even outside an e2e directory', () => {
        expect(isBrowserDrivenTest('tests/smoke.spec.ts', PLAYWRIGHT_SPEC)).toBe(true);
        expect(isBrowserDrivenTest('tests/smoke.spec.ts', "import x from 'selenium-webdriver';")).toBe(true);
    });

    it('detects by browser-driver API usage', () => {
        expect(isBrowserDrivenTest('tests/smoke.spec.ts', CYPRESS_SPEC)).toBe(true);
    });

    it('does not classify a real unit test as browser-driven', () => {
        expect(isBrowserDrivenTest('tests/unit/score.test.ts', REAL_UNIT_TEST)).toBe(false);
    });
});

// ─── F2: the four deleted specs are now clean ───────────────────────────────

describe('detectTrivialTests browser exemption (Plan 22 F2)', () => {
    it('returns no findings for the four Playwright specs the gate deleted', () => {
        const testFiles = [
            write('tests/e2e/accessibility.spec.ts', PLAYWRIGHT_SPEC),
            write('tests/e2e/gameplay.spec.ts', PLAYWRIGHT_SPEC),
            write('tests/e2e/offline.spec.ts', PLAYWRIGHT_SPEC),
            write('tests/e2e/responsive.spec.ts', PLAYWRIGHT_SPEC),
        ];
        const productFiles = ['src/main.ts', 'src/scoring/ScoreManager.ts'];

        expect(detectTrivialTests(ws, testFiles, productFiles)).toEqual([]);
    });

    it('still flags a browser spec that asserts nothing', () => {
        const rel = write('tests/e2e/empty.spec.ts', `import { test } from '@playwright/test';
test('does nothing', async ({ page }) => { await page.goto('/'); });
`);
        const findings = detectTrivialTests(ws, [rel], ['src/main.ts']);

        expect(findings).toHaveLength(1);
        expect(findings[0].reason).toBe('no-assertions');
    });

    it('still flags a tautological unit test', () => {
        const rel = write('tests/unit/math.test.ts', TAUTOLOGICAL_TEST);
        const findings = detectTrivialTests(ws, [rel], ['src/main.ts', 'src/scoring/ScoreManager.ts']);

        expect(findings).toHaveLength(1);
        expect(['single-arithmetic-test', 'tautological-assertion', 'no-product-import'])
            .toContain(findings[0].reason);
    });

    it('leaves a genuine unit test alone', () => {
        const rel = write('tests/unit/score.test.ts', REAL_UNIT_TEST);
        const findings = detectTrivialTests(ws, [rel], ['src/main.ts', 'src/scoring/ScoreManager.ts']);
        expect(findings).toEqual([]);
    });
});

// ─── F3: severity split ─────────────────────────────────────────────────────

describe('trivialTestSeverity (Plan 22 F3)', () => {
    it('keeps unambiguous gate-gaming critical', () => {
        expect(trivialTestSeverity('tautological-assertion')).toBe('critical');
        expect(trivialTestSeverity('single-arithmetic-test')).toBe('critical');
        expect(trivialTestSeverity('no-assertions')).toBe('critical');
    });

    it('downgrades heuristic import-graph reasons to major (report only)', () => {
        // These are the two reasons that produced five false positives and zero
        // true positives in the pacmanclaude run.
        expect(trivialTestSeverity('no-product-import')).toBe('major');
        expect(trivialTestSeverity('subject-not-in-product')).toBe('major');
    });
});
