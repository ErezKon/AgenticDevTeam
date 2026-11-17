/**
 * Karma / Jasmine test runs (Plan 30-03).
 *
 * The claudeopus5 project tested with `ng test` (Karma), but runner detection
 * defaulted to Jest: QA ran `npm test -- --ci --json --outputFile … --coverage`,
 * Angular rejected the unknown arguments, and every round reported 0 tests plus
 * 60 derived false bugs.
 *
 * A Karma project now runs through a wrapper config written into the run's
 * test-report directory, never into the repository. The wrapper loads the
 * project's karma config (or reproduces Angular's built-in one), forces a single
 * run, keeps the project's browsers (adding a no-sandbox ChromeHeadless launcher
 * when running as root) and registers an inline `agentjson` reporter that writes
 * `karma-results.json`. When that file is missing, the totals and the failed spec
 * names are parsed from the rendered output (`caseNames: 'unavailable'`).
 * No new dependencies.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../../utils/logger';
import { readAngularTarget } from '../../utils/angular-workspace';
import { parseTraceTag, traceTagIndex, tallyCases, type ExecutedTestCase, type ParsedRun } from './executed-report';

const log = getLogger('[TestRunner]', 199);

const KARMA_CONFIG_NAMES = ['karma.conf.js', 'karma.conf.cjs', 'karma.conf.mjs', 'karma.conf.ts'];
const NG_TEST_RE = /\bng\s+test\b/;
const KARMA_START_RE = /\bkarma\s+start\b/;
/** The Angular builder whose built-in karma configuration the wrapper reproduces when there is no config file. */
const CLASSIC_KARMA_BUILDER = '@angular-devkit/build-angular:karma';
const RESULTS_FILE = 'karma-results.json';
const WRAPPER_FILE = 'karma.agent.conf.cjs';

// ─── Detection ──────────────────────────────────────────────────────────────

/**
 * Plan 30-03 step 2: the test script uses `ng test` (on a Karma builder, or with no
 * angular.json test target) or `karma`, a `karma.conf.*` exists, or the angular.json
 * test builder is Karma. `ng test` on another builder (Jest, unit-test) is not Karma.
 */
export function isKarmaProject(testScript: string, rootDir: string): boolean {
    const builder = readAngularTarget(rootDir, 'test')?.builder ?? '';
    if (NG_TEST_RE.test(testScript)) return !builder || /karma/.test(builder);
    return /\bkarma\b/.test(testScript) || /karma/.test(builder)
        || KARMA_CONFIG_NAMES.some(name => fs.existsSync(path.join(rootDir, name)));
}

/** The project's karma config: angular.json's `test.options.karmaConfig`, a `karma start <file>` argument, or `karma.conf.*`. */
export function findKarmaConfig(rootDir: string, testScript: string): string | null {
    const fromAngular = readAngularTarget(rootDir, 'test')?.options?.karmaConfig;
    const fromScript = /\bkarma\s+start\s+([^\s-]\S*)/.exec(testScript)?.[1];
    for (const candidate of [fromAngular, fromScript, ...KARMA_CONFIG_NAMES]) {
        if (typeof candidate !== 'string' || !candidate) continue;
        const file = path.resolve(rootDir, candidate);
        if (fs.existsSync(file)) return file;
    }
    return null;
}

// ─── Wrapper config ─────────────────────────────────────────────────────────

export interface KarmaWrapperOptions {
    /** Absolute path of the project's karma config; null reproduces Angular's built-in configuration. */
    projectConfig: string | null;
    projectDir: string;
    resultsFile: string;
    /** Where the json-summary coverage report goes; null leaves coverage untouched. */
    coverageDir: string | null;
}

