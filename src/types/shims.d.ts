declare module 'pdf-parse' {
    interface PDFData {
        numpages: number;
        numrender: number;
        info: any;
        metadata: any;
        text: string;
        version: string;
    }
    function pdfParse(dataBuffer: Buffer, options?: any): Promise<PDFData>;
    export = pdfParse;
}

declare module 'mammoth' {
    interface ConvertResult {
        value: string;
        messages: any[];
    }
    function extractRawText(options: { path?: string; buffer?: Buffer }): Promise<ConvertResult>;
    function convertToHtml(options: { path?: string; buffer?: Buffer }): Promise<ConvertResult>;
    export { extractRawText, convertToHtml };
}
