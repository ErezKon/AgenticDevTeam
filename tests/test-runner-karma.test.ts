/**
 * Plan 30-03 steps 2–4 — Karma detection, the wrapper config and its agentjson
 * reporter, the Karma command, results parsing (JSON report and rendered-output
 * fallback), and runTests: install before the suite, exit 127, the Karma paths
 * and the `unknown` framework. Commands are not executed: `execCapture` is mocked.
 */
jest.mock('../src/utils/logger');
jest.mock('../src/utils/shell-exec', () => ({
    ...jest.requireActual('../src/utils/shell-exec'),
    execCapture: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';
import { makeTempDir, cleanupDir } from './helpers/tmp';
import { execCapture } from '../src/utils/shell-exec';
import { detectNodeFramework, runTests } from '../src/conductor/test-runner';
import {
    isKarmaProject, findKarmaConfig, prepareKarmaRun, renderKarmaWrapper,
    parseKarmaResults, parseKarmaOutput,
} from '../src/conductor/test-runners/karma';
import type { StackRoot } from '../src/conductor/quality-gates';

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'plan30', 'karma-stdout-seq2273.json'), 'utf-8'));
const KARMA_STDOUT: string = fixture.stdoutLines.join('\n');
const NG_TEST = 'ng test --watch=false --browsers=ChromeHeadless';
const INSTALL = 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund';
const KARMA_CONF = 'module.exports = function (config) { config.set({}); };';

let dir: string;      // the project
let reports: string;  // the run's test-report directory (outside the project)
beforeEach(() => {
    dir = makeTempDir('karma-project-');
    reports = makeTempDir('karma-reports-');
});
afterEach(() => {
    cleanupDir(dir);
    cleanupDir(reports);
});

function write(file: string, content: string | object): void {
    const abs = path.join(dir, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content));
}

const angularJson = (testBuilder: string, options: Record<string, unknown> = {}) => ({
    projects: { app: { architect: { test: { builder: testBuilder, options } } } },
});

// ─── Detection (step 2) ─────────────────────────────────────────────────────

describe('detectNodeFramework', () => {
    it('treats ng test on a Karma builder — or with no angular.json test target — as karma', () => {
        expect(detectNodeFramework(NG_TEST, dir, {})).toBe('karma');
        write('angular.json', angularJson('@angular-devkit/build-angular:karma'));
        expect(detectNodeFramework(NG_TEST, dir, {})).toBe('karma');
    });

    it('treats a karma start script or a karma.conf.* file as karma', () => {
        expect(detectNodeFramework('karma start karma.conf.js --single-run', dir, {})).toBe('karma');
        write('karma.conf.cjs', KARMA_CONF);
        expect(detectNodeFramework('node run-tests.js', dir, {})).toBe('karma');
    });

    it('does not treat ng test on a Jest builder as Karma', () => {
        write('angular.json', angularJson('@angular-builders/jest:run'));
        expect(isKarmaProject(NG_TEST, dir)).toBe(false);
        expect(detectNodeFramework(NG_TEST, dir, { devDependencies: { jest: '^29.7.0' } })).toBe('jest');
    });

    it('uses Jest only when Jest is configured or a dependency, otherwise unknown', () => {
        expect(detectNodeFramework('node scripts/test.js', dir, {})).toBe('unknown');
        expect(detectNodeFramework('node scripts/test.js', dir, { devDependencies: { jest: '^29.7.0' } })).toBe('jest');
        expect(detectNodeFramework('node scripts/test.js', dir, { jest: { testEnvironment: 'node' } })).toBe('jest');
        expect(detectNodeFramework('react-scripts test', dir, {})).toBe('jest');
        write('jest.config.js', 'module.exports = {};');
        expect(detectNodeFramework('node scripts/test.js', dir, {})).toBe('jest');
    });

    it('still recognises vitest and mocha scripts', () => {
        expect(detectNodeFramework('vitest run', dir, {})).toBe('vitest');
        expect(detectNodeFramework('mocha "test/**/*.spec.js"', dir, {})).toBe('mocha');
    });
});

