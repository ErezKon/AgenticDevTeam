/**
 * DevOps node — infrastructure deployment, Dockerfile fallback,
 * SSL patching, and deployment verification.
 */
import * as path from 'path';
import { getLogger } from '../../utils/logger';
import { getAccessToken } from '../../utils/oauth-auth.util';
import { createDevOpsAgent } from '../../agents/devops/devops.agent';
import { writeArtifact } from '../../agents/_shared/artifact';
import { deployConventionsToWorkspace, resolveConventionFiles } from '../../utils/coding-conventions';
import { findGitRoot } from '../../utils/git-exec';
import { syncWorkspaceToBranch } from '../workspace-sync';
import { detectStackRoots } from '../quality-gates';
import { verifyDeployment } from '../devops-verify';
import { makeGateBug } from '../bug-factory';
import { DevOpsOutputSchema } from '../../agents/devops/schemas/devops-output.schema';
import {
    CONTEXT_MAX_CHARS, DEV_CONTEXT_FILE_CHANGES_LIMIT,
    TOOL_PIPELINE_RECURSION_LIMIT,
    DEVOPS_VERIFY_ENABLED, DEVOPS_FALLBACK_ENABLED,
} from '../../config';
import {
    summariseArchitecture, summariseTechStack, summariseDbDesign,
    summariseFileChanges, summariseCodebaseAnalysis,
    buildContext, recordContextChars,
} from '../context-builder';
import type { ContextSection } from '../context-builder';
import { emitRunEvent } from '../../utils/event-bus';
import type { TokenCallRecord } from '../../utils/token-tracker';
import { phaseNode, msg } from './_guards';
import { invokeAgent } from './_invoke';
import { ensureNodeLockfile, patchDockerfilesSsl, commitAndPushArtifacts } from './_git-helpers';
import type { ProjectStateType } from '../state';
import type { PhaseName, TranscriptMessage, Bug } from '../../agents/_shared/base-schemas';

const opsLog = getLogger('[DevOps]', 33);

