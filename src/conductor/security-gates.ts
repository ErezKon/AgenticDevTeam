/**
 * Security and dependency-audit gate.
 *
 * Regex sweep for hard-coded credentials, per-stack dependency audit,
 * and licence deny-list checking. Offline and dependency-free by design:
 * no scanner binary is assumed. Missing audit tooling produces zero
 * findings and zero failures.
 *
 * Redaction discipline: log and report the match LOCATION and PATTERN
 * NAME, never the matched value.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as crypto from 'crypto';
import { getLogger } from '../utils/logger';
import { gitExec } from '../utils/git-exec';
import { detectStacks, type StackKind } from './quality-gates';
import {
    SECURITY_GATES_ENABLED,
    SECURITY_GATE_BLOCKING,
    SECURITY_DEEP_AUDIT,
    LICENCE_DENYLIST,
} from '../config';
import type { Bug } from '../agents/_shared/schemas/bug.schema';

const log = getLogger('[SecurityGates]', 196);

/** Build a child-process env from a safe allowlist — never leaks API keys. */
function safeChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const SAFE_KEYS = [
        'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TERM',
        'TMPDIR', 'TMP', 'TEMP', 'HOSTNAME',
        'PROGRAMFILES', 'SYSTEMROOT', 'WINDIR',
    ];
    const env: Record<string, string | undefined> = {};
    for (const key of SAFE_KEYS) {
        if (process.env[key]) env[key] = process.env[key];
    }
    return { ...env, ...extra };
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SecurityFinding {
    kind: 'secret' | 'vulnerability' | 'licence';
    severity: 'critical' | 'major' | 'minor';
    file?: string;
    line?: number;
    detail: string;
    /** Stable id for de-duplication across bug-fix iterations. */
    id: string;
}

export interface SecurityReport {
    findings: SecurityFinding[];
    passed: boolean;
}

// ─── Secret Patterns ────────────────────────────────────────────────────────

export interface SecretPattern {
    name: string;
    regex: RegExp;
    severity: 'critical' | 'major' | 'minor';
}

/** Placeholder values that should NOT trigger the generic pattern. */
const PLACEHOLDER_RE = /^(changeme|xxx+|<[^>]+>|\$\{[^}]+\}|your[-_].*|example.*|placeholder.*|TODO|FIXME|INSERT|REPLACE)$/i;

export const SECRET_PATTERNS: SecretPattern[] = [
    {
        name: 'AWS Access Key ID',
        regex: /AKIA[0-9A-Z]{16}/,
        severity: 'critical',
    },
    {
        name: 'Private Key',
        regex: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
        severity: 'critical',
    },
    {
        name: 'GitHub Token',
        regex: /gh[pousr]_[A-Za-z0-9]{36}/,
        severity: 'critical',
    },
    {
        name: 'Slack Token',
        regex: /xox[baprs]-[A-Za-z0-9-]{10,}/,
        severity: 'critical',
    },
    {
        name: 'JWT',
        regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
        severity: 'critical',
    },
    {
        name: 'Generic Secret',
        regex: /(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"]([^'"\s]{12,})['"]/i,
        severity: 'critical',
    },
];

// ─── Files to skip ──────────────────────────────────────────────────────────

/** Paths that should never be scanned for secrets. */
const SKIP_PATHS = [
    '.env.example',
    '.conventions/',
    '.worktrees/',
    'node_modules/',
    '.git/',
];

/** Lock files that should never be scanned. */
const LOCK_FILE_NAMES = [
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'Gemfile.lock',
    'Cargo.lock',
    'go.sum',
    'composer.lock',
    'poetry.lock',
];

function shouldSkipPath(relativePath: string): boolean {
    // Skip files under excluded directories
    for (const prefix of SKIP_PATHS) {
        if (relativePath === prefix || relativePath.startsWith(prefix)) return true;
    }
    // Skip lock files
    const basename = path.basename(relativePath);
    if (LOCK_FILE_NAMES.includes(basename)) return true;
    // Skip dotfiles at the root
    if (!relativePath.includes('/') && relativePath.startsWith('.')) return true;
    return false;
}

// ─── Secret scanning ────────────────────────────────────────────────────────

/**
 * Regex sweep for hard-coded credentials over git-tracked text files.
 *
 * Offline and dependency-free by design: no scanner binary is assumed. Skips
 * .env.example, .conventions/, .worktrees/, node_modules/, lock files, and
 * anything git does not track.
 */