describe('findKarmaConfig', () => {
    it('prefers angular.json karmaConfig, then a karma start argument, then karma.conf.*', () => {
        write('karma.conf.js', KARMA_CONF);
        write('config/karma.ci.js', KARMA_CONF);
        expect(findKarmaConfig(dir, NG_TEST)).toBe(path.join(dir, 'karma.conf.js'));
        expect(findKarmaConfig(dir, 'karma start config/karma.ci.js --single-run')).toBe(path.join(dir, 'config/karma.ci.js'));
        write('angular.json', angularJson('@angular-devkit/build-angular:karma', { karmaConfig: 'config/karma.ci.js' }));
        expect(findKarmaConfig(dir, NG_TEST)).toBe(path.join(dir, 'config/karma.ci.js'));
    });
});

// ─── Command and wrapper (step 3) ───────────────────────────────────────────

describe('prepareKarmaRun', () => {
    const wrapperPath = (): string => path.join(reports, 'karma.agent.conf.cjs');

    it('ng test: writes the wrapper outside the project and points --karma-config at it', () => {
        write('karma.conf.js', KARMA_CONF);
        const plan = prepareKarmaRun({ rootDir: dir, testScript: NG_TEST, reportDir: reports, withCoverage: true });

        // karma-coverage is not installed, so no --code-coverage
        expect(plan.command).toBe(`npm test -- --karma-config='${wrapperPath()}' --watch=false`);
        expect(plan.resultsFile).toBe(path.join(reports, 'karma-results.json'));
        const source = fs.readFileSync(wrapperPath(), 'utf-8');
        expect(source).toContain(`const PROJECT_CONFIG = ${JSON.stringify(path.join(dir, 'karma.conf.js'))};`);
        expect(source).toContain('const COVERAGE_DIR = null;');
        expect(fs.readdirSync(dir)).toEqual(['karma.conf.js']);
    });

    it('requests coverage when karma-coverage is installed', () => {
        write('karma.conf.js', KARMA_CONF);
        write('node_modules/karma-coverage/package.json', '{}');
        const plan = prepareKarmaRun({ rootDir: dir, testScript: NG_TEST, reportDir: reports, withCoverage: true });
        expect(plan.command).toBe(`npm test -- --karma-config='${wrapperPath()}' --watch=false --code-coverage`);
        expect(fs.readFileSync(wrapperPath(), 'utf-8')).toContain(`const COVERAGE_DIR = ${JSON.stringify(reports)};`);
    });

    it('karma start: runs the wrapper in single-run mode and keeps the script\'s browsers', () => {
        write('karma.conf.js', KARMA_CONF);
        const plan = prepareKarmaRun({
            rootDir: dir, testScript: 'karma start karma.conf.js --browsers ChromeHeadless', reportDir: reports, withCoverage: false,
        });
        expect(plan.command).toBe(`npx --no-install karma start '${wrapperPath()}' --single-run --browsers ChromeHeadless`);
    });

    it('reproduces Angular\'s built-in config for the classic karma builder without a config file', () => {
        write('angular.json', angularJson('@angular-devkit/build-angular:karma'));
        const plan = prepareKarmaRun({ rootDir: dir, testScript: NG_TEST, reportDir: reports, withCoverage: false });
        expect(plan.resultsFile).not.toBeNull();
        expect(fs.readFileSync(wrapperPath(), 'utf-8')).toContain('const PROJECT_CONFIG = null;');
    });

    it('runs the project\'s own script when the setup cannot be wrapped safely', () => {
        write('karma.conf.ts', 'export default () => {};');
        expect(prepareKarmaRun({ rootDir: dir, testScript: NG_TEST, reportDir: reports, withCoverage: true }))
            .toEqual({ command: 'npm test -- --watch=false', resultsFile: null });
        expect(prepareKarmaRun({ rootDir: dir, testScript: 'karma start karma.conf.ts', reportDir: reports, withCoverage: false }))
            .toEqual({ command: 'npm test -- --single-run', resultsFile: null });
        expect(prepareKarmaRun({ rootDir: dir, testScript: 'ng test --karma-config=karma.conf.ts', reportDir: reports, withCoverage: false }).resultsFile)
            .toBeNull();

        cleanupDir(dir);
        fs.mkdirSync(dir);
        write('package.json', { type: 'module' });
        write('karma.conf.js', 'export default function (config) {}');
        expect(prepareKarmaRun({ rootDir: dir, testScript: NG_TEST, reportDir: reports, withCoverage: false }).resultsFile).toBeNull();
    });
});

