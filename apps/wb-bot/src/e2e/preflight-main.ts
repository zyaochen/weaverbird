import { formatReadonlyPreflightReport, runReadonlyPreflight } from './preflight-env.js';

async function main(): Promise<void> {
  const report = await runReadonlyPreflight(process.env);
  console.log(formatReadonlyPreflightReport(report));
  const hasError = report.checks.some((check) => check.status === 'error');
  process.exit(hasError ? 1 : 0);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`❌ W13 readonly preflight failed before checks: ${message}`);
  process.exit(1);
});