/** The wrapper's body: plain CommonJS (no template literals), so any Node version and package type can load it. */
const WRAPPER_BODY = `
// Writes RESULTS_FILE: Karma's totals plus one entry per spec.
function AgentJsonReporter() {
  const cases = [];
  let browserError = false;
  this.adapters = [];
  this.onBrowserError = function () { browserError = true; };
  this.onSpecComplete = function (browser, result) {
    cases.push({
      suite: (result.suite || []).join(' > '),
      description: String(result.description),
      success: !!result.success,
      skipped: !!(result.skipped || result.disabled || result.pending),
      time: result.time || 0,
      log: (result.log || []).map(String),
    });
  };
  this.onRunComplete = function (browsers, results) {
    fs.writeFileSync(RESULTS_FILE, JSON.stringify({
      total: results.success + results.failed + results.skipped,
      success: results.success,
      failed: results.failed,
      skipped: results.skipped,
      error: browserError || !!results.error || !!results.disconnected,
      cases: cases,
    }));
  };
}

// Angular's built-in karma configuration, for workspaces without a karma config file.
function angularBuiltInConfig(config) {
  const projectRequire = createRequire(path.join(PROJECT_DIR, 'package.json'));
  const optional = function (name) {
    try { return [projectRequire(name)]; } catch (e) { return []; }
  };
  config.set({
    basePath: '',
    frameworks: ['jasmine', '@angular-devkit/build-angular'],
    plugins: [projectRequire('karma-jasmine'), projectRequire('karma-chrome-launcher')]
      .concat(optional('karma-jasmine-html-reporter'), optional('karma-coverage'))
      .concat([projectRequire('@angular-devkit/build-angular/plugins/karma')]),
    jasmineHtmlReporter: { suppressAll: true },
    coverageReporter: { dir: path.join(PROJECT_DIR, 'coverage'), subdir: '.', reporters: [{ type: 'html' }, { type: 'text-summary' }] },
    reporters: ['progress'],
    browsers: ['Chrome'],
  });
}

function hasPlugin(plugins, provider) {
  const name = provider.split(':')[1];
  return (plugins || []).some(function (p) {
    if (typeof p === 'string') return p === 'karma-*' || p.indexOf(name) !== -1;
    return p !== null && typeof p === 'object' && Object.prototype.hasOwnProperty.call(p, provider);
  });
}

function finalize(config) {
  const reporters = (config.reporters || []).filter(function (r) { return r !== 'agentjson'; }).concat(['agentjson']);
  if (COVERAGE_DIR && hasPlugin(config.plugins, 'reporter:coverage')) {
    const coverage = config.coverageReporter || {};
    config.set({ coverageReporter: Object.assign({}, coverage, {
      dir: COVERAGE_DIR,
      subdir: '.',
      reporters: (coverage.reporters || []).concat([{ type: 'json-summary', file: 'coverage-summary.json' }]),
    }) });
    if (reporters.indexOf('coverage') === -1) reporters.push('coverage');
  }
  config.set({
    singleRun: true,
    autoWatch: false,
    restartOnFileChange: false,
    reporters: reporters,
    plugins: (config.plugins || ['karma-*']).concat([{ 'reporter:agentjson': ['type', AgentJsonReporter] }]),
  });
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    config.set({
      customLaunchers: Object.assign({}, config.customLaunchers, {
        ChromeHeadlessNoSandbox: { base: 'ChromeHeadless', flags: ['--no-sandbox'] },
      }),
      browsers: (config.browsers || []).map(function (b) { return b === 'ChromeHeadless' ? 'ChromeHeadlessNoSandbox' : b; }),
    });
  }
}

module.exports = function (config) {
  if (!PROJECT_CONFIG) {
    angularBuiltInConfig(config);
    return finalize(config);
  }
  let projectConfig = require(PROJECT_CONFIG);
  if (projectConfig && typeof projectConfig !== 'function' && typeof projectConfig.default === 'function') {
    projectConfig = projectConfig.default;
  }
  const returned = projectConfig(config);
  if (returned && typeof returned.then === 'function') return returned.then(function () { finalize(config); });
  finalize(config);
};
`;

/** Source of the wrapper config for one run. */
export function renderKarmaWrapper(o: KarmaWrapperOptions): string {
    return [
        '// Generated by AgenticDevTeam (Plan 30-03) for one QA test run. It lives outside the',
        '// repository: it loads the project karma config and adds the agentjson reporter.',
        "'use strict';",
        "const fs = require('fs');",
        "const path = require('path');",
        "const { createRequire } = require('module');",
        `const PROJECT_DIR = ${JSON.stringify(o.projectDir)};`,
        `const PROJECT_CONFIG = ${JSON.stringify(o.projectConfig)};`,
        `const RESULTS_FILE = ${JSON.stringify(o.resultsFile)};`,
        `const COVERAGE_DIR = ${JSON.stringify(o.coverageDir)};`,
        WRAPPER_BODY,
    ].join('\n');
}

