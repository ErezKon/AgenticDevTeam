/**
 * Agent respawn — unit tests for deterministic handoff extraction.
 *
 * Verifies that buildHandoff and renderHandoff:
 * - Extract written files from write_file/edit_file tool calls (path + action only)
 * - Extract commands and exit codes from run_command tool calls
 * - Never include file content in the handoff
 * - Keep renderHandoff output under 1,200 chars for a 30-tool-call history
 * - Handle edge cases: empty messages, no tool calls, mixed message types
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { buildHandoff, renderHandoff, madeProgress } from '../src/conductor/agent-respawn';

// Mock logger to avoid console noise
jest.mock('../src/utils/logger', () => ({
    getLogger: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    })),
    setRunLogPath: jest.fn(),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a synthetic message array simulating a dev agent's tool loop.
 * Each round has an AIMessage (with tool_calls) and matching ToolMessages.
 */
function buildSyntheticHistory(rounds: {
    toolName: string;
    args: Record<string, any>;
    result: string;
    toolCallId: string;
}[]) {
    const messages: any[] = [
        new HumanMessage('Implement the Board component with tests.'),
    ];

    for (const round of rounds) {
        messages.push(
            new AIMessage({
                content: '',
                tool_calls: [{
                    name: round.toolName,
                    args: round.args,
                    id: round.toolCallId,
                    type: 'tool_call' as const,
                }],
            }),
        );
        messages.push(
            new ToolMessage({
                content: round.result,
                tool_call_id: round.toolCallId,
                name: round.toolName,
            }),
        );
    }

    return messages;
}

