import type Database from 'better-sqlite3';
import type { InstalledPluginRecord } from '@open-design/contracts';
import { getInstalledPlugin } from './registry.js';

/**
 * Resolve the exact record already selected from the local plugin catalogue.
 */
export async function resolveLocalPluginBySource(input: {
  db: Database.Database;
  id: string;
  source: string;
  userPluginsRoot: string;
}): Promise<InstalledPluginRecord | null> {
  const { db, id, source } = input;
  const installed = getInstalledPlugin(db, id);
  return installed?.source === source ? installed : null;
}
