import { z } from 'zod';

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
