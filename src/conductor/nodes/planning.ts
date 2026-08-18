import * as path from 'path';
import { getLogger } from '../../utils/logger';
import { getAccessToken } from '../../utils/oauth-auth.util';
import { writeArtifact } from '../../agents/_shared/artifact';
import { createCodebaseAnalyzerAgent } from '../../agents/codebase-analyzer/codebase-analyzer.agent';
import { writeCodebaseAnalysis, readExistingAnalysis } from '../../utils/codebase-analysis-writer';
import { createArchitectAgent } from '../../agents/architect/architect.agent';
import { createProductManagerAgent } from '../../agents/product-manager/product-manager.agent';
import { createDbaAgent } from '../../agents/dba/dba.agent';
import { createTeamLeaderAgent } from '../../agents/team-leader/team-leader.agent';
import { sanitizeMermaidLabels } from '../../tools/diagram/diagram-tools';
import { writeRepoContract } from '../../utils/repo-contract-writer';
import {
    TOOL_PIPELINE_RECURSION_LIMIT,
    CONTEXT_MAX_CHARS,
    TEAM_LEADER_CONTEXT_MAX_CHARS,
    PLAN_COVERAGE_MODE, PLAN_COVERAGE_REPAIR_ATTEMPTS,
    REPO_CONTRACT_MAX_MODULES,
    MAX_BRANCHES,
} from '../../config';
import { CodebaseAnalysisSchema } from '../../agents/_shared/base-schemas';
import { ArchitectOutputSchema } from '../../agents/architect/schemas/architect-output.schema';
import { ProductManagerOutputSchema } from '../../agents/product-manager/schemas/pm-output.schema';
import { DbaOutputSchema } from '../../agents/dba/schemas/dba-output.schema';
import { TeamLeaderOutputSchema } from '../../agents/team-leader/schemas/tl-output.schema';
import {
    summariseArchitecture, summariseTechStack, summariseDbDesign,
    summariseStories, storiesWithCriteria, summariseTasks,
    summariseCodebaseAnalysis, summariseEpics,
    summariseRepoContract,
    buildContext, recordContextChars,
} from '../context-builder';
import type { ContextSection } from '../context-builder';
import { emitRunEvent } from '../../utils/event-bus';
import { validateAssignmentPlan, buildCoverageGapPrompt, logPlanFunnel } from '../plan-coverage';
import { consolidateBranches } from '../branch-consolidation';
import { projectSlugFromBranch } from '../../utils/branch-naming';
import { phaseNode, msg, buildFeedbackSection } from './_guards';
import { invokeAgent } from './_invoke';
import { commitAndPushArtifacts } from './_git-helpers';
import type { ProjectStateType } from '../state';
import type { PhaseName, CodebaseAnalysis } from '../../agents/_shared/base-schemas';

/* ------------------------------------------------------------------ */
/*  codebaseAnalyzerNode                                              */
/* ------------------------------------------------------------------ */

const analyzerLog = getLogger('[Analyzer]', 147);

