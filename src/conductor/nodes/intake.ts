import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { GITHUB_OWNER, GITHUB_PROJECT_OWNER, GITHUB_PROJECT_TOKEN, GITHUB_REPO, GITHUB_TOKEN } from '../../config';
import { emitRunEvent } from '../../utils/event-bus';
import { findGitRoot, gitExec, gitPush } from '../../utils/git-exec';
import { GITHUB_MODE } from '../../utils/github-local';
import { createGitHubRepo, initializeRepoLocally, validateGitHubRepo } from '../../utils/github-repo-manager';
import { getLogger, setRunLogPath } from '../../utils/logger';
import { initResponseLog } from '../../utils/response-log';
import { appendLedger, initLedger } from '../../utils/run-ledger';
import { startRunBudget } from '../../utils/run-budget';
import { refreshTokenReport } from '../../utils/token-report';
import { tokenTracker } from '../../utils/token-tracker';
import { slugify, systemBranch as buildSystemBranch } from '../../utils/branch-naming';
import { createProjectWorkspace, createRunOutputDir, ensureProjectGitignore, getGitignoreEntriesForStack } from '../../utils/workspace';
import { parseRequirementsFile } from '../../tools/requirements/parse-requirements';
import { setLocalBareRepoPath } from '../pr-workflow';

import type { GitContext, PhaseName } from '../../agents/_shared/base-schemas';
import type { ProjectStateType } from '../state';

import { detectDefaultBranch } from './_git-helpers';
import { msg } from './_guards';

const intakeLog = getLogger('[Intake]', 255);