describe('the wrapper config and its agentjson reporter', () => {
    /** Karma's `config` object, reduced to its defaults and `set()` (the wrapper always passes whole values). */
    function karmaConfig(): any {
        const config: any = { plugins: ['karma-*'], reporters: ['progress'], browsers: [] };
        config.set = (patch: Record<string, unknown>) => Object.assign(config, patch);
        return config;
    }

    /** Write a project config and the wrapper around it, then load the wrapper as Karma would. */
    function loadWrapper(coverageDir: string | null): (config: any) => unknown {
        write('karma.conf.cjs', `module.exports = function (config) {
  config.set({
    frameworks: ['jasmine'],
    plugins: ['karma-jasmine', { 'reporter:coverage': ['type', function () {}] }],
    reporters: ['progress', 'kjhtml'],
    browsers: ['ChromeHeadless'],
    coverageReporter: { dir: 'coverage/app', reporters: [{ type: 'html' }] },
  });
};`);
        const wrapper = path.join(reports, 'karma.agent.conf.cjs');
        fs.writeFileSync(wrapper, renderKarmaWrapper({
            projectConfig: path.join(dir, 'karma.conf.cjs'), projectDir: dir,
            resultsFile: path.join(reports, 'karma-results.json'), coverageDir,
        }));
        return require(wrapper);
    }

    it('loads the project config, forces a single run, and adds agentjson plus json-summary coverage', () => {
        jest.spyOn(process, 'getuid').mockReturnValue(1000);
        const config = karmaConfig();
        loadWrapper(reports)(config);

        expect(config.frameworks).toEqual(['jasmine']);
        expect(config).toMatchObject({ singleRun: true, autoWatch: false, restartOnFileChange: false });
        expect(config.reporters).toEqual(['progress', 'kjhtml', 'agentjson', 'coverage']);
        expect(config.browsers).toEqual(['ChromeHeadless']);
        expect(config.coverageReporter).toEqual({
            dir: reports, subdir: '.',
            reporters: [{ type: 'html' }, { type: 'json-summary', file: 'coverage-summary.json' }],
        });
        expect(config.plugins[config.plugins.length - 1]).toHaveProperty('reporter:agentjson');
    });

    it('adds a no-sandbox ChromeHeadless launcher only when running as root', () => {
        jest.spyOn(process, 'getuid').mockReturnValue(0);
        const config = karmaConfig();
        loadWrapper(null)(config);

        expect(config.browsers).toEqual(['ChromeHeadlessNoSandbox']);
        expect(config.customLaunchers.ChromeHeadlessNoSandbox).toEqual({ base: 'ChromeHeadless', flags: ['--no-sandbox'] });
        // no coverage directory: the project's coverage set-up is left alone
        expect(config.reporters).toEqual(['progress', 'kjhtml', 'agentjson']);
        expect(config.coverageReporter.dir).toBe('coverage/app');
    });

    it('the reporter writes karma-results.json, which parses into tagged cases', () => {
        jest.spyOn(process, 'getuid').mockReturnValue(1000);
        const config = karmaConfig();
        loadWrapper(null)(config);
        const [, Reporter] = config.plugins[config.plugins.length - 1]['reporter:agentjson'];
        const reporter = new Reporter();
        reporter.onSpecComplete({}, {
            suite: ['ScoreStorageService', 'saveHighScore'], description: '[US-027#1] should truncate the list to top 10 scores',
            success: false, log: ['Expected 910 to be 860.'], time: 3,
        });
        reporter.onSpecComplete({}, { suite: ['AppComponent'], description: '[US-001#0] renders the maze', success: true, log: [], time: 1 });
        reporter.onSpecComplete({}, { suite: ['AppComponent'], description: 'is pending', success: true, skipped: true, log: [], time: 0 });
        reporter.onRunComplete([], { success: 1, failed: 1, skipped: 1, error: false, disconnected: false });

        const parsed = parseKarmaResults(fs.readFileSync(path.join(reports, 'karma-results.json'), 'utf-8'), '');
        expect(parsed).toMatchObject({ framework: 'karma', total: 3, passed: 1, failed: 1, skipped: 1, untracedTests: 0 });
        expect(parsed.cases[0]).toMatchObject({
            testName: 'ScoreStorageService > saveHighScore > [US-027#1] should truncate the list to top 10 scores',
            status: 'fail', storyId: 'US-027', acIndex: 1, error: 'Expected 910 to be 860.',
        });
        expect(parsed.cases[1]).toMatchObject({ status: 'pass', storyId: 'US-001', acIndex: 0 });
        expect(parsed.cases[2]).toMatchObject({ status: 'skip' });
    });
});