export function scanForSecrets(workspacePath: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];

    // Get git-tracked files only
    const trackedOutput = gitExec(workspacePath, 'ls-files');
    if (!trackedOutput || trackedOutput.startsWith('Error:')) {
        // Not a git repo or error — fall back to filesystem walk
        log.warn('Could not list git-tracked files; skipping secret scan');
        return [];
    }

    const trackedFiles = trackedOutput.split('\n').filter(Boolean);

    for (const relativePath of trackedFiles) {
        if (shouldSkipPath(relativePath)) continue;

        const absPath = path.join(workspacePath, relativePath);
        let content: string;
        try {
            // Skip binary files (check first 512 bytes for null byte)
            const fd = fs.openSync(absPath, 'r');
            const buf = Buffer.alloc(512);
            const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
            fs.closeSync(fd);
            if (buf.slice(0, bytesRead).includes(0)) continue;

            content = fs.readFileSync(absPath, 'utf-8');
        } catch {
            continue; // unreadable file — skip
        }

        const lines = content.split('\n');
        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const line = lines[lineIdx];
            for (const pattern of SECRET_PATTERNS) {
                const match = line.match(pattern.regex);
                if (!match) continue;

                // For the generic pattern, check if the value is a placeholder
                if (pattern.name === 'Generic Secret') {
                    const value = match[2]; // capture group 2 is the value
                    if (value && PLACEHOLDER_RE.test(value)) continue;
                }

                // Build a stable id from file + line + pattern name
                const id = `SEC-${crypto.createHash('sha256')
                    .update(`${relativePath}:${lineIdx + 1}:${pattern.name}`)
                    .digest('hex').slice(0, 12)}`;

                findings.push({
                    kind: 'secret',
                    severity: pattern.severity,
                    file: relativePath,
                    line: lineIdx + 1,
                    // REDACTION: report the pattern name and location, NEVER the matched value
                    detail: `${pattern.name} detected at ${relativePath}:${lineIdx + 1}`,
                    id,
                });
                // Only report one finding per line per pattern to avoid noise
                break;
            }
        }
    }

    return findings;
}

// ─── Dependency audit ───────────────────────────────────────────────────────

/** Exec seam for testing. */
type ExecFn = (cmd: string, opts: { cwd: string; timeout: number }) => string;

function defaultExec(cmd: string, opts: { cwd: string; timeout: number }): string {
    return execSync(cmd + ' 2>&1', {
        cwd: opts.cwd,
        encoding: 'utf-8',
        timeout: opts.timeout,
        maxBuffer: 1024 * 1024 * 10,
        env: safeChildEnv({ CI: 'true' }),
    });
}

function isToolOnPath(tool: string, cwd: string, exec: ExecFn): boolean {
    try {
        exec(`which ${tool}`, { cwd, timeout: 10_000 });
        return true;
    } catch {
        return false;
    }
}

/** Audit commands by stack. All soft — missing tool => skip, never fail. */
const AUDIT_COMMANDS: Partial<Record<StackKind, { cmd: string; tool: string; deepOnly?: boolean }>> = {
    node:   { cmd: 'npm audit --json --audit-level=high', tool: 'npm' },
    python: { cmd: 'pip-audit -f json', tool: 'pip-audit' },
    go:     { cmd: 'govulncheck ./...', tool: 'govulncheck' },
    dotnet: { cmd: 'dotnet list package --vulnerable --include-transitive', tool: 'dotnet' },
    maven:  { cmd: 'mvn -B -q org.owasp:dependency-check-maven:check', tool: 'mvn', deepOnly: true },
};

/**
 * Map npm audit severity strings to our severity levels.
 */
function mapNpmSeverity(sev: string): 'critical' | 'major' | 'minor' {
    switch (sev) {
        case 'critical':
        case 'high':
            return 'critical';
        case 'moderate':
            return 'major';
        default:
            return 'minor';
    }
}

/**
 * Parse npm audit JSON output into SecurityFindings.
 */
function parseNpmAuditJson(jsonStr: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    try {
        const data = JSON.parse(jsonStr);
        // npm audit v2+ format: { vulnerabilities: { [name]: { ... } } }
        const vulns = data.vulnerabilities ?? {};
        for (const [pkgName, info] of Object.entries(vulns)) {
            const v = info as any;
            const severity = mapNpmSeverity(v.severity ?? 'low');
            findings.push({
                kind: 'vulnerability',
                severity,
                detail: `${pkgName}: ${v.title ?? v.via?.[0]?.title ?? 'vulnerability detected'} (${v.severity ?? 'unknown'})`,
                id: `VULN-npm-${pkgName}-${v.severity ?? 'unknown'}`,
            });
        }
    } catch {
        // Malformed JSON — skip
    }
    return findings;
}

