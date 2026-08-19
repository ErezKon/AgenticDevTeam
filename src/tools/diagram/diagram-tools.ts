/**
 * Mermaid diagram utilities.
 *
 * Provides label sanitisation for Mermaid diagrams embedded in
 * mission report artifacts.
 */

/**
 * Sanitize Mermaid node labels that contain special characters.
 *
 * Mermaid requires labels with parentheses, commas, and other special
 * characters inside bracket shapes (e.g. `[]`, `()`, `{}`) to be
 * wrapped in double-quotes.
 *
 *   BEFORE: UI[UI Component (React)]
 *   AFTER:  UI["UI Component (React)"]
 */
export function sanitizeMermaidLabels(source: string): string {
    // Match node definitions: ID followed by a bracket pair containing a label
    // Covers [] () {} [()] [{}] etc.
    return source.replace(
        /(\w+)\[([^\]"]*[(){},:;][^\]"]*)\]/g,
        (_match, id, label) => `${id}["${label}"]`,
    );
}
