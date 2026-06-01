import { App } from "@octokit/app";
import { verify } from "@octokit/webhooks-methods";
import { z } from "zod";

export const githubAppEnvSchema = z.object({
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_PRIVATE_KEY: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1)
});

export type GithubAppEnv = z.infer<typeof githubAppEnvSchema>;

export function createGithubApp(env: GithubAppEnv): App {
  return new App({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY
  });
}

export async function verifyGithubWebhook(input: {
  secret: string;
  payload: string;
  signature: string | null;
}): Promise<boolean> {
  if (!input.signature) {
    return false;
  }

  return verify(input.secret, input.payload, input.signature);
}

export function getGithubAppEnv(
  env: Record<string, string | undefined>
): GithubAppEnv | undefined {
  const result = githubAppEnvSchema.safeParse(env);
  return result.success ? result.data : undefined;
}

export interface NormalizedWebhookEvent {
  deliveryId: string;
  eventName: string;
  action?: string;
  installationId?: number;
  receivedAt: string;
  rawPayload: unknown;
}

export function normalizeWebhookEvent(input: {
  deliveryId: string;
  eventName: string;
  payload: unknown;
  receivedAt?: string;
}): NormalizedWebhookEvent {
  const payload = input.payload as {
    action?: string;
    installation?: { id?: number };
  };

  return {
    deliveryId: input.deliveryId,
    eventName: input.eventName,
    action: payload.action,
    installationId: payload.installation?.id,
    receivedAt: input.receivedAt ?? new Date().toISOString(),
    rawPayload: input.payload
  };
}
