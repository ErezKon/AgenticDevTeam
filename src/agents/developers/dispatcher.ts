/**
 * Developer Dispatcher — fans out assignments to developer agents.
 *
 * Groups assignments by devAgentId, respects dependency ordering,
 * and runs up to MAX_CONCURRENT_DEVS agents in parallel.
 */
import { MAX_CONCURRENT_DEVS } from '../../config';
import { getLogger } from '../../utils/logger';
import { writeArtifact } from '../_shared/artifact';
import { buildDevAgent } from './dev-agent.builder';
import { getDevAgent, type DevAgentEntry } from './registry';
import type { Assignment, FileChange, ArtifactRef, TranscriptMessage, PhaseName } from '../_shared/base-schemas';
import type { DeveloperOutput } from './schemas/dev-output.schema';

const log = getLogger('[Dispatcher]', 226);

export interface DispatchResult {
    fileChanges: FileChange[];
    artifacts: ArtifactRef[];
    transcript: TranscriptMessage[];
}

/**
 * Topological sort on assignments by dependsOn.
 * Returns assignments in execution order (groups of independent assignments).
 */
function topoSort(assignments: Assignment[]): Assignment[][] {
    const map = new Map<string, Assignment>();
    for (const a of assignments) map.set(a.id, a);

    const completed = new Set<string>();
    const layers: Assignment[][] = [];

    while (completed.size < assignments.length) {
        const ready = assignments.filter(
            a => !completed.has(a.id) &&
                a.dependsOn.every(dep => completed.has(dep))
        );
        if (ready.length === 0) {
            // Remaining are cyclic — just push them all
            const remaining = assignments.filter(a => !completed.has(a.id));
            layers.push(remaining);
            break;
        }
        layers.push(ready);
        for (const a of ready) completed.add(a.id);
    }
    return layers;
}

/**
 * Run a single developer agent on its batch of assignments.
 */
async function runDevAgent(
    apiKey: string,
    entry: DevAgentEntry,
    myAssignments: Assignment[],
    workspacePath: string,
    context: string,
): Promise<{ output: DeveloperOutput; entry: DevAgentEntry }> {
    const devLog = getLogger(entry.tag, entry.colorCode);
    devLog.info(`Starting work on ${myAssignments.length} assignment(s)...`);

    const agent = buildDevAgent(apiKey, entry, workspacePath);

    const assignmentText = myAssignments.map(a =>
        `Assignment ${a.id} [${a.priority}/${a.complexity}]: ${a.description}`
    ).join('\n\n');

    const message = `${context}\n\n## Your Assignments\n\n${assignmentText}`;

    const result = await agent.invoke(
        { messages: [{ role: 'user', content: message }] },
        { configurable: { thread_id: `dev-${entry.id}-${Date.now()}` } },
    );

    const lastMsg = result.messages[result.messages.length - 1];
    const parsed = typeof lastMsg.content === 'string'
        ? JSON.parse(lastMsg.content) as DeveloperOutput
        : lastMsg.content as DeveloperOutput;

    devLog.info(`Completed: ${parsed.fileChanges?.length ?? 0} file changes`);
    return { output: parsed, entry };
}

/**
 * Dispatch all assignments to developer agents.
 *
 * @param apiKey       LLM token
 * @param assignments  All assignments from the Team Leader
 * @param workspacePath Generated project workspace path
 * @param contextPrompt Context string (architecture, tech stack, DB design summary)
 */
export async function dispatchDevelopers(
    apiKey: string,
    assignments: Assignment[],
    workspacePath: string,
    contextPrompt: string,
): Promise<DispatchResult> {
    const fileChanges: FileChange[] = [];
    const artifacts: ArtifactRef[] = [];
    const transcript: TranscriptMessage[] = [];

    const layers = topoSort(assignments);
    log.info(`Dispatch plan: ${layers.length} layer(s), ${assignments.length} total assignments`);

    for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        log.info(`Layer ${i + 1}/${layers.length}: ${layer.length} assignments`);

        // Group by developer
        const byDev = new Map<string, Assignment[]>();
        for (const a of layer) {
            const existing = byDev.get(a.devAgentId) ?? [];
            existing.push(a);
            byDev.set(a.devAgentId, existing);
        }

        // Fan out with concurrency limit
        const devEntries = Array.from(byDev.entries());
        for (let j = 0; j < devEntries.length; j += MAX_CONCURRENT_DEVS) {
            const batch = devEntries.slice(j, j + MAX_CONCURRENT_DEVS);
            const promises = batch.map(([devId, devAssignments]) => {
                const entry = getDevAgent(devId);
                if (!entry) {
                    log.warn(`Unknown dev agent: ${devId}, skipping ${devAssignments.length} assignments`);
                    return Promise.resolve(null);
                }
                return runDevAgent(apiKey, entry, devAssignments, workspacePath, contextPrompt);
            });

            const results = await Promise.allSettled(promises);
            for (const r of results) {
                if (r.status === 'fulfilled' && r.value) {
                    const { output, entry } = r.value;
                    if (output.fileChanges) fileChanges.push(...output.fileChanges);

                    // Write mission report
                    const artifact = writeArtifact({
                        agentId: entry.id,
                        colorCode: entry.colorCode,
                        workspacePath,
                        title: `${entry.name} Mission Report`,
                        content: [
                            `## Files Changed\n`,
                            ...(output.fileChanges ?? []).map(fc =>
                                `- **${fc.action}** \`${fc.path}\` — ${fc.summary}`
                            ),
                            output.notes ? `\n## Notes\n\n${output.notes}` : '',
                            output.mermaidDiagram ? `\n## Diagram\n\n\`\`\`mermaid\n${output.mermaidDiagram}\n\`\`\`` : '',
                        ].join('\n'),
                    });
                    artifacts.push(artifact);

                    transcript.push({
                        timestamp: new Date().toISOString(),
                        agentId: entry.id,
                        phase: 'development' as PhaseName,
                        message: `Completed ${output.fileChanges?.length ?? 0} file changes`,
                    });
                } else if (r.status === 'rejected') {
                    log.error(`Dev agent failed: ${r.reason}`);
                    transcript.push({
                        timestamp: new Date().toISOString(),
                        agentId: 'dispatcher',
                        phase: 'development' as PhaseName,
                        message: `Agent failed: ${r.reason}`,
                    });
                }
            }
        }
    }

    log.info(`Dispatch complete: ${fileChanges.length} total file changes, ${artifacts.length} artifacts`);
    return { fileChanges, artifacts, transcript };
}
