/**
 * Shared Zod schemas for all domain entities used across agents.
 * These define the shapes flowing through the Project State and
 * serve as responseFormat schemas for structured LLM outputs.
 */
import { z } from 'zod';

// ─── Run Input ──────────────────────────────────────────────────────────────

export const RunInputSchema = z.object({
    systemName: z.string().describe('Name of the system being built'),
    requirementsText: z.string().describe('Full text of the requirements document'),
    requirementsDocPath: z.string().optional().describe('Path to the original requirements file'),
    mode: z.enum(['autonomous', 'human']).describe('Run mode'),
});
export type RunInput = z.infer<typeof RunInputSchema>;

// ─── Phase ──────────────────────────────────────────────────────────────────

export const PhaseNameSchema = z.enum([
    'intake',
    'architect',
    'product-manager',
    'dba',
    'team-leader',
    'development',
    'qa',
    'bugfix-triage',
    'devops',
    'finalize',
]);
export type PhaseName = z.infer<typeof PhaseNameSchema>;

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

// ─── Tech Stack ─────────────────────────────────────────────────────────────

export const TechDecisionSchema = z.object({
    layer: z.string().describe('Architecture layer (e.g. "frontend", "backend", "database", "infra", "auth", "messaging")'),
    choice: z.string().describe('Chosen technology (e.g. "React", "Go", "PostgreSQL")'),
    alternatives: z.array(z.string()).describe('Alternatives considered'),
    rationale: z.string().describe('Why this technology was chosen over the alternatives'),
});
export type TechDecision = z.infer<typeof TechDecisionSchema>;

// ─── Epics ──────────────────────────────────────────────────────────────────

export const EpicSchema = z.object({
    id: z.string().describe('Unique epic ID (e.g. "EPIC-001")'),
    title: z.string().describe('Short epic title'),
    description: z.string().describe('What this epic delivers'),
    components: z.array(z.string()).describe('Architecture components involved'),
});
export type Epic = z.infer<typeof EpicSchema>;

// ─── User Stories ───────────────────────────────────────────────────────────

export const UserStorySchema = z.object({
    id: z.string().describe('Unique story ID (e.g. "US-001")'),
    epicId: z.string().describe('Parent epic ID'),
    asA: z.string().describe('"As a..." role'),
    iWant: z.string().describe('"I want..." action'),
    soThat: z.string().describe('"So that..." value'),
    acceptanceCriteria: z.array(z.string()).describe('Testable acceptance criteria'),
});
export type UserStory = z.infer<typeof UserStorySchema>;

// ─── Tasks ──────────────────────────────────────────────────────────────────

export const TaskSchema = z.object({
    id: z.string().describe('Unique task ID (e.g. "TASK-001")'),
    storyId: z.string().optional().describe('Parent story ID if applicable'),
    title: z.string().describe('Short task title'),
    description: z.string().describe('Detailed description of what to build'),
    layer: z.string().describe('Architecture layer (frontend, backend, db, infra, testing)'),
    suggestedTech: z.string().describe('Technology to use for this task'),
});
export type Task = z.infer<typeof TaskSchema>;

// ─── Assignments (Team Leader → Developers) ─────────────────────────────────

export const AssignmentSchema = z.object({
    id: z.string().describe('Unique assignment ID (e.g. "ASSIGN-001")'),
    storyId: z.string().describe('Story or task ID being assigned'),
    devAgentId: z.string().describe('Developer agent ID (e.g. "junior-react", "senior-backend")'),
    rank: z.enum(['principal', 'senior', 'junior']).describe('Developer rank'),
    priority: z.enum(['critical', 'high', 'medium', 'low']).describe('Priority'),
    complexity: z.enum(['trivial', 'simple', 'moderate', 'complex', 'very-complex']).describe('Estimated complexity'),
    estimate: z.string().describe('Rough effort estimate'),
    description: z.string().describe('What the developer should do'),
    dependsOn: z.array(z.string()).describe('Assignment IDs this depends on'),
});
export type Assignment = z.infer<typeof AssignmentSchema>;

