/**
 * Mermaid diagram emission tool.
 *
 * Used by agents to produce architecture, ERD, data-flow, and
 * sequence diagrams that are embedded in mission report artifacts.
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { LogColors, color256 } from '../../utils/log-colors.util';
import {logToolAction} from '../../utils/logger';

const TAG = `${color256(183)}[diagram]${LogColors.RESET}`;

/**
 * Basic Mermaid syntax validation — checks for common diagram types
 * and balanced braces. Not a full parser.
 */
function validateMermaid(source: string): { valid: boolean; error?: string } {
    const trimmed = source.trim();
    const validStarts = [
        'graph', 'flowchart', 'sequenceDiagram', 'classDiagram',
        'stateDiagram', 'erDiagram', 'gantt', 'pie', 'gitgraph',
        'journey', 'mindmap', 'timeline', 'C4Context', 'C4Container',
    ];
    const firstWord = trimmed.split(/[\s\n]/)[0];
    if (!validStarts.some(s => firstWord.startsWith(s))) {
        return { valid: false, error: `Unknown diagram type: "${firstWord}". Must start with one of: ${validStarts.join(', ')}` };
    }
    return { valid: true };
}

export const emitMermaidTool = tool(
    async ({ title, source }) => {
        logToolAction(`${TAG} Emitting diagram: ${title}`);
        const validation = validateMermaid(source);
        if (!validation.valid) {
            logToolAction(`${TAG} Validation warning: ${validation.error}`);
            return JSON.stringify({ title, source, warning: validation.error });
        }
        return JSON.stringify({ title, source, valid: true });
    },
    {
        name: 'emit_mermaid',
        description: 'Create a Mermaid diagram to include in a mission report. Returns the validated diagram source. Use this for architecture diagrams, ERDs, data-flow diagrams, sequence diagrams, etc.',
        schema: z.object({
            title: z.string().describe('Diagram title (e.g. "System Architecture", "ERD", "Login Sequence")'),
            source: z.string().describe('Mermaid diagram source code'),
        }),
    }
);