export const devopsNode = phaseNode('devops', opsLog, { haltCheck: true }, async (state, { rerunUpdate }) => {
    opsLog.info('Starting DevOps phase...');
    const apiKey = await getAccessToken();

    // ── Sync workspace before DevOps (idempotent — protects HITL resume)
    let devopsGitRoot: string;
    try {
        devopsGitRoot = findGitRoot(state.workspacePath);
    } catch {
        devopsGitRoot = state.workspacePath;
    }
    const devopsSyncResult = await syncWorkspaceToBranch(devopsGitRoot, state.systemBranch, state.gitContext);
    opsLog.info(`Workspace synced to origin/${state.systemBranch}: ${devopsSyncResult.details}`);

    // ── Ensure Node.js lockfile is in sync before DevOps
    await ensureNodeLockfile(state.workspacePath, state.systemBranch, state.gitContext, opsLog);

    // Deploy only the convention files DevOps agent needs (fixes A11)
    const devopsConventionFiles = resolveConventionFiles([], state.techStack);
    deployConventionsToWorkspace(state.workspacePath, devopsConventionFiles);

    let output: any = { devops: { buildStatus: 'failed', runStatus: 'failed', serviceUrls: [], healthChecks: [] }, fileChanges: [] };
    let tokenUsage: TokenCallRecord | null = null;
    const transcript: TranscriptMessage[] = [];
    let verifiedContainers: string[] = [];

    try {
        const agent = createDevOpsAgent(apiKey, state.workspacePath, devopsConventionFiles);

        let userMsg: string;
        {
            const sections: ContextSection[] = [
                { title: 'Architecture', body: summariseArchitecture(state.architecture), priority: 2 },
                { title: 'Tech Stack', body: summariseTechStack(state.techStack), priority: 1 },
                { title: 'DB Design', body: summariseDbDesign(state.dbDesign, 'compact'), priority: 3 },
                { title: 'File Changes', body: summariseFileChanges(state.fileChanges, DEV_CONTEXT_FILE_CHANGES_LIMIT), priority: 3 },
            ];
            if (state.codebaseAnalysis) {
                sections.unshift({ title: 'Existing Codebase Analysis', body: summariseCodebaseAnalysis(state.codebaseAnalysis), priority: 3 });
                sections.push({ title: 'NOTE', body: 'This is MAINTAIN mode. Update existing Docker/K8s configs rather than creating from scratch.', priority: 1 });
            }
            userMsg = buildContext(sections, CONTEXT_MAX_CHARS);
        }
        opsLog.info(`Context [devops]: ${userMsg.length} chars`);
        recordContextChars('devops', userMsg.length);

        const r = await invokeAgent(agent, userMsg, 'devops', 'devops', 'devops', { recursionLimit: TOOL_PIPELINE_RECURSION_LIMIT, schema: DevOpsOutputSchema });
        output = r.output;
        tokenUsage = r.tokenUsage;
        opsLog.info(`Build: ${output.devops?.buildStatus}, Run: ${output.devops?.runStatus}`);
    } catch (err: any) {
        opsLog.error(`DevOps agent failed: ${err.message}`);
        if (err?.stack) opsLog.error(err.stack);
        transcript.push(msg('devops', 'devops', `DevOps agent failed: ${err.message}`));
    }

    // ── Deterministic Dockerfile fallback (D11)
    if (DEVOPS_FALLBACK_ENABLED) {
        const mode = (await import('../devops-verify')).chooseDeploymentMode(state.workspacePath);
        if (mode === 'none') {
            opsLog.info('No Docker artifacts after DevOps agent — generating fallback deployment');
            try {
                const { generateFallbackDeployment } = await import('../devops-fallback');
                const roots = state.latestGateReport?.roots ?? detectStackRoots(state.workspacePath);
                const fallback = generateFallbackDeployment(state.workspacePath, roots, state.repoContract);
                if (fallback.files.length > 0) {
                    opsLog.info(`Fallback generated ${fallback.files.length} file(s): ${fallback.composeServices.join(', ')}`);
                    emitRunEvent('devops:fallback', { files: fallback.files.length, services: fallback.composeServices });
                }
            } catch (fbErr: any) {
                opsLog.warn(`Fallback deployment generation failed: ${fbErr.message}`);
            }
        }
    }

    // ── Patch Dockerfiles for SSL (failsafe for self-signed certs)
    patchDockerfilesSsl(state.workspacePath, opsLog);

    // ── Verify deployment for real (fixes A5, D2)
    const verificationErrors: Array<{ stage: string; message: string }> = [];
    const verified = await verifyDeployment(state.workspacePath, path.basename(state.workspacePath));
    {
        const claimedUrls = output.devops?.serviceUrls ?? [];
        output.devops = {
            ...output.devops,
            buildStatus: verified.buildStatus,
            runStatus: verified.runStatus,
            serviceUrls: verified.serviceUrls ?? [],
            healthChecks: verified.healthChecks ?? [],
            verificationMode: verified.mode,
        };
        if (claimedUrls.length > 0 && (verified.serviceUrls ?? []).length === 0) {
            opsLog.error(`DevOps agent claimed ${claimedUrls.length} service URL(s) but verification produced none — discarding the claims.`);
            verificationErrors.push({ stage: 'devops', message: 'unverified serviceUrls discarded' });
        }
        verifiedContainers = verified.containerNames;
        transcript.push(msg('devops', 'devops', `Deployment verification: mode=${verified.mode}, build=${verified.buildStatus}, run=${verified.runStatus}, services=${(verified.serviceUrls ?? []).length}`));
    }

    // ── Synthesise deployment bugs (D5)
    const deployBugs: Bug[] = [];
    if (verified.buildStatus === 'failed') {
        deployBugs.push(makeGateBug(
            'DEPLOY-BUILD-FAILED',
            'Deployment build failed',
            'critical',
            'devops-verify',
            'Run docker build / docker compose up --build',
            'Docker build should succeed',
            `Build failed: ${(verified.logs ?? '').slice(-500)}`,
            'Dockerfile / docker-compose.yml',
        ));
    }
    if (verified.runStatus === 'unhealthy') {
        const failedChecks = (verified.healthChecks ?? []).filter(h => h.status !== 'healthy');
        deployBugs.push(makeGateBug(
            'DEPLOY-UNHEALTHY',
            'Deployment services unhealthy',
            'critical',
            'devops-verify',
            'Start containers and health-check all published ports',
            'All services should respond with HTTP 200',
            `${failedChecks.length} health check(s) failed: ${failedChecks.map(h => `${h.service}=${h.status}`).join(', ')}`,
            'Service health endpoints / port bindings',
        ));
    }

    const artifactContent = [
        `## Build Status: ${output.devops?.buildStatus ?? 'unknown'}`,
        `## Run Status: ${output.devops?.runStatus ?? 'unknown'}`,
        `\n## Services\n\n${(output.devops?.serviceUrls ?? []).map((s: any) => `- **${s.service}**: ${s.url}`).join('\n')}`,
        `\n## Health Checks\n\n${(output.devops?.healthChecks ?? []).map((h: any) => `- ${h.service}: ${h.status}`).join('\n')}`,
    ];
    if (DEVOPS_VERIFY_ENABLED && output.devops?.logs) {
        artifactContent.push(`\n## Verification Logs\n\n\`\`\`\n${output.devops.logs}\n\`\`\``);
    }

    const artifact = writeArtifact({
        agentId: 'devops', colorCode: 33, workspacePath: state.workspacePath, outputPath: state.outputPath,
        title: 'DevOps Mission Report',
        content: artifactContent.join('\n'),
    });

    // Commit DevOps-generated files via the shared helper (includes sync + retry)
    const devopsSlug = path.basename(state.workspacePath);
    await commitAndPushArtifacts(
        state.workspacePath,
        `[${devopsSlug}]-chore: DevOps configuration files`,
        state.gitContext,
        opsLog,
    );

    transcript.push(msg('devops', 'devops', `Build: ${output.devops?.buildStatus ?? 'unknown'}, Run: ${output.devops?.runStatus ?? 'unknown'}`));

    emitRunEvent('phase:end', { phase: 'devops', nextPhase: 'e2e', buildStatus: output.devops?.buildStatus ?? 'unknown' });
    return {
        ...rerunUpdate,
        devopsPlan: output.devops,
        fileChanges: output.fileChanges ?? [],
        runningContainers: verifiedContainers,
        bugs: deployBugs,
        verificationErrors,
        phase: 'devops' as PhaseName,
        artifacts: [artifact],
        transcript,
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
});