export const codebaseAnalyzerNode = phaseNode('codebase-analyzer', analyzerLog, {}, async (state, { rerunUpdate }) => {
    analyzerLog.info('Starting codebase analysis...');
    const apiKey = await getAccessToken();
    const agent = createCodebaseAnalyzerAgent(apiKey, state.workspacePath);

    const existingAnalysis = readExistingAnalysis(state.workspacePath);
    const contextParts: string[] = [];
    const feedbackSection = buildFeedbackSection(state, 'codebase-analyzer');
    if (feedbackSection) contextParts.push(feedbackSection);
    if (existingAnalysis) {
        analyzerLog.info('Found existing codebase-analysis.md — using as baseline');
        contextParts.push(`## Previous Codebase Analysis (use as baseline, update what changed)\n\n${existingAnalysis}`);
    }
    contextParts.push(`## Task\n\nAnalyze the codebase at the workspace root and produce a comprehensive CodebaseAnalysis.`);

    const userMsg = contextParts.join('\n\n');
    const { output, tokenUsage } = await invokeAgent(agent, userMsg, 'codebase-analyzer', 'codebase-analyzer', 'codebase-analyzer', { recursionLimit: TOOL_PIPELINE_RECURSION_LIMIT, schema: CodebaseAnalysisSchema });

    analyzerLog.info(`Analysis complete: ${output.modules?.length ?? 0} modules, ${output.primaryLanguages?.length ?? 0} languages`);
    analyzerLog.info(`Architecture: ${output.architecture?.style ?? 'unknown'}`);

    writeCodebaseAnalysis(output, state.workspacePath, state.outputPath);

    const artifact = writeArtifact({
        agentId: 'codebase-analyzer',
        colorCode: 147,
        workspacePath: state.workspacePath, outputPath: state.outputPath,
        title: 'Codebase Analyzer Mission Report',
        content: [
            `## Project: ${output.projectName} (${output.projectType})`,
            `\n## Languages: ${(output.primaryLanguages ?? []).join(', ')}`,
            `\n## Frameworks: ${(output.frameworks ?? []).join(', ')}`,
            `\n## Architecture: ${output.architecture?.style}`,
            `\n${output.architecture?.description ?? ''}`,
            output.architecture?.mermaidDiagram ? `\n\`\`\`mermaid\n${sanitizeMermaidLabels(output.architecture.mermaidDiagram)}\n\`\`\`` : '',
            `\n## Modules (${(output.modules ?? []).length})`,
            ...(output.modules ?? []).map((m: any) => `- **${m.name}** (\`${m.path}\`): ${m.responsibility}`),
            `\n## Known Issues (${(output.knownIssues ?? []).length})`,
            ...(output.knownIssues ?? []).map((i: string) => `- ${i}`),
        ].join('\n'),
    });

    const systemSlug = path.basename(state.workspacePath);
    await commitAndPushArtifacts(
        state.workspacePath,
        `[${systemSlug}]-docs: codebase analyzer mission report`,
        state.gitContext,
        analyzerLog,
    );

    emitRunEvent('phase:end', { phase: 'codebase-analyzer', nextPhase: 'architect' });
    return {
        ...rerunUpdate,
        codebaseAnalysis: output as CodebaseAnalysis,
        phase: 'codebase-analyzer' as PhaseName,
        artifacts: [artifact],
        transcript: [msg('codebase-analyzer', 'codebase-analyzer', `Analyzed ${output.modules?.length ?? 0} modules across ${output.primaryLanguages?.length ?? 0} languages`)],
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
});

/* ------------------------------------------------------------------ */
/*  architectNode                                                     */
/* ------------------------------------------------------------------ */

const archLog = getLogger('[Architect]', 39);

export const architectNode = phaseNode('architect', archLog, {}, async (state, { rerunUpdate }) => {
    archLog.info('Starting architecture phase...');
    const apiKey = await getAccessToken();
    const agent = createArchitectAgent(apiKey);

    let userMsg: string;
    {
        const sections: ContextSection[] = [
            { title: 'System Requirements', body: state.input.requirementsText, priority: 1 },
        ];
        const feedbackSection = buildFeedbackSection(state, 'architect');
        if (feedbackSection) sections.unshift({ title: 'Reviewer Feedback', body: feedbackSection, priority: 1 });
        if (state.codebaseAnalysis) {
            sections.unshift({ title: 'Existing Codebase Analysis', body: summariseCodebaseAnalysis(state.codebaseAnalysis), priority: 2 });
            sections.push({ title: 'NOTE', body: 'This is MAINTAIN mode. Design CHANGES to the existing system, not a new system from scratch.', priority: 1 });
        }
        userMsg = buildContext(sections, CONTEXT_MAX_CHARS);
    }
    archLog.info(`Context [architect]: ${userMsg.length} chars`);
    recordContextChars('architect', userMsg.length);
    const { output, tokenUsage } = await invokeAgent(agent, userMsg, 'architect', 'architect', 'architect', { schema: ArchitectOutputSchema });

    archLog.info(`Architecture: ${output.architecture?.components?.length ?? 0} components`);
    archLog.info(`Tech decisions: ${output.techStack?.length ?? 0}`);
    archLog.info(`Epics: ${output.epics?.length ?? 0}`);

    let repoContract = output.repoContract ?? null;
    if (repoContract) {
        if (repoContract.modules.length > REPO_CONTRACT_MAX_MODULES) {
            archLog.warn(`Repo contract has ${repoContract.modules.length} modules — capping to ${REPO_CONTRACT_MAX_MODULES}`);
            repoContract = { ...repoContract, modules: repoContract.modules.slice(0, REPO_CONTRACT_MAX_MODULES) };
        }
        archLog.info(`Repo contract: layout=${repoContract.layout}, ${repoContract.roots.length} roots, ${repoContract.modules.length} modules`);
        try {
            writeRepoContract(state.workspacePath, repoContract);
        } catch (err: any) {
            archLog.error(`Failed to write repo contract: ${err.message}`);
        }
    } else {
        archLog.warn('Architect did not produce a repoContract');
    }

    const artifact = writeArtifact({
        agentId: 'architect',
        colorCode: 39,
        workspacePath: state.workspacePath, outputPath: state.outputPath,
        title: 'Architect Mission Report',
        content: [
            `## Architecture Style\n\n${output.architecture?.style}`,
            `\n## Components\n\n${(output.architecture?.components ?? []).map((c: any) => `- **${c.name}** (${c.type}): ${c.description}`).join('\n')}`,
            `\n## Tech Stack\n\n${(output.techStack ?? []).map((t: any) => `- **${t.layer}**: ${t.choice} — ${t.rationale}`).join('\n')}`,
            `\n## Epics\n\n${(output.epics ?? []).map((e: any) => `- **${e.id}** ${e.title}: ${e.description}`).join('\n')}`,
            output.architecture?.mermaidDiagram ? `\n## Architecture Diagram\n\n\`\`\`mermaid\n${sanitizeMermaidLabels(output.architecture.mermaidDiagram)}\n\`\`\`` : '',
        ].join('\n'),
    });

    const systemSlug = path.basename(state.workspacePath);
    await commitAndPushArtifacts(
        state.workspacePath,
        `[${systemSlug}]-docs: architect mission report`,
        state.gitContext,
        archLog,
    );

    emitRunEvent('phase:end', { phase: 'architect', nextPhase: 'product-manager' });
    return {
        ...rerunUpdate,
        architecture: output.architecture,
        repoContract,
        techStack: output.techStack ?? [],
        epics: output.epics ?? [],
        phase: 'architect' as PhaseName,
        artifacts: [artifact],
        transcript: [msg('architect', 'architect', `Designed ${output.architecture?.components?.length ?? 0} components, ${output.epics?.length ?? 0} epics, contract: ${repoContract ? repoContract.modules.length + ' modules' : 'none'}`)],
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
});

/* ------------------------------------------------------------------ */
/*  productManagerNode                                                */
/* ------------------------------------------------------------------ */

const pmLog = getLogger('[Product Manager]', 214);

export const productManagerNode = phaseNode('product-manager', pmLog, {}, async (state, { rerunUpdate }) => {
    pmLog.info('Starting product management phase...');
    const apiKey = await getAccessToken();
    const agent = createProductManagerAgent(apiKey);

    let userMsg: string;
    {
        const sections: ContextSection[] = [
            { title: 'Architecture', body: summariseArchitecture(state.architecture), priority: 2 },
            { title: 'Tech Stack', body: summariseTechStack(state.techStack), priority: 2 },
            { title: 'Repo Contract', body: summariseRepoContract(state.repoContract), priority: 1 },
            { title: 'Epics', body: summariseEpics(state.epics), priority: 1 },
            { title: 'Original Requirements', body: state.input.requirementsText, priority: 1 },
        ];
        const feedbackSection = buildFeedbackSection(state, 'product-manager');
        if (feedbackSection) sections.unshift({ title: 'Reviewer Feedback', body: feedbackSection, priority: 1 });
        if (state.codebaseAnalysis) {
            sections.unshift({ title: 'Existing Codebase Analysis', body: summariseCodebaseAnalysis(state.codebaseAnalysis), priority: 3 });
            sections.push({ title: 'NOTE', body: 'This is MAINTAIN mode. Create stories/tasks for CHANGES to the existing system.', priority: 1 });
        }
        userMsg = buildContext(sections, CONTEXT_MAX_CHARS);
    }
    pmLog.info(`Context [product-manager]: ${userMsg.length} chars`);
    recordContextChars('product-manager', userMsg.length);

    const { output, tokenUsage } = await invokeAgent(agent, userMsg, 'pm', 'product-manager', 'product-manager', { schema: ProductManagerOutputSchema });
    pmLog.info(`Stories: ${output.userStories?.length ?? 0}, Tasks: ${output.tasks?.length ?? 0}`);

    const artifact = writeArtifact({
        agentId: 'product-manager',
        colorCode: 214,
        workspacePath: state.workspacePath, outputPath: state.outputPath,
        title: 'Product Manager Mission Report',
        content: [
            `## User Stories (${output.userStories?.length ?? 0})\n`,
            ...(output.userStories ?? []).map((s: any) => `### ${s.id}: As a ${s.asA}, I want ${s.iWant}\n- So that: ${s.soThat}\n- AC: ${s.acceptanceCriteria?.join('; ')}`),
            `\n## Tasks (${output.tasks?.length ?? 0})\n`,
            ...(output.tasks ?? []).map((t: any) => `- **${t.id}** [${t.layer}/${t.suggestedTech}] ${t.title}`),
        ].join('\n'),
    });

    const systemSlug = path.basename(state.workspacePath);
    await commitAndPushArtifacts(
        state.workspacePath,
        `[${systemSlug}]-docs: product manager mission report`,
        state.gitContext,
        pmLog,
    );

    emitRunEvent('phase:end', { phase: 'product-manager', nextPhase: 'dba' });
    return {
        ...rerunUpdate,
        userStories: output.userStories ?? [],
        tasks: output.tasks ?? [],
        phase: 'product-manager' as PhaseName,
        artifacts: [artifact],
        transcript: [msg('product-manager', 'product-manager', `Created ${output.userStories?.length ?? 0} stories, ${output.tasks?.length ?? 0} tasks`)],
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
});

/* ------------------------------------------------------------------ */
/*  dbaNode                                                           */
/* ------------------------------------------------------------------ */

const dbaLog = getLogger('[DBA]', 100);

export const dbaNode = phaseNode('dba', dbaLog, {}, async (state, { rerunUpdate }) => {
    dbaLog.info('Starting database design phase...');
    const apiKey = await getAccessToken();
    const agent = createDbaAgent(apiKey);

    let userMsg: string;
    {
        const sections: ContextSection[] = [
            { title: 'Architecture', body: summariseArchitecture(state.architecture), priority: 3 },
            { title: 'Tech Stack', body: summariseTechStack(state.techStack), priority: 2 },
            { title: 'Repo Contract', body: summariseRepoContract(state.repoContract), priority: 2 },
            { title: 'User Stories', body: summariseStories(state.userStories), priority: 2 },
            { title: 'Tasks', body: summariseTasks(state.tasks), priority: 3 },
        ];
        const feedbackSection = buildFeedbackSection(state, 'dba');
        if (feedbackSection) sections.unshift({ title: 'Reviewer Feedback', body: feedbackSection, priority: 1 });
        if (state.codebaseAnalysis) {
            sections.unshift({ title: 'Existing Codebase Analysis', body: summariseCodebaseAnalysis(state.codebaseAnalysis), priority: 3 });
            sections.push({ title: 'NOTE', body: 'This is MAINTAIN mode. Design only the DB CHANGES needed, not the full schema from scratch.', priority: 1 });
        }
        userMsg = buildContext(sections, CONTEXT_MAX_CHARS);
    }
    dbaLog.info(`Context [dba]: ${userMsg.length} chars`);
    recordContextChars('dba', userMsg.length);

    const { output, tokenUsage } = await invokeAgent(agent, userMsg, 'dba', 'dba', 'dba', { schema: DbaOutputSchema });
    dbaLog.info(`DB engine: ${output.dbDesign?.engine}, Entities: ${output.dbDesign?.entities?.length ?? 0}`);

    const artifact = writeArtifact({
        agentId: 'dba',
        tag: '[DBA]',
        colorCode: 100,
        workspacePath: state.workspacePath, outputPath: state.outputPath,
        title: 'DBA Mission Report',
        content: [
            `## Database Engine: ${output.dbDesign?.engine}\n\n${output.dbDesign?.rationale}`,
            `\n## Entities (${output.dbDesign?.entities?.length ?? 0})\n`,
            ...(output.dbDesign?.entities ?? []).map((e: any) => `- **${e.name}**: ${e.columns?.length ?? 0} columns`),
            output.dbDesign?.erdMermaid ? `\n## ERD\n\n\`\`\`mermaid\n${sanitizeMermaidLabels(output.dbDesign.erdMermaid)}\n\`\`\`` : '',
        ].join('\n'),
    });

    const systemSlug = path.basename(state.workspacePath);
    await commitAndPushArtifacts(
        state.workspacePath,
        `[${systemSlug}]-docs: DBA mission report`,
        state.gitContext,
        dbaLog,
    );

    emitRunEvent('phase:end', { phase: 'dba', nextPhase: 'team-leader' });
    return {
        ...rerunUpdate,
        dbDesign: output.dbDesign,
        phase: 'dba' as PhaseName,
        artifacts: [artifact],
        transcript: [msg('dba', 'dba', `Designed ${output.dbDesign?.entities?.length ?? 0} entities on ${output.dbDesign?.engine}`)],
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
});

/* ------------------------------------------------------------------ */
/*  teamLeaderNode                                                    */
/* ------------------------------------------------------------------ */

const tlLog = getLogger('[Team Leader]', 213);

export const teamLeaderNode = phaseNode('team-leader', tlLog, {}, async (state, { rerunUpdate }) => {
    tlLog.info('Starting assignment phase...');
    const apiKey = await getAccessToken();
    const agent = createTeamLeaderAgent(apiKey);

    const projectSlug = projectSlugFromBranch(state.systemBranch);

    let userMsg: string;
    {
        const sections: ContextSection[] = [
            { title: 'Architecture', body: summariseArchitecture(state.architecture), priority: 2 },
            { title: 'Tech Stack', body: summariseTechStack(state.techStack), priority: 2 },
            { title: 'Repo Contract', body: summariseRepoContract(state.repoContract), priority: 1 },
            { title: 'DB Design', body: summariseDbDesign(state.dbDesign, 'compact'), priority: 3 },
            { title: 'User Stories (with Acceptance Criteria)', body: storiesWithCriteria(state.userStories), priority: 1 },
            { title: 'Tasks', body: summariseTasks(state.tasks), priority: 1 },
            { title: 'Project Slug', body: `${projectSlug}\nUse this slug as the prefix for all branch names (e.g., "${projectSlug}/feature/US-001-description").`, priority: 1 },
        ];
        const feedbackSection = buildFeedbackSection(state, 'team-leader');
        if (feedbackSection) sections.unshift({ title: 'Reviewer Feedback', body: feedbackSection, priority: 1 });
        if (state.codebaseAnalysis) {
            sections.unshift({ title: 'Existing Codebase Analysis', body: summariseCodebaseAnalysis(state.codebaseAnalysis), priority: 3 });
            sections.push({ title: 'NOTE', body: 'This is MAINTAIN mode. Assignments may involve modifying existing files.', priority: 1 });
        }
        userMsg = buildContext(sections, TEAM_LEADER_CONTEXT_MAX_CHARS);
    }
    tlLog.info(`Context [team-leader]: ${userMsg.length} chars`);
    recordContextChars('team-leader', userMsg.length);

    const { output, tokenUsage } = await invokeAgent(agent, userMsg, 'tl', 'team-leader', 'team-leader', { schema: TeamLeaderOutputSchema });
    let assignments = output.assignments ?? [];
    tlLog.info(`Assignments: ${assignments.length}`);
    if (output.coverageNote) tlLog.info(`Coverage self-check: ${output.coverageNote}`);

    // ── Plan coverage validation (P9)
    if (PLAN_COVERAGE_MODE !== 'off') {
        const tempState = { ...state, assignments: [...state.assignments, ...assignments] };
        let violations = validateAssignmentPlan(tempState);

        for (let attempt = 0; attempt < PLAN_COVERAGE_REPAIR_ATTEMPTS && violations.length > 0; attempt++) {
            const criticalCount = violations.filter(v => v.severity === 'critical').length;
            if (criticalCount === 0) break;

            const nextId = assignments.length > 0
                ? Math.max(...assignments.map((a: { id: string }) => parseInt(a.id.replace(/\D/g, '') || '0', 10))) + 1
                : 1;
            const gapPrompt = buildCoverageGapPrompt(violations, nextId);
            tlLog.info(`Plan coverage repair attempt ${attempt + 1}/${PLAN_COVERAGE_REPAIR_ATTEMPTS}: ${violations.length} violation(s), ${criticalCount} critical`);

            try {
                const { output: gapOutput } = await invokeAgent(agent, gapPrompt, `tl-gap-${attempt}`, 'team-leader', 'team-leader', { schema: TeamLeaderOutputSchema });
                const additions = gapOutput.assignments ?? [];
                if (additions.length > 0) {
                    tlLog.info(`Gap repair produced ${additions.length} additional assignment(s)`);
                    assignments = assignments.concat(additions);
                    const revalidateState = { ...state, assignments: [...state.assignments, ...assignments] };
                    violations = validateAssignmentPlan(revalidateState);
                }
            } catch (err: any) {
                tlLog.warn(`Gap repair attempt ${attempt + 1} failed: ${err?.message ?? err}`);
            }
        }

        const funnelState = { ...state, assignments: [...state.assignments, ...assignments] };
        logPlanFunnel(funnelState);

        if (violations.length > 0) {
            const criticalCount = violations.filter(v => v.severity === 'critical').length;
            const summaryMsg = `Coverage: ${state.userStories.length - violations.filter(v => v.kind === 'story-without-assignment').length}/${state.userStories.length} stories assigned, ${violations.length} violation(s) (${criticalCount} critical)`;
            if (PLAN_COVERAGE_MODE === 'enforce') {
                for (const v of violations) tlLog.error(`[PLAN] ${v.severity}: ${v.detail}`);
                tlLog.error(summaryMsg);
            } else {
                for (const v of violations) tlLog.warn(`[PLAN] ${v.severity}: ${v.detail}`);
                tlLog.warn(summaryMsg);
            }
            emitRunEvent('plan:coverage', { violations: violations.length, stories: state.userStories.length, assigned: state.userStories.length - violations.filter(v => v.kind === 'story-without-assignment').length });
        } else {
            tlLog.info(`Plan coverage: all stories and tasks assigned — 0 violations`);
        }
    }

    // ── Post-plan branch consolidation (Plan 24, E3)
    {
        const { assignments: consolidated, consolidationLog } = consolidateBranches(
            assignments,
            MAX_BRANCHES,
            state.userStories,
        );
        if (consolidationLog.length > 0) {
            for (const line of consolidationLog) tlLog.info(`[CONSOLIDATION] ${line}`);
        }
        assignments = consolidated;
    }

    const artifact = writeArtifact({
        agentId: 'team-leader',
        colorCode: 213,
        workspacePath: state.workspacePath, outputPath: state.outputPath,
        title: 'Team Leader Mission Report',
        content: [
            `## Assignments (${assignments.length})\n`,
            ...assignments.map((a: any) =>
                `### ${a.id} -> ${a.devAgentId} [${a.rank}]\n- Priority: ${a.priority} | Complexity: ${a.complexity}\n- ${a.description}`
            ),
        ].join('\n'),
    });

    const systemSlug = path.basename(state.workspacePath);
    await commitAndPushArtifacts(
        state.workspacePath,
        `[${systemSlug}]-docs: team leader mission report`,
        state.gitContext,
        tlLog,
    );

    const planViolations = PLAN_COVERAGE_MODE !== 'off'
        ? validateAssignmentPlan({ ...state, assignments: [...state.assignments, ...assignments] })
            .map(v => ({ kind: v.kind, severity: v.severity, id: v.id, detail: v.detail }))
        : [];

    emitRunEvent('phase:end', { phase: 'team-leader', nextPhase: 'development' });
    return {
        ...rerunUpdate,
        assignments,
        planViolations,
        phase: 'team-leader' as PhaseName,
        artifacts: [artifact],
        transcript: [msg('team-leader', 'team-leader', `Created ${assignments.length} assignments`)],
        tokenUsage: tokenUsage ? [tokenUsage] : [],
    };
});
