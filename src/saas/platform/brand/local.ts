import { readFileSync } from 'node:fs';
import { EMPTY_BRAND_SNAPSHOT, type PublicBrandSnapshot, parsePublicBrandSnapshot } from './snapshot.js';

/**
 * Batch 5 §5.2 OEM white-label: the BYOK local brand override.
 *
 * The BYOK admin deployment has no platform settings store, so its brand
 * snapshot comes from an optional `brand.json` file next to config.json
 * (the config.json-adjacent local-file convention for deployment-owned
 * values). The file is parsed with the exact same strict snapshot grammar as
 * the SaaS materialized row; a missing file is the empty snapshot (the
 * no-brand deployment is byte-identical), and an invalid file fails closed
 * to the empty snapshot with one console error per read — never a crash of
 * the admin static surface.
 *
 * Shape (all fields optional; the public snapshot grammar applies):
 *
 *   {
 *     "siteName": "Acme Router",
 *     "siteSubtitle": "Acme's AI gateway",
 *     "siteLogo": "https://cdn.acme.test/logo.png",
 *     "apiBaseUrl": "https://api.acme.test",
 *     "contactUrl": "mailto:ops@acme.test",
 *     "docUrl": "https://docs.acme.test",
 *     "customMenuItems": [{ "label": "Docs", "url": "https://docs.acme.test" }],
 *     "customEndpoints": [{ "name": "EU endpoint", "url": "https://eu.api.acme.test" }],
 *     "customPages": [{ "slug": "terms", "title": "Terms", "mode": "markdown", "content": "# Terms" }],
 *     "frameAncestors": ["https://acme.test"]
 *   }
 */
export function readLocalBrandSnapshot(path: string): PublicBrandSnapshot {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return EMPTY_BRAND_SNAPSHOT;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`model-router brand override ${path} is not valid JSON; serving the default brand`);
    return EMPTY_BRAND_SNAPSHOT;
  }
  try {
    return parsePublicBrandSnapshot(parsed);
  } catch (error) {
    console.error(`model-router brand override ${path} failed validation; serving the default brand`, error);
    return EMPTY_BRAND_SNAPSHOT;
  }
}
