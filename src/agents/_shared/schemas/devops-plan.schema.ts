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