describe('parseKarmaOutput (fallback without karma-results.json)', () => {
    it('reads the totals from the last Executed line when there is no TOTAL line', () => {
        const parsed = parseKarmaOutput('HeadlessChrome 120.0.0.0 (Linux x86_64): Executed 10 of 12 (2 FAILED) (skipped 2) ERROR (1 sec / 0.9 secs)', '');
        expect(parsed).toMatchObject({ framework: 'karma', total: 12, passed: 8, failed: 2, skipped: 2, caseNames: 'unavailable' });
    });

    it('returns null when the output has no Karma totals', () => {
        expect(parseKarmaOutput("Error: Cannot find module 'karma'", '')).toBeNull();
    });
});

// ─── runTests (steps 3–4) ───────────────────────────────────────────────────

describe('runTests', () => {
    const exec = execCapture as jest.Mock;
    const root = (): StackRoot => ({ dir, relDir: '', stack: 'node', isWorkspaceMember: false });
    const opts = () => ({ timeoutMs: 60_000, withCoverage: false, reportDir: reports });
    const resultsFile = (): string => path.join(reports, 'root', 'karma-results.json');

    /** node_modules/.package-lock.json newer than package.json and package-lock.json: the install is skipped. */
    function freshNodeModules(): void {
        const past = new Date(Date.now() - 60_000);
        fs.utimesSync(path.join(dir, 'package.json'), past, past);
        write('node_modules/.package-lock.json', '{}');
    }

    beforeEach(() => exec.mockReset());

    it('installs dependencies before running the suite when node_modules is missing', async () => {
        write('package.json', { scripts: { test: 'node run-tests.js' } });
        exec.mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });

        const report = await runTests(root(), opts());

        expect(exec.mock.calls.map(call => call[0])).toEqual([INSTALL, 'npm test']);
        expect(report).toMatchObject({ framework: 'unknown', command: 'npm test', exitCode: 0, runnerError: false, caseNames: 'unavailable' });
    });

    it('skips the install when node_modules is up to date', async () => {
        write('package.json', { scripts: { test: 'node run-tests.js' } });
        freshNodeModules();
        exec.mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });

        await runTests(root(), opts());

        expect(exec.mock.calls.map(call => call[0])).toEqual(['npm test']);
    });

    it('leaves an npm workspace member to its workspace root\'s install', async () => {
        write('package.json', { scripts: { test: 'node run-tests.js' } });
        exec.mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });

        await runTests({ ...root(), relDir: 'packages/web', isWorkspaceMember: true }, opts());

        expect(exec.mock.calls.map(call => call[0])).toEqual(['npm test']);
    });

    it('reports a failed install as the runner error, with the install command and its output', async () => {
        write('package.json', { scripts: { test: NG_TEST } });
        exec.mockResolvedValueOnce({ stdout: '', stderr: 'npm ERR! code ERESOLVE\nnpm ERR! could not resolve dependency', exitCode: 1 });

        const report = await runTests(root(), opts());

        expect(exec).toHaveBeenCalledTimes(1);
        expect(report).toMatchObject({ command: INSTALL, exitCode: 1, runnerError: true });
        expect(report.runnerErrorDetail).toContain('dependency install failed (exit 1)');
        expect(report.runnerErrorDetail).toContain('npm ERR! code ERESOLVE');
    });

    it('reports exit 127 as a missing command', async () => {
        write('package.json', { scripts: { test: NG_TEST } });
        freshNodeModules();
        exec.mockResolvedValue({ stdout: `\n> app@0.0.0 test\n> ${NG_TEST}\n`, stderr: 'sh: 1: ng: not found\n', exitCode: 127 });

        const report = await runTests(root(), opts());

        expect(report).toMatchObject({ framework: 'karma', command: 'npm test -- --watch=false', exitCode: 127, runnerError: true });
        expect(report.runnerErrorDetail).toMatch(/^command not found: ng — dependencies not installed\?/);
    });

    it('karma: parses the agentjson report written during the run', async () => {
        write('package.json', { scripts: { test: NG_TEST } });
        write('karma.conf.js', KARMA_CONF);
        freshNodeModules();
        exec.mockImplementation(async () => {
            fs.writeFileSync(resultsFile(), JSON.stringify({
                total: 2, success: 1, failed: 1, skipped: 0, error: false, cases: [
                    { suite: 'Score', description: '[US-027#1] truncates to 10', success: false, skipped: false, time: 2, log: ['Expected 910 to be 860.'] },
                    { suite: 'Score', description: '[US-027#0] persists', success: true, skipped: false, time: 1, log: [] },
                ],
            }));
            return { stdout: KARMA_STDOUT, stderr: '', exitCode: 1 };
        });

        const report = await runTests(root(), opts());

        const command = exec.mock.calls[0][0];
        expect(command).toBe(`npm test -- --karma-config='${path.join(reports, 'root', 'karma.agent.conf.cjs')}' --watch=false`);
        expect(report).toMatchObject({ framework: 'karma', command, total: 2, passed: 1, failed: 1, exitCode: 1, runnerError: false });
        expect(report.caseNames).toBeUndefined();
        expect(report.cases.map(c => `${c.storyId}#${c.acIndex}:${c.status}`)).toEqual(['US-027#1:fail', 'US-027#0:pass']);
    });

    it('karma: without the JSON report, the totals and the failed spec come from the rendered output', async () => {
        write('package.json', { scripts: { test: NG_TEST } });
        write('karma.conf.js', KARMA_CONF);
        freshNodeModules();
        exec.mockResolvedValue({ stdout: KARMA_STDOUT, stderr: '', exitCode: 1 });

        const report = await runTests(root(), opts());

        expect(report).toMatchObject({ framework: 'karma', total: 134, passed: 133, failed: 1, skipped: 0, runnerError: false, caseNames: 'unavailable' });
        expect(report.cases).toEqual([expect.objectContaining({
            suite: 'ScoreStorageService saveHighScore', storyId: 'US-027', acIndex: 1, status: 'fail',
            error: expect.stringContaining('Expected 910 to be 860.'),
        })]);
    });

    it('karma: a failed run with no failing spec is a runner error carrying the rendered output', async () => {
        write('package.json', { scripts: { test: NG_TEST } });
        write('karma.conf.js', KARMA_CONF);
        freshNodeModules();
        exec.mockResolvedValue({
            stdout: "\u001b[31mError: src/app/app.component.ts:3:5 - error TS2304: Cannot find name 'foo'.\u001b[39m\n", stderr: '', exitCode: 1,
        });

        const report = await runTests(root(), opts());

        expect(report).toMatchObject({ framework: 'karma', exitCode: 1, runnerError: true });
        expect(report.runnerErrorDetail).toContain("error TS2304: Cannot find name 'foo'.");
        expect(report.runnerErrorDetail).not.toContain('\u001b');
    });

    it('unknown runner: a non-zero exit is a runner error with the rendered output', async () => {
        write('package.json', { scripts: { test: 'node run-tests.js' } });
        freshNodeModules();
        exec.mockResolvedValue({ stdout: 'not ok 3 - adds numbers\n', stderr: '', exitCode: 1 });

        const report = await runTests(root(), opts());

        expect(report).toMatchObject({ framework: 'unknown', command: 'npm test', exitCode: 1, runnerError: true });
        expect(report.runnerErrorDetail).toContain('not ok 3 - adds numbers');
    });
});
