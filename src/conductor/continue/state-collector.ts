/**
 * State Collector — reads all artifacts from a stopped run's output directory
 * and workspace into a structured `CollectedRunState` object.
 *
 * This is the first step of the "Continue Run" feature (Sub-Plan 01).
 * It performs read-only operations: no files are modified, no git commands
 * mutate state.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../../utils/logger';
import { readLedger, type LedgerEntry } from '../../utils/run-ledger';
import { readResponseLogIndex, type ResponseLogEntry } from '../../utils/response-log';
import { gitExec } from '../../utils/git-exec';
import { OUTPUTS_DIR } from '../../config';
import type { RunManifest } from '../../utils/run-snapshot';
import type { PullRequest } from '../../agents/_shared/base-schemas';

const log = getLogger('[StateCollector]', 177);

// ─── Types ──────────────────────────────────────────────────────────────────

/** Status of a feature branch from the previous run. */
export type PRBranchStatus = 'merged' | 'open' | 'failed-salvaged' | 'unknown';

/** A branch and its inferred status. */
export interface BranchStatus {
    branch: string;
    status: PRBranchStatus;
}

/** An agent's mission report artifact found in the workspace. */
export interface AgentArtifact {
    agentId: string;
    filePath: string;
    content: string;
}

/** A git commit from the workspace log. */
export interface GitLogEntry {
    hash: string;
    message: string;
    date: string;
}

/**
 * All artifacts collected from a stopped run — the input to the
 * State Reconstructor.
 */
