/**
 * Plan 30-03 step 1 — renderTerminalOutput / summariseTestOutput.
 *
 * Fixture: the Karma stdout of the claudeopus5 run (failed-run/debug/errors.jsonl
 * seq 2273) — 134 specs, one failure, ~16 kB of progress redraws and colour codes.
 */
import * as fs from 'fs';
import * as path from 'path';
import { renderTerminalOutput, summariseTestOutput } from '../src/utils/terminal-output';

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'plan30', 'karma-stdout-seq2273.json'), 'utf-8'));
const KARMA_STDOUT: string = fixture.stdoutLines.join('\n');
const FAILED_SPEC = 'ScoreStorageService saveHighScore [US-027#1] should truncate the list to top 10 scores FAILED';

describe('renderTerminalOutput — the claudeopus5 Karma run', () => {
    const rendered = renderTerminalOutput(KARMA_STDOUT);

    it('turns ~16 kB of raw output into under 2 kB', () => {
        expect(KARMA_STDOUT.length).toBeGreaterThan(12_000);
        expect(rendered.length).toBeLessThan(2048);
    });

    it('keeps the failure block and the verdict', () => {
        expect(rendered).toContain(`Chrome Headless 127.0.0.0 (Linux 0.0.0) ${FAILED_SPEC}`);
        expect(rendered).toContain('\tExpected 910 to be 860.');
        expect(rendered).toContain('src/app/core/storage/score-storage.service.spec.ts:112:30');
        expect(rendered).toContain('Executed 134 of 134 (1 FAILED) (0.276 secs / 0.191 secs)');
        expect(rendered).toContain('TOTAL: 1 FAILED, 133 SUCCESS');
    });

    it('replays the progress redraws: one Executed line survives, no escape sequence does', () => {
        expect(rendered.match(/Executed \d+ of 134/g)).toHaveLength(1);
        expect(rendered).not.toContain('\x1b');
        // `Executed 120 of 134` was overwritten in place by the FAILED line (ESC[1A ESC[2K).
        expect(rendered).not.toContain('Executed 120 of 134');
    });

    it('drops the Node odd-version warning and the spinner start line, keeps the spinner result', () => {
        expect(rendered).not.toContain('Odd numbered Node.js versions');
        expect(rendered).not.toContain('Node.js version v25.9.0 detected.');
        expect(rendered).not.toContain('- Generating browser application bundles');
        expect(rendered).toContain('✔ Browser application bundle generation complete.');
    });

    it('starts with the npm banner and has no blank runs', () => {
        expect(rendered.startsWith('> claudeopus5@0.0.0 test\n> ng test --watch=false --browsers=ChromeHeadless')).toBe(true);
        expect(rendered).not.toMatch(/\n\n\n/);
    });
});

describe('renderTerminalOutput — terminal semantics', () => {
    it('applies carriage returns and erase-to-end-of-line', () => {
        expect(renderTerminalOutput('downloading 10%\rdownloading 99%\rdone\x1b[K\n')).toBe('done');
        expect(renderTerminalOutput('abcdef\rXY\n')).toBe('XYcdef');
    });

    it('applies cursor-up and erase-line, and strips colours and OSC titles', () => {
        expect(renderTerminalOutput('one\ntwo\n\x1b[2A\x1b[2Kuno\n')).toBe('uno\ntwo');
        expect(renderTerminalOutput('\x1b]0;window title\x07\x1b[1;31mred\x1b[0m text')).toBe('red text');
    });

    it('collapses a run of progress lines printed without a TTY into the last one', () => {
        const out = renderTerminalOutput('Executed 1 of 3 SUCCESS\nExecuted 2 of 3 SUCCESS\nExecuted 3 of 3 SUCCESS\nTOTAL: 3 SUCCESS\n');
        expect(out).toBe('Executed 3 of 3 SUCCESS\nTOTAL: 3 SUCCESS');
    });

    it('leaves ordinary repeated lines alone', () => {
        expect(renderTerminalOutput('  ✓ adds 1 + 2\n  ✓ adds 2 + 3\n')).toBe('  ✓ adds 1 + 2\n  ✓ adds 2 + 3');
    });
});

describe('summariseTestOutput', () => {
    const rendered = renderTerminalOutput(KARMA_STDOUT);
    const noise = Array.from({ length: 600 }, (_, i) => `LOG: 'render frame ${i}'`).join('\n');

    it('returns short text unchanged', () => {
        expect(summariseTestOutput(rendered, 4000)).toBe(rendered);
    });

    it('keeps failure blocks and summary lines within the budget and marks what it omitted', () => {
        const long = rendered.replace('TOTAL:', `${noise}\nTOTAL:`);
        expect(long.length).toBeGreaterThan(10_000);

        const summary = summariseTestOutput(long, 1500);
        expect(summary.length).toBeLessThanOrEqual(1500);
        expect(summary).toContain(FAILED_SPEC);
        expect(summary).toContain('Expected 910 to be 860.');
        expect(summary).toContain('TOTAL: 1 FAILED, 133 SUCCESS');
        expect(summary).toMatch(/… \[\d+ line\(s\) omitted\]/);
        expect(summary).not.toContain("render frame 200'");
    });

    it('keeps Jest failure blocks, including their blank lines', () => {
        const jest = [
            ...Array.from({ length: 200 }, (_, i) => `PASS src/module${i}.test.ts`),
            '  ● Cart › [US-004#0] adds an item',
            '',
            '    expect(received).toBe(expected)',
            '',
            '    Expected: 2',
            '    Received: 1',
            'Tests:       1 failed, 199 passed, 200 total',
        ].join('\n');
        const summary = summariseTestOutput(jest, 800);
        expect(summary).toContain('● Cart › [US-004#0] adds an item');
        expect(summary).toContain('Expected: 2');
        expect(summary).toContain('Received: 1');
        expect(summary).toContain('Tests:       1 failed, 199 passed, 200 total');
        expect(summary).not.toContain('PASS src/module100.test.ts');
    });

    it('clips the middle when even the kept lines are too long', () => {
        const failures = Array.from({ length: 300 }, (_, i) => `spec ${i} FAILED`).join('\n');
        const summary = summariseTestOutput(failures, 500);
        expect(summary.length).toBeLessThanOrEqual(500);
        expect(summary.startsWith('spec 0 FAILED')).toBe(true);
        expect(summary.endsWith('spec 299 FAILED')).toBe(true);
        expect(summary).toMatch(/… \[\d+ chars omitted\] …/);
    });
});