// ─── File Changes (Developer output) ────────────────────────────────────────

export const FileChangeSchema = z.object({
    path: z.string().describe('File path relative to workspace root'),
    action: z.enum(['created', 'modified', 'deleted']).describe('What was done'),
    summary: z.string().describe('Brief description of the change'),
    storyId: z.string().describe('Assignment/story ID this change belongs to'),
    agentId: z.string().describe('Developer agent that made the change'),
});
export type FileChange = z.infer<typeof FileChangeSchema>;

// ─── DB Design ──────────────────────────────────────────────────────────────

export const DbEntitySchema = z.object({
    name: z.string().describe('Table/collection name'),
    columns: z.array(z.object({
        name: z.string().describe('Column/field name'),
        type: z.string().describe('Data type'),
        constraints: z.string().optional().describe('e.g. "PRIMARY KEY", "NOT NULL", "UNIQUE"'),
    })).describe('Columns/fields in this entity'),
});

export const DbRelationshipSchema = z.object({
    from: z.string().describe('Source table/collection'),
    to: z.string().describe('Target table/collection'),
    type: z.enum(['one-to-one', 'one-to-many', 'many-to-many']).describe('Relationship type'),
    description: z.string().describe('What this relationship represents'),
});

export const DbDesignSchema = z.object({
    engine: z.string().describe('Database engine (e.g. "PostgreSQL", "MongoDB", "MySQL")'),
    rationale: z.string().describe('Why this DB engine was chosen'),
    entities: z.array(DbEntitySchema).describe('All tables/collections'),
    relationships: z.array(DbRelationshipSchema).describe('Entity relationships'),
    indexes: z.array(z.object({
        table: z.string().describe('Table name'),
        columns: z.array(z.string()).describe('Indexed columns'),
        type: z.string().describe('Index type (e.g. "B-tree", "unique", "compound")'),
        rationale: z.string().describe('Why this index is needed'),
    })).describe('Indexes for performance'),
    sampleQueries: z.array(z.object({
        description: z.string().describe('What this query does'),
        sql: z.string().describe('The query (SQL or equivalent)'),
    })).describe('Complex sample queries'),
    migrations: z.array(z.object({
        filename: z.string().describe('Migration file name'),
        content: z.string().describe('Migration SQL/code content'),
    })).describe('Migration files'),
    erdMermaid: z.string().describe('Mermaid ERD diagram source'),
});
export type DbDesign = z.infer<typeof DbDesignSchema>;

// ─── Test Plan ──────────────────────────────────────────────────────────────

export const TestPlanSchema = z.object({
    scope: z.string().describe('Overall testing scope and strategy'),
    unit: z.array(z.object({
        target: z.string().describe('What to test (component/function/module)'),
        description: z.string().describe('Test description'),
        framework: z.string().describe('Testing framework (e.g. "jest", "xunit", "pytest")'),
    })).describe('Unit test plan items'),
    integration: z.array(z.object({
        target: z.string().describe('Integration point to test'),
        description: z.string().describe('Test description'),
        framework: z.string().describe('Testing framework'),
    })).describe('Integration test plan items'),
    e2e: z.array(z.object({
        scenario: z.string().describe('User scenario to test'),
        description: z.string().describe('Step-by-step test description'),
        criticalPath: z.boolean().describe('Whether this is a critical user path'),
    })).describe('End-to-end test scenarios (Playwright)'),
    coverageTargets: z.object({
        unit: z.number().describe('Target unit test coverage percentage'),
        integration: z.number().describe('Target integration test coverage'),
        e2e: z.number().describe('Target e2e scenario coverage'),
    }).describe('Coverage targets'),
});
export type TestPlan = z.infer<typeof TestPlanSchema>;

// ─── Test Report ────────────────────────────────────────────────────────────

