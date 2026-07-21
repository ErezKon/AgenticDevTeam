/**
 * Requirements document parser.
 *
 * Extracts text from .md, .txt, .pdf, and .docx files so the
 * Architect agent can analyze the requirements.
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { LogColors, color256 } from '../../utils/log-colors.util';

const TAG = `${color256(147)}[requirements]${LogColors.RESET}`;

/**
 * Parse a requirements document into plain text.
 */
async function parseDocument(filePath: string): Promise<string> {
    const ext = path.extname(filePath).toLowerCase();
    const buffer = fs.readFileSync(filePath);

    switch (ext) {
        case '.md':
        case '.txt':
            return buffer.toString('utf-8');

        case '.pdf': {
            const pdfParse = (await import('pdf-parse')).default;
            const pdf = await pdfParse(buffer);
            return pdf.text;
        }

        case '.docx': {
            const mammoth = await import('mammoth');
            const result = await mammoth.extractRawText({ buffer });
            return result.value;
        }

        default:
            // Try reading as UTF-8 text
            return buffer.toString('utf-8');
    }
}

export const parseRequirementsTool = tool(
    async ({ filePath }) => {
        console.log(`${TAG} Parsing requirements from: ${filePath}`);
        if (!fs.existsSync(filePath)) {
            return `Error: File not found: ${filePath}`;
        }
        try {
            const text = await parseDocument(filePath);
            console.log(`${TAG} Extracted ${text.length} characters from ${path.basename(filePath)}`);
            return text;
        } catch (err: any) {
            const msg = `Error parsing ${filePath}: ${err.message}`;
            console.error(`${TAG} ${msg}`);
            return msg;
        }
    },
    {
        name: 'parse_requirements',
        description: 'Parse a requirements document file (.md, .txt, .pdf, .docx) and extract its text content.',
        schema: z.object({
            filePath: z.string().describe('Absolute path to the requirements document file'),
        }),
    }
);

/**
 * Standalone function (non-tool) for parsing requirements at the intake phase.
 */
export async function parseRequirementsFile(filePath: string): Promise<string> {
    return parseDocument(filePath);
}
