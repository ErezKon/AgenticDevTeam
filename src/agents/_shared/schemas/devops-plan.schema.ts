import { z } from 'zod';

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
    buildStatus: z.enum(['pending', 'building', 'success', 'failed', 'skipped', 'unverified']).describe('Docker build status'),
    runStatus: z.enum(['pending', 'starting', 'running', 'healthy', 'unhealthy', 'stopped', 'failed', 'skipped']).describe('Run status'),
    healthChecks: z.array(z.object({
        service: z.string().describe('Service name'),
        url: z.string().describe('Health check URL'),
        status: z.enum(['pending', 'healthy', 'unhealthy']).describe('Health status'),
    })).describe('Service health checks'),
    serviceUrls: z.array(z.object({
        service: z.string().describe('Service name'),
        url: z.string().describe('Accessible URL'),
    })).describe('Running service URLs'),
    /** How the deployment was verified: compose, dockerfile, none (no Docker artifacts), or docker-unavailable. */
    verificationMode: z.enum(['compose', 'dockerfile', 'none', 'docker-unavailable']).optional().describe('How the deployment was verified'),
});
export type DevOpsPlan = z.infer<typeof DevOpsPlanSchema>;
