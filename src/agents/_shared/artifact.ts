/**
 * Mission-report artifact writer.
 *
 * Each agent calls writeArtifact() to produce a markdown file
 * documenting what it was asked to do and how it did it.
 * Files are written into the generated project's docs/agents/ directory.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../../utils/logger';
import { getAgentEntry } from '../registry';
import type { ArtifactRef } from './base-schemas';

interface ArtifactOptions {
    /** Agent ID (e.g. "architect", "junior-react"). */
    agentId: string;
    /** Agent color code for logging. */
    colorCode: number;
    /** Root of the generated project workspace. */
    workspacePath: string;
    /** Artifact title (e.g. "Architect Mission Report"). */
    title: string;
    /** Markdown content (body of the report). */
    content: string;
    /** Optional suffix for the filename (e.g. a story ID). */
    suffix?: string;
    /** Optional display tag override for the logger (e.g. '[DBA]'). Defaults to '[<agentId>]'. */
    tag?: string;
}

/**
 * Write a markdown mission report for an agent.
 * Returns an ArtifactRef to record in the project state.
 */
export function writeArtifact(opts: ArtifactOptions): ArtifactRef {
    const registryTag = getAgentEntry(opts.agentId)?.tag;
    const log = getLogger(opts.tag ?? registryTag ?? `[${opts.agentId}]`, opts.colorCode);

    const filename = opts.suffix
        ? `${opts.agentId}-${opts.suffix}-mission.md`
        : `${opts.agentId}-mission.md`;

    const docsDir = path.join(opts.workspacePath, 'docs', 'agents');
    fs.mkdirSync(docsDir, { recursive: true });
    const filePath = path.join(docsDir, filename);

    const fullContent = `# ${opts.title}\n\n**Agent**: ${opts.agentId}  \n**Generated**: ${new Date().toISOString()}\n\n---\n\n${opts.content}\n`;

    fs.writeFileSync(filePath, fullContent, 'utf-8');
    log.info(`Wrote artifact: ${filename} (${fullContent.length} chars)`);

    return {
        agentId: opts.agentId,
        filePath: path.relative(opts.workspacePath, filePath),
        title: opts.title,
    };
}