/**
 * Per-stack dependency audit. Every command is optional; a missing tool
 * yields no findings.
 */
export function auditDependencies(
    workspacePath: string,
    opts?: { exec?: ExecFn },
): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const stacks = detectStacks(workspacePath);
    const exec = opts?.exec ?? defaultExec;

    for (const stack of stacks) {
        const auditInfo = AUDIT_COMMANDS[stack];
        if (!auditInfo) continue;

        // Deep-audit-only commands skip unless SECURITY_DEEP_AUDIT is true
        if (auditInfo.deepOnly && !SECURITY_DEEP_AUDIT) continue;

        // Check if the tool is on PATH
        if (!isToolOnPath(auditInfo.tool, workspacePath, exec)) {
            log.info(`Audit tool '${auditInfo.tool}' not on PATH — skipping ${stack} audit`);
            continue;
        }

        try {
            const output = exec(auditInfo.cmd, { cwd: workspacePath, timeout: 300_000 });

            // Parse stack-specific output
            if (stack === 'node') {
                findings.push(...parseNpmAuditJson(output));
            } else {
                // For non-npm stacks, a successful exit means no critical issues.
                // A non-zero exit (caught below) means issues found.
            }
        } catch (err: any) {
            const output = (err.stdout ?? err.stderr ?? err.message ?? '').toString().trim();

            if (stack === 'node') {
                // npm audit exits non-zero when vulnerabilities are found
                findings.push(...parseNpmAuditJson(output));
            } else {
                // Non-zero exit from other tools means vulnerabilities found
                if (output.length > 0) {
                    findings.push({
                        kind: 'vulnerability',
                        severity: 'major',
                        detail: `${stack} dependency audit reported issues: ${output.slice(0, 300)}`,
                        id: `VULN-${stack}-audit`,
                    });
                }
            }
        }
    }

    return findings;
}

// ─── Licence checking ───────────────────────────────────────────────────────

/**
 * Flag dependency licences matching LICENCE_DENYLIST.
 *
 * Currently supports npm only (reads license field from
 * node_modules/<pkg>/package.json). Other stacks can be added later.
 */
export function checkLicences(workspacePath: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    if (LICENCE_DENYLIST.length === 0) return findings;

    const nodeModulesPath = path.join(workspacePath, 'node_modules');
    if (!fs.existsSync(nodeModulesPath)) return findings;

    let entries: string[];
    try {
        entries = fs.readdirSync(nodeModulesPath);
    } catch {
        return findings;
    }

    const denySet = new Set(LICENCE_DENYLIST.map(s => s.toLowerCase()));

    for (const entry of entries) {
        // Skip scoped packages directory markers and hidden dirs
        if (entry.startsWith('.') || entry.startsWith('@')) continue;

        const pkgJsonPath = path.join(nodeModulesPath, entry, 'package.json');
        try {
            const raw = fs.readFileSync(pkgJsonPath, 'utf-8');
            const pkg = JSON.parse(raw);
            const licence = (pkg.license ?? pkg.licence ?? '').toString().trim();
            if (licence && denySet.has(licence.toLowerCase())) {
                findings.push({
                    kind: 'licence',
                    severity: 'major',
                    file: `node_modules/${entry}/package.json`,
                    detail: `Package '${entry}' uses denied licence: ${licence}`,
                    id: `LIC-${entry}-${licence}`,
                });
            }
        } catch {
            // unreadable or missing package.json — skip
        }
    }

    // Handle scoped packages (@org/pkg)
    for (const entry of entries) {
        if (!entry.startsWith('@')) continue;
        const scopePath = path.join(nodeModulesPath, entry);
        let scopedEntries: string[];
        try {
            scopedEntries = fs.readdirSync(scopePath);
        } catch {
            continue;
        }
        for (const scopedPkg of scopedEntries) {
            const pkgJsonPath = path.join(scopePath, scopedPkg, 'package.json');
            try {
                const raw = fs.readFileSync(pkgJsonPath, 'utf-8');
                const pkg = JSON.parse(raw);
                const licence = (pkg.license ?? pkg.licence ?? '').toString().trim();
                if (licence && denySet.has(licence.toLowerCase())) {
                    const fullName = `${entry}/${scopedPkg}`;
                    findings.push({
                        kind: 'licence',
                        severity: 'major',
                        file: `node_modules/${fullName}/package.json`,
                        detail: `Package '${fullName}' uses denied licence: ${licence}`,
                        id: `LIC-${fullName}-${licence}`,
                    });
                }
            } catch {
                // skip
            }
        }
    }

    return findings;
}

