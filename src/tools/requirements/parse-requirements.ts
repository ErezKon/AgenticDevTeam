/**
 * Requirements document parser.
 *
 * Extracts text from .md, .txt, .pdf, and .docx files so the
 * Architect agent can analyze the requirements.
 */
import * as fs from 'fs';
import * as path from 'path';

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

/**
 * Standalone function (non-tool) for parsing requirements at the intake phase.
 */
export async function parseRequirementsFile(filePath: string): Promise<string> {
    return parseDocument(filePath);
}
