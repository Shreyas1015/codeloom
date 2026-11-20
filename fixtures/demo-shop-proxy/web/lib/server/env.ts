import { z } from "zod";

const schema = z.object({ BILLING_API_URL: z.string().url() });

export type ServerEnv = z.infer<typeof schema>;

export function readServerEnv(): ServerEnv {
  return schema.parse({ BILLING_API_URL: process.env.BILLING_API_URL });
}
