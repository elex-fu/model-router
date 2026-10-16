import { createSaasDatabase } from '../src/saas/db/index.js';

async function main(): Promise<void> {
  const url = process.env.MODEL_ROUTER_SAAS_DB_URL;
  if (!url) throw new Error('MODEL_ROUTER_SAAS_DB_URL is required');
  const database = createSaasDatabase({ connectionString: url, max: 2 });
  try {
    await database.migrate();
    await database.verifySchema();
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