/** Build a large (30-tool-call) history simulating a full dev loop. */
function buildLargeHistory() {
    const rounds = [];
    // Mix of read, write, edit, and run_command calls
    for (let i = 0; i < 10; i++) {
        rounds.push({
            toolName: 'read_file',
            args: { filePath: `src/component-${i}.tsx` },
            result: `// Component ${i} source code...\n`.repeat(100),
            toolCallId: `read-${i}`,
        });
    }
    for (let i = 0; i < 8; i++) {
        rounds.push({
            toolName: 'write_file',
            args: { filePath: `src/component-${i}.tsx`, content: `// Updated content for ${i}...\n`.repeat(50) },
            result: `File written: src/component-${i}.tsx`,
            toolCallId: `write-${i}`,
        });
    }
    for (let i = 0; i < 5; i++) {
        rounds.push({
            toolName: 'edit_file',
            args: { filePath: `src/component-${i}.test.tsx`, oldString: 'old', newString: 'new' },
            result: `File edited: src/component-${i}.test.tsx`,
            toolCallId: `edit-${i}`,
        });
    }
    for (let i = 0; i < 7; i++) {
        const exitCode = i === 6 ? 1 : 0;
        rounds.push({
            toolName: 'run_command',
            args: { command: i === 6 ? 'npm test' : `npm run lint` },
            result: `Exit code: ${exitCode}\n${exitCode ? 'FAIL: test assertion error' : 'All checks passed'}`,
            toolCallId: `cmd-${i}`,
        });
    }
    return buildSyntheticHistory(rounds);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Agent Respawn', () => {
    describe('buildHandoff', () => {
        it('captures written files with path and action', () => {
            const messages = buildSyntheticHistory([
                { toolName: 'write_file', args: { filePath: 'src/Board.tsx', content: 'full-content-here' }, result: 'File written', toolCallId: 'w1' },
                { toolName: 'edit_file', args: { filePath: 'src/Board.test.tsx', oldString: 'old', newString: 'new' }, result: 'File edited', toolCallId: 'e1' },
            ]);

            const handoff = buildHandoff(messages, 1);

            expect(handoff.filesWritten).toHaveLength(2);
            expect(handoff.filesWritten[0]).toEqual({ path: 'src/Board.tsx', action: 'created' });
            expect(handoff.filesWritten[1]).toEqual({ path: 'src/Board.test.tsx', action: 'edited' });
        });

        it('captures commands with exit codes', () => {
            const messages = buildSyntheticHistory([
                { toolName: 'run_command', args: { command: 'npm install' }, result: 'Exit code: 0\nInstalled successfully', toolCallId: 'c1' },
                { toolName: 'run_command', args: { command: 'npm test' }, result: 'Exit code: 1\nFAIL: test failed', toolCallId: 'c2' },
            ]);

            const handoff = buildHandoff(messages, 1);

            expect(handoff.commandsRun).toHaveLength(2);
            expect(handoff.commandsRun[0]).toMatchObject({ command: 'npm install', exitCode: 0 });
            expect(handoff.commandsRun[1]).toMatchObject({ command: 'npm test', exitCode: 1 });
        });

        it('never includes file content in the handoff', () => {
            const largeContent = 'x'.repeat(10000);
            const messages = buildSyntheticHistory([
                { toolName: 'write_file', args: { filePath: 'src/App.tsx', content: largeContent }, result: 'File written', toolCallId: 'w1' },
            ]);

            const handoff = buildHandoff(messages, 1);
            const serialised = JSON.stringify(handoff);

            // Content should NOT appear anywhere in the handoff
            expect(serialised).not.toContain(largeContent);
            expect(serialised.length).toBeLessThan(500);
        });

        it('deduplicates file paths and keeps the last action', () => {
            const messages = buildSyntheticHistory([
                { toolName: 'write_file', args: { filePath: 'src/App.tsx', content: 'v1' }, result: 'written', toolCallId: 'w1' },
                { toolName: 'edit_file', args: { filePath: 'src/App.tsx', oldString: 'v1', newString: 'v2' }, result: 'edited', toolCallId: 'e1' },
            ]);

            const handoff = buildHandoff(messages, 1);

            expect(handoff.filesWritten).toHaveLength(1);
            expect(handoff.filesWritten[0]).toEqual({ path: 'src/App.tsx', action: 'edited' });
        });

        it('extracts key findings from the last AIMessage text content', () => {
            const messages = buildSyntheticHistory([
                { toolName: 'read_file', args: { filePath: 'src/App.tsx' }, result: 'content', toolCallId: 'r1' },
            ]);
            // Add an AIMessage with text content at the end
            messages.push(new AIMessage({ content: 'The Board component needs a cells prop to render the grid.' }));

            const handoff = buildHandoff(messages, 1);

            expect(handoff.keyFindings).toHaveLength(1);
            expect(handoff.keyFindings[0]).toContain('Board component');
        });

        it('clips key findings to 800 chars', () => {
            const longFinding = 'A'.repeat(1500);
            const messages = [
                new HumanMessage('task'),
                new AIMessage({ content: longFinding }),
            ];

            const handoff = buildHandoff(messages, 1);

            expect(handoff.keyFindings[0].length).toBe(800);
        });

        it('derives remaining work from failed commands', () => {
            const messages = buildSyntheticHistory([
                { toolName: 'run_command', args: { command: 'npm test' }, result: 'Exit code: 1\nFAIL', toolCallId: 'c1' },
            ]);

            const handoff = buildHandoff(messages, 1);

            expect(handoff.remainingWork).toContain('npm test');
            expect(handoff.remainingWork).toContain('exit 1');
        });

        it('returns empty arrays for no-tool-call history', () => {
            const messages = [new HumanMessage('implement Board')];

            const handoff = buildHandoff(messages, 1);

            expect(handoff.filesWritten).toEqual([]);
            expect(handoff.commandsRun).toEqual([]);
            expect(handoff.generation).toBe(1);
        });

        it('handles empty messages array', () => {
            const handoff = buildHandoff([], 1);

            expect(handoff.filesWritten).toEqual([]);
            expect(handoff.commandsRun).toEqual([]);
            expect(handoff.keyFindings).toEqual([]);
        });

        it('sets generation correctly', () => {
            const handoff = buildHandoff([], 3);
            expect(handoff.generation).toBe(3);
        });

        it('parses exit code from "exited with N" pattern', () => {
            const messages = buildSyntheticHistory([
                { toolName: 'run_command', args: { command: 'make build' }, result: 'Process exited with 2', toolCallId: 'c1' },
            ]);

            const handoff = buildHandoff(messages, 1);
            expect(handoff.commandsRun[0].exitCode).toBe(2);
        });

        it('infers non-zero exit for error output without explicit exit code', () => {
            const messages = buildSyntheticHistory([
                { toolName: 'run_command', args: { command: 'npm test' }, result: 'Error: module not found', toolCallId: 'c1' },
            ]);

            const handoff = buildHandoff(messages, 1);
            expect(handoff.commandsRun[0].exitCode).toBe(1);
        });
    });

    describe('renderHandoff', () => {
        it('renders a compact handoff string', () => {
            const handoff = buildHandoff(
                buildSyntheticHistory([
                    { toolName: 'write_file', args: { filePath: 'src/Board.tsx', content: 'code' }, result: 'written', toolCallId: 'w1' },
                    { toolName: 'write_file', args: { filePath: 'src/Board.test.tsx', content: 'test' }, result: 'written', toolCallId: 'w2' },
                    { toolName: 'run_command', args: { command: 'npm test' }, result: 'Exit code: 1\nFAIL', toolCallId: 'c1' },
                ]),
                1,
            );

            const rendered = renderHandoff(handoff);

            expect(rendered).toContain('Handoff from generation 1');
            expect(rendered).toContain('src/Board.tsx');
            expect(rendered).toContain('src/Board.test.tsx');
            expect(rendered).toContain('npm test');
            expect(rendered).toContain('Do NOT re-read');
        });

        it('stays under 1200 chars for a 30-tool-call history', () => {
            const messages = buildLargeHistory();
            const handoff = buildHandoff(messages, 1);
            const rendered = renderHandoff(handoff);

            expect(rendered.length).toBeLessThan(1200);
        });

        it('shows (none) when no files were written', () => {
            const handoff = buildHandoff(
                buildSyntheticHistory([
                    { toolName: 'read_file', args: { filePath: 'src/App.tsx' }, result: 'content', toolCallId: 'r1' },
                ]),
                1,
            );

            const rendered = renderHandoff(handoff);
            expect(rendered).toContain('(none)');
        });

        it('shows only the last 5 commands', () => {
            const rounds = [];
            for (let i = 0; i < 10; i++) {
                rounds.push({
                    toolName: 'run_command' as const,
                    args: { command: `cmd-${i}` },
                    result: `Exit code: 0\nok`,
                    toolCallId: `c-${i}`,
                });
            }
            const messages = buildSyntheticHistory(rounds);
            const handoff = buildHandoff(messages, 1);
            const rendered = renderHandoff(handoff);

            // Should show cmd-5 through cmd-9 (last 5)
            expect(rendered).toContain('cmd-5');
            expect(rendered).toContain('cmd-9');
            // Should NOT show cmd-0 through cmd-4
            expect(rendered).not.toContain('cmd-0');
            expect(rendered).not.toContain('cmd-4');
        });
    });
});

