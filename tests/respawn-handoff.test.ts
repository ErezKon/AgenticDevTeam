/**
 * Respawn handoff — worktree verification, carried-forward reconnaissance and
 * the progress gate (Plan 22, C1–C3).
 *
 * ## The bug these tests pin
 *
 * `pr-workflow.ts` called `buildHandoff(result.messages, gen + 1)` with no
 * worktree, so `worktreeVerified` was always false, `filesWritten` was the agent's
 * *claim*, and the handoff contained no file inventory or tree. Every respawn
 * generation therefore restarted reconnaissance from zero — dumps 019/020/021 each
 * re-read the same 24 files, and two of them exhausted their budget before writing
 * anything, at which point the `filesWritten.length === 0` gate killed them even
 * though the branch had committed work.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { buildHandoff, renderHandoff, madeProgress } from '../src/conductor/agent-respawn';

// ─── Fixture: a real git worktree ───────────────────────────────────────────

let repo: string;

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

function aiTurn(calls: { name: string; args: any; id: string }[], text = ''): BaseMessage[] {
    return [
        new AIMessage({
            content: text,
            tool_calls: calls.map(c => ({ ...c, type: 'tool_call' as const })),
        }),
        ...calls.map(c => new ToolMessage({ content: 'ok', tool_call_id: c.id, name: c.name })),
    ];
}

// ─── C1: worktree verification ──────────────────────────────────────────────

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

    it('leaves worktreeVerified false when no worktree is passed — the old behaviour', () => {
        const messages = [new HumanMessage('task'), ...aiTurn([
            { name: 'write_file', args: { filePath: 'src/a.ts', content: 'x' }, id: 'w1' },
        ])];

        const handoff = buildHandoff(messages, 1);

        expect(handoff.worktreeVerified).toBe(false);
        expect(handoff.treeSnapshot).toEqual([]);
        // filesWritten is the agent's unverified claim
        expect(handoff.filesWritten[0].bytes).toBeUndefined();
    });

    it('overrides an agent claim that does not exist on disk', () => {
        // Agent claims two files; only one is real.
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

// ─── C2: carried-forward reconnaissance ─────────────────────────────────────

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
        expect(rendered).toContain('README.md');            // tree snapshot
        expect(rendered).toContain('reads 28, writes 1, shell 0, turns 6');
        expect(rendered).toContain('Reconnaissance is already paid for');
    });
});

// ─── C3: progress gate ──────────────────────────────────────────────────────

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

    it('is false for a pure-reconnaissance generation — the 019/021 shape', () => {
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