// ─── Main runner ────────────────────────────────────────────────────────────

/**
 * Run all security gates: secret scan, dependency audit, and licence check.
 *
 * Returns findings and a pass/fail flag. With all flags at their defaults
 * the gate is report-only (does not block the pipeline).
 */
export function runSecurityGates(
    workspacePath: string,
    opts?: { exec?: ExecFn },
): SecurityReport {
    if (!SECURITY_GATES_ENABLED) {
        log.info('Security gates disabled (SECURITY_GATES_ENABLED=false)');
        return { findings: [], passed: true };
    }

    const findings: SecurityFinding[] = [];

    // 1. Secret scan
    try {
        const secretFindings = scanForSecrets(workspacePath);
        findings.push(...secretFindings);
        if (secretFindings.length > 0) {
            log.warn(`Secret scan: ${secretFindings.length} finding(s)`);
        } else {
            log.info('Secret scan: clean');
        }
    } catch (err: any) {
        log.warn(`Secret scan error (non-fatal): ${err.message}`);
    }

    // 2. Dependency audit
    try {
        const auditFindings = auditDependencies(workspacePath, opts);
        findings.push(...auditFindings);
        if (auditFindings.length > 0) {
            log.warn(`Dependency audit: ${auditFindings.length} finding(s)`);
        } else {
            log.info('Dependency audit: clean');
        }
    } catch (err: any) {
        log.warn(`Dependency audit error (non-fatal): ${err.message}`);
    }

    // 3. Licence check
    try {
        const licenceFindings = checkLicences(workspacePath);
        findings.push(...licenceFindings);
        if (licenceFindings.length > 0) {
            log.warn(`Licence check: ${licenceFindings.length} finding(s)`);
        } else {
            log.info('Licence check: clean');
        }
    } catch (err: any) {
        log.warn(`Licence check error (non-fatal): ${err.message}`);
    }

    // passed = no critical findings
    const passed = !findings.some(f => f.severity === 'critical');

    log.info(`Security gates ${passed ? 'PASSED' : 'FAILED'}: ${findings.length} total finding(s), ${findings.filter(f => f.severity === 'critical').length} critical`);
    return { findings, passed };
}

// ─── SecurityReport -> Bug synthesis ────────────────────────────────────────

/**
 * Convert critical/major security findings into Bugs for the bug-fix loop.
 *
 * Only creates bugs when SECURITY_GATE_BLOCKING is true.
 * Uses the finding's stable `id` so `dedupeBugs` (Sub-Plan 2) handles
 * repeats across iterations.
 */
export function synthesiseSecurityBugs(report: SecurityReport): Bug[] {
    if (!SECURITY_GATE_BLOCKING) return [];

    return report.findings
        .filter(f => f.severity === 'critical' || f.severity === 'major')
        .map(f => ({
            id: f.id,
            title: `Security: ${f.detail.slice(0, 80)}`,
            severity: f.severity as 'critical' | 'major',
            stepsToReproduce: f.file
                ? `Check ${f.file}${f.line ? `:${f.line}` : ''}`
                : 'Run security scan',
            expectedBehavior: f.kind === 'secret'
                ? 'No hard-coded credentials in tracked files'
                : f.kind === 'licence'
                    ? 'All dependencies use approved licences'
                    : 'No known vulnerabilities in dependencies',
            actualBehavior: f.detail,
            suspectedArea: f.file ?? 'project dependencies',
            reportedBy: 'security-gates',
        }));
}

// ─── SecurityReport -> Markdown ─────────────────────────────────────────────

/**
 * Render a SecurityReport as markdown for PR descriptions and artifacts.
 */
export function securityReportToMarkdown(report: SecurityReport): string {
    if (report.findings.length === 0) {
        return ':white_check_mark: **Security scan clean** — no findings.';
    }

    const lines: string[] = [];
    if (report.passed) {
        lines.push(':warning: **Security findings detected** (no critical issues).\n');
    } else {
        lines.push(':x: **Critical security findings detected.**\n');
    }

    lines.push('| Kind | Severity | Location | Detail |');
    lines.push('|------|----------|----------|--------|');
    for (const f of report.findings) {
        const location = f.file
            ? `\`${f.file}\`${f.line ? `:${f.line}` : ''}`
            : '—';
        lines.push(`| ${f.kind} | ${f.severity} | ${location} | ${f.detail.slice(0, 120)} |`);
    }

    return lines.join('\n');
}
