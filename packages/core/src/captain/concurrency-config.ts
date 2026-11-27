import { z, type ZodSchema } from 'zod';
import { loadConfig } from '../config/registry.js';

export const ConcurrencyConfigSchema = z.object({
  max_concurrent_runs: z.number().int().positive().default(1),
  queue_max_depth: z.number().int().nonnegative().default(10),
});

export type ConcurrencyConfig = z.infer<typeof ConcurrencyConfigSchema>;

export function loadConcurrencyConfig(dataDir: string): ConcurrencyConfig {
  const defaults: ConcurrencyConfig = ConcurrencyConfigSchema.parse({}) as ConcurrencyConfig;
  return loadConfig(dataDir, 'captain', ConcurrencyConfigSchema as unknown as ZodSchema<ConcurrencyConfig>, defaults);
}