// ─── Worktree verification, reconnaissance, and progress gate (Plan 22 C1-C3) ─

describe('Respawn Handoff (Plan 22 C1-C3)', () => {
    let repo: string;

    function aiTurn(calls: { name: string; args: any; id: string }[], text = ''): BaseMessage[] {
        return [
            new AIMessage({
                content: text,
                tool_calls: calls.map(c => ({ ...c, type: 'tool_call' as const })),
            }),
            ...calls.map(c => new ToolMessage({ content: 'ok', tool_call_id: c.id, name: c.name })),
        ];
    }

    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'adt-handoff-'));
        const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: repo, stdio: 'pipe' });
        git('init -q');
        git('config user.email test@example.com');
        git('config user.name Test');
        fs.writeFileSync(path.join(repo, 'README.md'), '# base\n');
        git('add .');
        git('commit -q -m base');
    });

    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

    describe('buildHandoff worktree verification (Plan 22 C1)', () => {
        it('reports worktreeVerified with real byte sizes when given a worktree', () => {
            fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 1;\n');

            const messages = [new HumanMessage('task'), ...aiTurn([
                { name: 'write_file', args: { filePath: 'src/a.ts', content: 'export const a = 1;\n' }, id: 'w1' },
            ])];

            const handoff = buildHandoff(messages, 1, repo, 'HEAD');

            expect(handoff.worktreeVerified).toBe(true);
            const found = handoff.filesWritten.find(f => f.path === 'src/a.ts');
            expect(found).toBeDefined();
            expect(found!.bytes).toBe(20);
        });

        it('overrides an agent claim that does not exist on disk', () => {
            fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repo, 'src/real.ts'), 'export const r = 1;\n');

            const messages = [new HumanMessage('task'), ...aiTurn([
                { name: 'write_file', args: { filePath: 'src/real.ts', content: 'x' }, id: 'w1' },
                { name: 'write_file', args: { filePath: 'src/phantom.ts', content: 'x' }, id: 'w2' },
            ])];

            const handoff = buildHandoff(messages, 1, repo, 'HEAD');

            expect(handoff.filesWritten.map(f => f.path)).toEqual(['src/real.ts']);
        });
    });

    describe('handoff carries reconnaissance forward (Plan 22 C2)', () => {
        it('records every file the previous generation read', () => {
            const messages = [new HumanMessage('task'), ...aiTurn([
                { name: 'read_file', args: { filePath: 'src/main.ts' }, id: 'r1' },
                { name: 'read_file', args: { filePath: 'src/game/GameLoop.ts' }, id: 'r2' },
                { name: 'list_dir', args: { dirPath: 'src' }, id: 'r3' },
                { name: 'search_code', args: { query: 'ScoreManager' }, id: 'r4' },
            ])];

            const handoff = buildHandoff(messages, 1, repo, 'HEAD');

            expect(handoff.filesRead).toEqual([
                'src/main.ts', 'src/game/GameLoop.ts', 'src', 'search: ScoreManager',
            ]);
        });

        it('deduplicates repeated reads', () => {
            const messages = [new HumanMessage('task'), ...aiTurn([
                { name: 'read_file', args: { filePath: 'src/a.ts' }, id: 'r1' },
                { name: 'read_file', args: { filePath: 'src/a.ts' }, id: 'r2' },
            ])];
            expect(buildHandoff(messages, 1).filesRead).toEqual(['src/a.ts']);
        });

        it('includes a git ls-files tree snapshot', () => {
            fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repo, 'src/a.ts'), 'a');
            execSync('git add . && git -c user.email=t@e -c user.name=T commit -q -m add', { cwd: repo, stdio: 'pipe' });

            const handoff = buildHandoff([new HumanMessage('task')], 1, repo, 'HEAD');

            expect(handoff.treeSnapshot).toContain('README.md');
            expect(handoff.treeSnapshot).toContain('src/a.ts');
        });

        it('renders the reconnaissance, tree and spent budget for the successor', () => {
            const messages = [new HumanMessage('task'), ...aiTurn([
                { name: 'read_file', args: { filePath: 'src/main.ts' }, id: 'r1' },
            ])];
            const handoff = buildHandoff(messages, 2, repo, 'HEAD', {
                reads: 28, writes: 1, shell: 0, turns: 6,
            });

            const rendered = renderHandoff(handoff);

            expect(rendered).toContain('Already inspected');
            expect(rendered).toContain('src/main.ts');
            expect(rendered).toContain('README.md');
            expect(rendered).toContain('reads 28, writes 1, shell 0, turns 6');
            expect(rendered).toContain('Reconnaissance is already paid for');
        });
    });

    describe('madeProgress (Plan 22 C3)', () => {
        it('is true when files were written', () => {
            const messages = [new HumanMessage('t'), ...aiTurn([
                { name: 'write_file', args: { filePath: 'a.ts', content: 'x' }, id: 'w1' },
            ])];
            expect(madeProgress(buildHandoff(messages, 1))).toBe(true);
        });

        it('is true when a build/test command passed without any writes', () => {
            const messages: BaseMessage[] = [
                new HumanMessage('t'),
                new AIMessage({
                    content: '',
                    tool_calls: [{ id: 'c1', name: 'run_command', args: { command: 'npm run build' }, type: 'tool_call' }],
                }),
                new ToolMessage({ content: 'Exit code: 0\nbuilt', tool_call_id: 'c1', name: 'run_command' }),
            ];
            const handoff = buildHandoff(messages, 1);
            expect(handoff.filesWritten).toHaveLength(0);
            expect(madeProgress(handoff)).toBe(true);
        });

        it('is false for a pure-reconnaissance generation', () => {
            const reads = Array.from({ length: 24 }, (_, i) => ({
                name: 'read_file', args: { filePath: `src/f${i}.ts` }, id: `r${i}`,
            }));
            const messages = [new HumanMessage('t'), ...aiTurn(reads)];
            const handoff = buildHandoff(messages, 1);

            expect(handoff.filesWritten).toHaveLength(0);
            expect(handoff.filesRead).toHaveLength(24);
            expect(madeProgress(handoff)).toBe(false);
        });

        it('is false when a command ran but failed', () => {
            const messages: BaseMessage[] = [
                new HumanMessage('t'),
                new AIMessage({
                    content: '',
                    tool_calls: [{ id: 'c1', name: 'run_command', args: { command: 'npm test' }, type: 'tool_call' }],
                }),
                new ToolMessage({ content: 'Exit code: 1\nFAIL', tool_call_id: 'c1', name: 'run_command' }),
            ];
            expect(madeProgress(buildHandoff(messages, 1))).toBe(false);
        });
    });
});