export async function intakeNode(state: ProjectStateType): Promise<Partial<ProjectStateType>> {
    // Idempotency guard: skip if already initialized (prevents re-creation on graph replay)
    if (state.outputPath && state.workspacePath) {
        intakeLog.info('Intake already completed — skipping (idempotent guard).');
        return {};
    }

    intakeLog.info('Starting intake phase...');
    emitRunEvent('phase:start', { phase: 'intake' });
    tokenTracker.reset();
    startRunBudget();

    let requirementsText = state.input.requirementsText;
    if (state.input.requirementsDocPath && !requirementsText) {
        intakeLog.info(`Parsing requirements from: ${state.input.requirementsDocPath}`);
        requirementsText = await parseRequirementsFile(state.input.requirementsDocPath);
        intakeLog.info(`Extracted ${requirementsText.length} characters`);
    }

    let workspacePath: string;
    if (state.input.runType === 'maintain') {
        const existingPath = state.input.existingProjectPath;
        if (!existingPath || !fs.existsSync(existingPath)) {
            throw new Error(`Existing project path not found: ${existingPath}`);
        }
        workspacePath = path.resolve(existingPath);
        intakeLog.info(`Maintain mode: using existing project at ${workspacePath}`);
        fs.mkdirSync(path.join(workspacePath, 'docs', 'agents'), { recursive: true });
    } else {
        workspacePath = createProjectWorkspace(state.input.systemName);
    }

    const outputPath = createRunOutputDir(state.input.systemName);
    setRunLogPath(path.join(outputPath, 'run.log'));
    initLedger(outputPath);
    initResponseLog(outputPath);
    appendLedger({ kind: 'phase', phase: 'intake', event: 'start' });

    tokenTracker.enablePersistence(outputPath, state.input.systemName);
    tokenTracker.setRefreshCallback(() => refreshTokenReport());
    refreshTokenReport();
    intakeLog.info(`Token report skeleton created at ${outputPath}`);

    const repoTarget = state.input.repoTarget;
    const isSeparateRepo =
        state.input.runType !== 'maintain' &&
        (repoTarget?.type === 'new-repo' || repoTarget?.type === 'existing-repo');

    let gitRoot: string;
    let defaultBranch: string;
    let gitContext: GitContext;

    if (isSeparateRepo) {
        const projectToken = GITHUB_PROJECT_TOKEN || GITHUB_TOKEN;
        const projectOwner = GITHUB_PROJECT_OWNER || GITHUB_OWNER;

        if (!projectToken && GITHUB_MODE !== 'local') {
            throw new Error(
                'No GitHub token available for project repo. ' +
                'Set GITHUB_PROJECT_TOKEN or GITHUB_TOKEN in your environment.',
            );
        }
        if (!projectOwner && GITHUB_MODE !== 'local') {
            throw new Error(
                'No GitHub owner available for project repo. ' +
                'Set GITHUB_PROJECT_OWNER or GITHUB_OWNER in your environment.',
            );
        }

        const repoName = repoTarget!.repoName ?? slugify(state.input.systemName, 100);

        if (repoTarget!.type === 'new-repo') {
            intakeLog.info(`Creating new GitHub repo: ${projectOwner}/${repoName}`);
            const created = await createGitHubRepo(
                projectToken, projectOwner, repoName, repoTarget!.isPrivate ?? true,
            );
            defaultBranch = created.defaultBranch;

            initializeRepoLocally(workspacePath, created.cloneUrl, defaultBranch, projectToken);
            gitExec(workspacePath, 'fetch origin');
            const resetResult = gitExec(workspacePath, `reset --hard origin/${defaultBranch}`);
            if (resetResult.startsWith('Error:')) {
                intakeLog.warn(`Could not reset to origin/${defaultBranch} (remote may be empty): ${resetResult}`);
            }

            intakeLog.info(`New repo created: ${created.fullName} (${created.htmlUrl})`);
        } else {
            intakeLog.info(`Validating existing repo: ${projectOwner}/${repoName}`);
            const validated = await validateGitHubRepo(projectToken, projectOwner, repoName);
            if (!validated.exists) {
                throw new Error(
                    `Repository ${projectOwner}/${repoName} not found or not accessible. ` +
                    `Ensure the repo exists and GITHUB_PROJECT_TOKEN has access.`,
                );
            }
            defaultBranch = validated.defaultBranch;

            initializeRepoLocally(workspacePath, validated.cloneUrl, defaultBranch, projectToken);
            gitExec(workspacePath, 'fetch origin');
            const resetResult = gitExec(workspacePath, `reset --hard origin/${defaultBranch}`);
            if (resetResult.startsWith('Error:')) {
                intakeLog.warn(`Could not reset to origin/${defaultBranch}: ${resetResult}`);
            }

            intakeLog.info(`Existing repo validated: ${validated.fullName}`);
        }

        gitRoot = workspacePath;
        gitContext = {
            token: projectToken,
            owner: projectOwner,
            repo: repoName,
            defaultBranch,
        };
    } else {
        try {
            gitRoot = findGitRoot(workspacePath);
        } catch {
            if (GITHUB_MODE === 'local') {
                const bareRepoPath = path.join(outputPath, 'origin.git');
                execSync(`git init --bare "${bareRepoPath}"`, { encoding: 'utf-8', timeout: 10_000 });
                execSync(`git init -b main`, { cwd: workspacePath, encoding: 'utf-8', timeout: 10_000 });
                execSync(`git config user.name "AgenticDevTeam"`, { cwd: workspacePath, encoding: 'utf-8' });
                execSync(`git config user.email "agenticdevteam@noreply.github.com"`, { cwd: workspacePath, encoding: 'utf-8' });
                execSync(`git remote add origin "${bareRepoPath}"`, { cwd: workspacePath, encoding: 'utf-8' });
                execSync('git add -A && git commit --allow-empty -m "Initial commit"', { cwd: workspacePath, encoding: 'utf-8', timeout: 10_000 });
                execSync(`git push origin main`, { cwd: workspacePath, encoding: 'utf-8', timeout: 10_000 });
                intakeLog.info(`Local mode: initialized git repo and bare origin at ${bareRepoPath}`);
                gitRoot = workspacePath;
                setLocalBareRepoPath(bareRepoPath);
            } else {
                throw new Error(
                    `Workspace is not inside a Git repository: ${workspacePath}. ` +
                    `Initialize with 'git init' in a parent directory and configure a GitHub remote before running.`
                );
            }
        }
        defaultBranch = detectDefaultBranch(gitRoot);

        gitContext = {
            token: GITHUB_TOKEN,
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            defaultBranch,
        };

        if (GITHUB_MODE === 'local') {
            const bareRepoPath = path.join(outputPath, 'origin.git');
            if (!fs.existsSync(bareRepoPath)) {
                execSync(`git init --bare "${bareRepoPath}"`, { encoding: 'utf-8', timeout: 10_000 });
                gitExec(gitRoot, `remote set-url origin "${bareRepoPath}"`);
            }
            setLocalBareRepoPath(bareRepoPath);
        }
    }

    intakeLog.info(`Git repo validated. Default branch: ${defaultBranch}, separate repo: ${isSeparateRepo}`);

    const systemBranch = buildSystemBranch(state.input.systemName);

    const remoteBranches = gitExec(gitRoot, 'branch -r').split('\n').map((b: string) => b.trim());
    const localBranches = gitExec(gitRoot, 'branch --list').split('\n').map((b: string) => b.trim().replace(/^\* /, ''));
    const existsRemote = remoteBranches.some((b: string) => b === `origin/${systemBranch}`);
    const existsLocal = localBranches.includes(systemBranch);

    if (state.input.runType === 'maintain') {
        if (existsLocal) {
            gitExec(gitRoot, `checkout ${systemBranch}`);
        } else if (existsRemote) {
            gitExec(gitRoot, `checkout -b ${systemBranch} origin/${systemBranch}`);
        } else {
            gitExec(gitRoot, `checkout ${defaultBranch}`);
            gitExec(gitRoot, `pull origin ${defaultBranch} --ff-only`);
            gitExec(gitRoot, `checkout -b ${systemBranch}`);
        }
        gitExec(gitRoot, `merge ${defaultBranch} --no-edit`);
        intakeLog.info(`System branch: ${systemBranch} (maintain mode, updated from ${defaultBranch})`);
    } else {
        gitExec(gitRoot, `checkout ${defaultBranch}`);
        gitExec(gitRoot, `pull origin ${defaultBranch} --ff-only`);
        if (existsLocal || existsRemote) {
            if (existsLocal) {
                gitExec(gitRoot, `checkout ${systemBranch}`);
            } else {
                gitExec(gitRoot, `checkout -b ${systemBranch} origin/${systemBranch}`);
            }
            gitExec(gitRoot, `merge ${defaultBranch} --no-edit`);
        } else {
            gitExec(gitRoot, `checkout -b ${systemBranch}`);
        }
        intakeLog.info(`System branch: ${systemBranch} (greenfield)`);
    }
    const pushResult = gitPush(gitRoot, systemBranch, gitContext);
    if (pushResult.startsWith('Error:')) {
        intakeLog.error(`Failed to push system branch ${systemBranch}: ${pushResult}`);
    } else {
        intakeLog.info(`Pushed system branch: ${systemBranch}`);
    }

    const defaultGitignoreEntries = [
        ...getGitignoreEntriesForStack(),
        '.conventions/',
        '.worktrees/',
        '.worktrees-failed/',
        '.agent/',
    ];
    ensureProjectGitignore(workspacePath, defaultGitignoreEntries);

    try {
        gitExec(gitRoot, 'worktree prune');
        const worktreesDir = path.join(gitRoot, '.worktrees');
        if (fs.existsSync(worktreesDir)) {
            const trackedRaw = gitExec(gitRoot, 'worktree list --porcelain');
            const trackedPaths = new Set(
                trackedRaw.split('\n')
                    .filter(l => l.startsWith('worktree '))
                    .map(l => l.slice('worktree '.length).trim()),
            );
            for (const entry of fs.readdirSync(worktreesDir)) {
                const entryPath = path.join(worktreesDir, entry);
                if (!fs.statSync(entryPath).isDirectory()) continue;
                if (!trackedPaths.has(entryPath)) {
                    fs.rmSync(entryPath, { recursive: true, force: true });
                    intakeLog.info(`Removed stale worktree leftover: ${entry}`);
                }
            }
        }
        const failedDir = path.join(gitRoot, '.worktrees-failed');
        if (fs.existsSync(failedDir)) {
            fs.rmSync(failedDir, { recursive: true, force: true });
            intakeLog.info('Pruned .worktrees-failed/ from previous run');
        }
    } catch (sweepErr) {
        intakeLog.warn(`Worktree sweep failed (non-fatal): ${sweepErr}`);
    }

    intakeLog.info(`Workspace: ${workspacePath}`);
    intakeLog.info(`Output: ${outputPath}`);
    intakeLog.info(`Run type: ${state.input.runType ?? 'greenfield'}`);

    const nextPhase = state.input.runType === 'maintain' ? 'codebase-analyzer' : 'architect';

    emitRunEvent('phase:end', { phase: 'intake', nextPhase });
    return {
        input: { ...state.input, requirementsText },
        workspacePath,
        outputPath,
        systemBranch,
        gitContext,
        phase: 'intake' as PhaseName,
        transcript: [msg('conductor', 'intake', `Intake complete (${state.input.runType ?? 'greenfield'}). System branch: ${systemBranch}. Repo: ${gitContext.owner}/${gitContext.repo}. Requirements: ${requirementsText.length} chars`)],
    };
}