export interface CollectedRunState {
    /** Parsed contents of outputs/<run>/state.json (null if missing/corrupt). */
    stateSnapshot: Record<string, any> | null;
    /** Parsed contents of outputs/<run>/run-manifest.json (null if missing/corrupt). */
    manifest: RunManifest | null;
    /** Parsed entries from outputs/<run>/ledger.jsonl. */
    ledgerEntries: LedgerEntry[];
    /** Parsed entries from outputs/<run>/full-responses/index.jsonl. */
    responseIndex: ResponseLogEntry[];
    /** Agent mission reports from generated-projects/<name>/docs/agents/*.md. */
    agentArtifacts: AgentArtifact[];
    /** Git branches in the workspace. */
    gitBranches: { local: string[]; remote: string[] };
    /** Recent git log entries on the current branch. */
    gitLog: GitLogEntry[];
    /** Files tracked by git in the workspace. */
    workspaceFiles: string[];
    /** Inferred status of each PR branch. */
    prBranchStatus: BranchStatus[];
    /** Absolute path to the run's output directory. */
    outputPath: string;
    /** Absolute path to the project workspace (empty string if unknown). */
    workspacePath: string;
    /** Whether the workspace directory exists on disk. */
    workspaceExists: boolean;
    /** Whether the workspace is a valid git repository. */
    workspaceIsGitRepo: boolean;
    /** Salvage patch files found in outputs/<run>/salvage/. */
    salvagePatches: string[];
    /** Token usage records from outputs/<run>/token-usage.json. */
    tokenUsageRecords: Record<string, any>[];
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Locate a run's output directory by an identifier.
 *
 * The identifier can be:
 *   - An absolute path to the output directory
 *   - A relative path under the outputs directory
 *   - A run name (directory name in outputs/)
 *   - A timestamp prefix that matches a run directory
 *
 * @throws if the output directory cannot be found.
 */
export function findRunOutputs(identifier: string): string {
    // 1. Try as absolute path
    if (path.isAbsolute(identifier) && fs.existsSync(identifier)) {
        return identifier;
    }

    // 2. Try as relative path from cwd
    const fromCwd = path.resolve(identifier);
    if (fs.existsSync(fromCwd)) {
        return fromCwd;
    }

    // 3. Try as a name/prefix under OUTPUTS_DIR
    const outputsDir = OUTPUTS_DIR;
    if (!fs.existsSync(outputsDir)) {
        throw new Error(`Outputs directory does not exist: ${outputsDir}`);
    }

    // Exact match
    const exact = path.join(outputsDir, identifier);
    if (fs.existsSync(exact)) {
        return exact;
    }

    // Prefix match — scan for directories starting with the identifier
    const entries = fs.readdirSync(outputsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort()
        .reverse(); // newest first (ISO timestamps sort lexicographically)

    const match = entries.find(name => name.startsWith(identifier));
    if (match) {
        return path.join(outputsDir, match);
    }

    throw new Error(
        `Cannot find run output directory for "${identifier}". ` +
        `Searched: absolute path, relative path, and outputs/ prefix match.`,
    );
}

/**
 * List runs in the outputs directory that are candidates for continuation.
 *
 * Returns runs whose `run-manifest.json` has a status other than 'completed'.
 * Sorted by timestamp descending (newest first).
 */
export function listStoppedRuns(): Array<{
    outputPath: string;
    systemName: string;
    timestamp: string;
    status: string;
    finalPhase: string;
    workspacePath: string;
}> {
    const outputsDir = OUTPUTS_DIR;
    if (!fs.existsSync(outputsDir)) return [];

    const entries = fs.readdirSync(outputsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort()
        .reverse();

    const runs: Array<{
        outputPath: string;
        systemName: string;
        timestamp: string;
        status: string;
        finalPhase: string;
        workspacePath: string;
    }> = [];

    for (const dirName of entries) {
        const dirPath = path.join(outputsDir, dirName);
        const manifestPath = path.join(dirPath, 'run-manifest.json');
        if (!fs.existsSync(manifestPath)) continue;

        try {
            const manifest: RunManifest = JSON.parse(
                fs.readFileSync(manifestPath, 'utf-8'),
            );
            if (manifest.status === 'completed') continue;

            // Try to get workspacePath from state.json
            let workspacePath = '';
            const statePath = path.join(dirPath, 'state.json');
            if (fs.existsSync(statePath)) {
                try {
                    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
                    workspacePath = state.workspacePath ?? '';
                } catch { /* best-effort */ }
            }

            runs.push({
                outputPath: dirPath,
                systemName: manifest.systemName ?? 'unknown',
                timestamp: manifest.generatedAt ?? dirName,
                status: manifest.status,
                finalPhase: manifest.finalPhase ?? 'unknown',
                workspacePath,
            });
        } catch {
            // Corrupt manifest — skip
        }
    }

    return runs;
}

/**
 * Collect all available artifacts from a stopped run's output directory.
 *
 * This is a read-only operation. It never throws — individual artifact
 * collection failures are logged as warnings and the corresponding field
 * is set to its empty/null default.
 */
export function collectRunState(outputPath: string): CollectedRunState {
    const absOutputPath = path.resolve(outputPath);
    log.info(`Collecting run state from: ${absOutputPath}`);

    const result: CollectedRunState = {
        stateSnapshot: null,
        manifest: null,
        ledgerEntries: [],
        responseIndex: [],
        agentArtifacts: [],
        gitBranches: { local: [], remote: [] },
        gitLog: [],
        workspaceFiles: [],
        prBranchStatus: [],
        outputPath: absOutputPath,
        workspacePath: '',
        workspaceExists: false,
        workspaceIsGitRepo: false,
        salvagePatches: [],
        tokenUsageRecords: [],
    };

    // ── 1. state.json ────────────────────────────────────────────────────
    result.stateSnapshot = readJsonFile(absOutputPath, 'state.json');
    if (result.stateSnapshot) {
        log.info('Loaded state.json');
    } else {
        log.warn('state.json not found or corrupt — degraded continuation mode');
    }

    // ── 2. run-manifest.json ─────────────────────────────────────────────
    result.manifest = readJsonFile(absOutputPath, 'run-manifest.json') as RunManifest | null;
    if (result.manifest) {
        log.info(`Loaded run-manifest.json (status=${result.manifest.status}, phase=${result.manifest.finalPhase})`);
    } else {
        log.warn('run-manifest.json not found or corrupt');
    }

    // ── 3. ledger.jsonl ──────────────────────────────────────────────────
    try {
        result.ledgerEntries = readLedger(absOutputPath);
        log.info(`Loaded ${result.ledgerEntries.length} ledger entries`);
    } catch (err: any) {
        log.warn(`Failed to read ledger: ${err.message}`);
    }

    // ── 4. full-responses/index.jsonl ────────────────────────────────────
    try {
        result.responseIndex = readResponseLogIndex(absOutputPath);
        log.info(`Loaded ${result.responseIndex.length} response log entries`);
    } catch (err: any) {
        log.warn(`Failed to read response log index: ${err.message}`);
    }

    // ── 5. token-usage.json ──────────────────────────────────────────────
    const tokenRecords = readJsonFile(absOutputPath, 'token-usage.json');
    if (Array.isArray(tokenRecords)) {
        result.tokenUsageRecords = tokenRecords;
        log.info(`Loaded ${tokenRecords.length} token usage records`);
    }

    // ── 6. Resolve workspace path ────────────────────────────────────────
    result.workspacePath = resolveWorkspacePath(result);
    if (result.workspacePath) {
        result.workspaceExists = fs.existsSync(result.workspacePath);
        if (result.workspaceExists) {
            result.workspaceIsGitRepo = fs.existsSync(
                path.join(result.workspacePath, '.git'),
            );
            log.info(`Workspace: ${result.workspacePath} (exists=${result.workspaceExists}, git=${result.workspaceIsGitRepo})`);
        } else {
            log.warn(`Workspace directory not found: ${result.workspacePath}`);
        }
    } else {
        log.warn('Could not determine workspace path');
    }

    // ── 7. Agent mission reports ─────────────────────────────────────────
    if (result.workspaceExists) {
        result.agentArtifacts = collectAgentArtifacts(result.workspacePath);
        log.info(`Found ${result.agentArtifacts.length} agent mission reports`);
    }

    // ── 8. Git state ─────────────────────────────────────────────────────
    if (result.workspaceIsGitRepo) {
        result.gitBranches = collectGitBranches(result.workspacePath);
        result.gitLog = collectGitLog(result.workspacePath);
        log.info(`Git: ${result.gitBranches.local.length} local branches, ${result.gitBranches.remote.length} remote branches, ${result.gitLog.length} recent commits`);
    }

    // ── 9. PR branch status ──────────────────────────────────────────────
    result.prBranchStatus = inferPRBranchStatus(result);
    if (result.prBranchStatus.length > 0) {
        log.info(`Inferred status for ${result.prBranchStatus.length} PR branches`);
    }

    // ── 10. Salvage patches ──────────────────────────────────────────────
    result.salvagePatches = collectSalvagePatches(absOutputPath);
    if (result.salvagePatches.length > 0) {
        log.info(`Found ${result.salvagePatches.length} salvage patches`);
    }

    return result;
}

// ─── Internals ──────────────────────────────────────────────────────────────

/** Safely read and parse a JSON file. Returns null on any failure. */
function readJsonFile(dir: string, filename: string): any | null {
    const filePath = path.join(dir, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (err: any) {
        log.warn(`Failed to parse ${filename}: ${err.message}`);
        return null;
    }
}

/** Determine the workspace path from state.json or manifest. */
function resolveWorkspacePath(collected: CollectedRunState): string {
    // Primary: from state.json
    if (collected.stateSnapshot?.workspacePath) {
        return collected.stateSnapshot.workspacePath;
    }

    // Fallback: infer from input in state.json (maintain mode)
    if (collected.stateSnapshot?.input?.existingProjectPath) {
        return collected.stateSnapshot.input.existingProjectPath;
    }

    // Fallback: infer from system name (greenfield convention)
    const systemName = collected.stateSnapshot?.input?.systemName
        ?? collected.manifest?.systemName;
    if (systemName) {
        const slug = systemName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
        const candidate = path.resolve('generated-projects', slug);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return '';
}

/** Collect agent mission reports from the workspace docs/agents/ directory. */
function collectAgentArtifacts(workspacePath: string): AgentArtifact[] {
    const agentsDir = path.join(workspacePath, 'docs', 'agents');
    if (!fs.existsSync(agentsDir)) return [];

    const artifacts: AgentArtifact[] = [];
    try {
        const files = fs.readdirSync(agentsDir)
            .filter(f => f.endsWith('.md'));

        for (const file of files) {
            try {
                const filePath = path.join(agentsDir, file);
                const content = fs.readFileSync(filePath, 'utf-8');
                // Infer agent ID from filename: "architect.md" -> "architect"
                const agentId = path.basename(file, '.md');
                artifacts.push({ agentId, filePath, content });
            } catch (err: any) {
                log.warn(`Failed to read agent artifact ${file}: ${err.message}`);
            }
        }
    } catch (err: any) {
        log.warn(`Failed to scan agent artifacts: ${err.message}`);
    }

    return artifacts;
}

/** Collect local and remote git branches from the workspace. */
function collectGitBranches(workspacePath: string): { local: string[]; remote: string[] } {
    const localRaw = gitExec(workspacePath, 'branch --list --no-color');
    const remoteRaw = gitExec(workspacePath, 'branch --remotes --no-color');

    const parseBranches = (raw: string): string[] => {
        if (raw.startsWith('Error:')) return [];
        return raw.split('\n')
            .map(line => line.replace(/^\*?\s+/, '').trim())
            .filter(Boolean);
    };

    return {
        local: parseBranches(localRaw),
        remote: parseBranches(remoteRaw),
    };
}

/** Collect the recent git log on the current branch. */
function collectGitLog(workspacePath: string, maxEntries = 50): GitLogEntry[] {
    const raw = gitExec(
        workspacePath,
        `log --oneline --format="%H|%s|%aI" -n ${maxEntries}`,
    );
    if (raw.startsWith('Error:')) return [];

    return raw.split('\n')
        .filter(Boolean)
        .map(line => {
            const [hash, message, date] = line.split('|');
            return { hash: hash ?? '', message: message ?? '', date: date ?? '' };
        });
}

/**
 * Infer the status of each PR branch from state.json pull request data
 * and the current git branch state.
 */
function inferPRBranchStatus(collected: CollectedRunState): BranchStatus[] {
    const pullRequests: PullRequest[] = collected.stateSnapshot?.pullRequests ?? [];
    if (pullRequests.length === 0) return [];

    const localBranches = new Set(collected.gitBranches.local);
    const salvageBranches = new Set<string>(collected.stateSnapshot?.salvageBranches ?? []);

    return pullRequests.map(pr => {
        let status: PRBranchStatus;

        if (pr.status === 'merged') {
            status = 'merged';
        } else if (salvageBranches.has(pr.branchName)) {
            status = 'failed-salvaged';
        } else if (pr.status === 'open' || pr.status === 'approved' || pr.status === 'escalated_open') {
            status = 'open';
        } else if (pr.status === 'blocked' || pr.status === 'closed') {
            // Check if the branch still exists locally
            status = localBranches.has(pr.branchName) ? 'open' : 'failed-salvaged';
        } else {
            status = 'unknown';
        }

        return { branch: pr.branchName, status };
    });
}

/** Collect salvage patch filenames from outputs/<run>/salvage/. */
function collectSalvagePatches(outputPath: string): string[] {
    const salvageDir = path.join(outputPath, 'salvage');
    if (!fs.existsSync(salvageDir)) return [];

    try {
        return fs.readdirSync(salvageDir)
            .filter(f => f.endsWith('.patch') || f.endsWith('.diff'))
            .map(f => path.join(salvageDir, f));
    } catch {
        return [];
    }
}
