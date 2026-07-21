import { z } from 'zod';

// ─── Architecture ───────────────────────────────────────────────────────────

export const ArchitectureComponentSchema = z.object({
    name: z.string().describe('Component name (e.g. "API Gateway", "Auth Service")'),
    type: z.string().describe('Component type (e.g. "service", "database", "ui", "queue")'),
    description: z.string().describe('What this component does'),
    technology: z.string().describe('Primary technology (e.g. "Express.js", "PostgreSQL")'),
    communicatesWith: z.array(z.string()).describe('Names of components this talks to'),
});

export const ArchitectureDocSchema = z.object({
    style: z.string().describe('Architecture style (e.g. "client-server", "microservices", "monolith", "event-driven")'),
    components: z.array(ArchitectureComponentSchema).describe('All system components'),
    dataFlow: z.string().describe('Description of how data flows through the system'),
    integrations: z.array(z.string()).describe('External integrations (e.g. "Stripe API", "SendGrid")'),
    nonFunctional: z.array(z.string()).describe('Non-functional requirements addressed (e.g. "scalability", "auth")'),
    mermaidDiagram: z.string().describe('Mermaid component/data-flow diagram source'),
});
export type ArchitectureDoc = z.infer<typeof ArchitectureDocSchema>;
