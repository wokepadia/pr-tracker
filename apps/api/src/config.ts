import { z } from "zod";

const apiConfigSchema = z.object({
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().url().default("http://127.0.0.1:5173")
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;

export function getApiConfig(
  env: Record<string, string | undefined> = process.env
): ApiConfig {
  return apiConfigSchema.parse(env);
}