/** Loadable with `require()` from the CommonJS wrapper: `.cjs`, or `.js` outside a `"type": "module"` package. */
function isRequirable(file: string, rootDir: string): boolean {
    if (file.endsWith('.cjs')) return true;
    if (!file.endsWith('.js')) return false;
    try {
        return JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8')).type !== 'module';
    } catch {
        return true; // no readable package.json: Node loads .js as CommonJS
    }
}

/**
 * What the wrapper loads: `{ projectConfig: <path> }`, or `{ projectConfig: null }` for Angular's
 * built-in configuration (classic karma builder, no config file). Null when the setup cannot be
 * wrapped safely: the script is neither `ng test` nor `karma start`, it already passes
 * `--karma-config`, the config is ESM or TypeScript, or there is no config file and the builder
 * is not the classic one.
 */
function wrapTarget(rootDir: string, testScript: string): { projectConfig: string | null } | null {
    const ngTest = NG_TEST_RE.test(testScript);
    if ((!ngTest && !KARMA_START_RE.test(testScript)) || /--karma-config\b/.test(testScript)) return null;
    const config = findKarmaConfig(rootDir, testScript);
    if (config) return isRequirable(config, rootDir) ? { projectConfig: config } : null;
    return ngTest && readAngularTarget(rootDir, 'test')?.builder === CLASSIC_KARMA_BUILDER ? { projectConfig: null } : null;
}

// ─── Command ────────────────────────────────────────────────────────────────

export interface KarmaRunPlan {
    command: string;
    /** Where the agentjson reporter writes; null when the project's own script runs unwrapped. */
    resultsFile: string | null;
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The Karma command for one root (Plan 30-03 step 3):
 *   `ng test` script     → `npm test -- --karma-config=<wrapper> --watch=false [--code-coverage]`
 *   `karma start` script → `npx --no-install karma start <wrapper> --single-run [--browsers <script's>]`
 * Coverage is requested only when karma-coverage is installed. A setup that cannot be wrapped runs
 * the project's own script in single-run mode; its rendered output is parsed instead.
 */
export function prepareKarmaRun(o: { rootDir: string; testScript: string; reportDir: string; withCoverage: boolean }): KarmaRunPlan {
    const ngTest = NG_TEST_RE.test(o.testScript);
    const target = wrapTarget(o.rootDir, o.testScript);
    if (!target) {
        const plain = ngTest ? 'npm test -- --watch=false' : KARMA_START_RE.test(o.testScript) ? 'npm test -- --single-run' : 'npm test';
        return { command: plain, resultsFile: null };
    }
    const resultsFile = path.join(o.reportDir, RESULTS_FILE);
    fs.rmSync(resultsFile, { force: true });
    const coverage = o.withCoverage && fs.existsSync(path.join(o.rootDir, 'node_modules', 'karma-coverage'));
    const wrapper = path.join(o.reportDir, WRAPPER_FILE);
    fs.writeFileSync(wrapper, renderKarmaWrapper({
        projectConfig: target.projectConfig, projectDir: o.rootDir, resultsFile, coverageDir: coverage ? o.reportDir : null,
    }));
    if (ngTest) {
        return { command: `npm test -- --karma-config=${shellQuote(wrapper)} --watch=false${coverage ? ' --code-coverage' : ''}`, resultsFile };
    }
    const browsers = /--browsers[= ](\S+)/.exec(o.testScript)?.[1];
    return { command: `npx --no-install karma start ${shellQuote(wrapper)} --single-run${browsers ? ` --browsers ${browsers}` : ''}`, resultsFile };
}

// ─── Results ────────────────────────────────────────────────────────────────

interface KarmaResultsFile {
    cases?: Array<{ suite?: string; description?: string; success?: boolean; skipped?: boolean; time?: number; log?: string[] }>;
}

function specCase(suite: string, description: string, status: ExecutedTestCase['status'], durationMs: number, error?: string): ExecutedTestCase {
    const testName = suite ? `${suite} > ${description}` : description;
    const tag = parseTraceTag(description) ?? parseTraceTag(testName);
    return {
        testName, suite, file: '', status, durationMs,
        ...(error ? { error: error.slice(0, 2000) } : {}),
        ...(tag ? { storyId: tag.storyId, acIndex: tag.acIndex } : {}),
    };
}

/** Parse the agentjson reporter's `karma-results.json`. */
export function parseKarmaResults(raw: string, root: string): ParsedRun {
    const data = JSON.parse(raw) as KarmaResultsFile;
    const cases = (data.cases ?? []).map(c => {
        const status: ExecutedTestCase['status'] = c.skipped ? 'skip' : c.success ? 'pass' : 'fail';
        return specCase(c.suite ?? '', c.description ?? '', status, c.time ?? 0,
            status === 'fail' ? (c.log ?? []).join('\n') || 'Spec failed' : undefined);
    });
    return tallyCases('karma', root, cases);
}

/** `TOTAL: 1 FAILED, 133 SUCCESS` / `TOTAL: 134 SUCCESS` (summed over browsers). */
const TOTAL_RE = /^TOTAL: (?:(\d+) FAILED, )?(\d+) SUCCESS$/m;
/** Karma's progress line: `<browser>: Executed 134 of 134 (1 FAILED) (skipped 2) …`. */
const EXECUTED_RE = /Executed (\d+) of (\d+)(?: \((\d+) FAILED\))?/g;
/** A failed spec: `<browser> (<platform>) <suite …> <description> FAILED`. */
const FAILED_SPEC_RE = /^.+?\([^)]*\) (.+) FAILED$/;