export const TestReportSchema = z.object({
    type: z.enum(['unit', 'integration', 'e2e']).describe('Test type'),
    framework: z.string().describe('Testing framework used'),
    total: z.number().describe('Total tests run'),
    passed: z.number().describe('Tests passed'),
    failed: z.number().describe('Tests failed'),
    skipped: z.number().describe('Tests skipped'),
    status: z.enum(['pass', 'fail']).describe('Overall status'),
    failures: z.array(z.object({
        testName: z.string().describe('Failing test name'),
        error: z.string().describe('Error message'),
        stackTrace: z.string().optional().describe('Stack trace if available'),
        screenshotPath: z.string().optional().describe('Screenshot path (e2e)'),
    })).describe('Details of failing tests'),
    agentId: z.string().describe('QA agent that produced this report'),
});
export type TestReport = z.infer<typeof TestReportSchema>;

// ─── Bugs ───────────────────────────────────────────────────────────────────

export const BugSchema = z.object({
    id: z.string().describe('Unique bug ID (e.g. "BUG-001")'),
    title: z.string().describe('Short bug title'),
    severity: z.enum(['critical', 'major', 'minor', 'trivial']).describe('Bug severity'),
    stepsToReproduce: z.string().describe('How to reproduce the bug'),
    expectedBehavior: z.string().describe('What should happen'),
    actualBehavior: z.string().describe('What actually happens'),
    failingTestId: z.string().optional().describe('ID of the failing test that found this'),
    suspectedArea: z.string().describe('Code area likely responsible'),
    suggestedAssignee: z.string().optional().describe('Suggested developer agent to fix'),
    reportedBy: z.string().describe('QA agent ID that reported it'),
});
export type Bug = z.infer<typeof BugSchema>;

// ─── DevOps Plan ────────────────────────────────────────────────────────────

export const DevOpsPlanSchema = z.object({
    images: z.array(z.object({
        name: z.string().describe('Docker image name'),
        dockerfilePath: z.string().describe('Path to the Dockerfile'),
        description: z.string().describe('What this image runs'),
    })).describe('Docker images to build'),
    composePath: z.string().describe('Path to docker-compose.yml in the generated project'),
    k8sManifests: z.array(z.object({
        filename: z.string().describe('K8s manifest filename'),
        content: z.string().describe('YAML content'),
    })).describe('Kubernetes manifests'),
    buildStatus: z.enum(['pending', 'building', 'success', 'failed']).describe('Docker build status'),
    runStatus: z.enum(['pending', 'starting', 'running', 'healthy', 'unhealthy', 'stopped', 'failed']).describe('Run status'),
    healthChecks: z.array(z.object({
        service: z.string().describe('Service name'),
        url: z.string().describe('Health check URL'),
        status: z.enum(['pending', 'healthy', 'unhealthy']).describe('Health status'),
    })).describe('Service health checks'),
    serviceUrls: z.array(z.object({
        service: z.string().describe('Service name'),
        url: z.string().describe('Accessible URL'),
    })).describe('Running service URLs'),
});
export type DevOpsPlan = z.infer<typeof DevOpsPlanSchema>;

// ─── Approval (HITL) ───────────────────────────────────────────────────────

export const ApprovalSchema = z.object({
    phase: PhaseNameSchema,
    decision: z.enum(['approve', 'deny', 'enhance']).describe('User decision'),
    feedback: z.string().optional().describe('User feedback (for deny/enhance)'),
    timestamp: z.string().describe('ISO timestamp of the decision'),
});
export type Approval = z.infer<typeof ApprovalSchema>;

// ─── Artifact Reference ─────────────────────────────────────────────────────

export const ArtifactRefSchema = z.object({
    agentId: z.string().describe('Agent that produced this artifact'),
    filePath: z.string().describe('Path to the markdown file'),
    title: z.string().describe('Artifact title'),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

// ─── Transcript Message ─────────────────────────────────────────────────────

export const TranscriptMessageSchema = z.object({
    timestamp: z.string().describe('ISO timestamp'),
    agentId: z.string().describe('Agent that produced this message'),
    phase: PhaseNameSchema,
    message: z.string().describe('Human-readable event description'),
});
export type TranscriptMessage = z.infer<typeof TranscriptMessageSchema>;