/** The indented lines after a failed spec — the expectation and its stack. */
function indentedBlock(lines: string[], start: number): string {
    const block: string[] = [];
    for (let i = start; i < lines.length && block.length < 12 && /^\s/.test(lines[i]); i++) block.push(lines[i].trim());
    return block.join('\n');
}

/**
 * Fallback without `karma-results.json`: totals from the `TOTAL:` / last `Executed N of M`
 * line and the failed specs (with their tags and expectation) from the rendered output.
 * Passing spec names are not printed, so the result carries `caseNames: 'unavailable'`.
 */
export function parseKarmaOutput(rendered: string, root: string): ParsedRun | null {
    const executed = [...rendered.matchAll(EXECUTED_RE)].pop();
    const totals = TOTAL_RE.exec(rendered);
    if (!executed && !totals) return null;
    const lines = rendered.split('\n');
    const failedSpecs = lines.flatMap((line, i) => {
        const name = FAILED_SPEC_RE.exec(line)?.[1];
        if (!name) return [];
        const at = traceTagIndex(name);
        return [specCase(at > 0 ? name.slice(0, at).trim() : '', at > 0 ? name.slice(at) : name, 'fail', 0, indentedBlock(lines, i + 1))];
    });
    const failed = Number(totals?.[1] ?? executed?.[3] ?? 0);
    const passed = totals ? Number(totals[2]) : Number(executed?.[1] ?? 0) - failed;
    const total = executed ? Number(executed[2]) : passed + failed;
    return {
        ...tallyCases('karma', root, failedSpecs),
        total, passed, failed, skipped: Math.max(0, total - passed - failed),
        caseNames: 'unavailable',
    };
}

/** The run's results: the reporter's JSON when it was written, else the totals in the rendered output. */
export function readKarmaRun(plan: KarmaRunPlan, rendered: string, root: string): ParsedRun | null {
    if (plan.resultsFile && fs.existsSync(plan.resultsFile)) {
        try {
            return parseKarmaResults(fs.readFileSync(plan.resultsFile, 'utf-8'), root);
        } catch (err: any) {
            log.warn(`Unreadable ${plan.resultsFile} (${err.message}) — parsing the rendered output instead`);
        }
    }
    return parseKarmaOutput(rendered, root);
}
