import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export interface MultiConfig {
  account_id: string;
  zone_id: string;
  zone_name: string;
  worker_name: string;
  dashboard_hostname: string;
  admin_email: string;
  d1_database_id: string;
  r2_raw_bucket: string;
  r2_attachments_bucket: string;
  r2_html_bucket: string;
  auth_mode: 'access' | 'session';
  access_aud?: string;
  access_team_domain?: string;
  access_app_id?: string;
  email_routing_enabled_by_setup?: boolean;
  api_token?: string;
  installed_at: string;
  _filePath?: string;
}

export function slugifyDomain(domain: string): string {
  return domain
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function configPathFor(configDir: string, zoneName?: string): string {
  if (!zoneName) return join(configDir, 'config.json');
  const slug = slugifyDomain(zoneName);
  return join(configDir, `config-${slug}.json`);
}

export function deriveResourceNames(zoneName: string, customPrefix?: string) {
  if (customPrefix) {
    return {
      workerName: customPrefix,
      d1Name: customPrefix,
      r2Raw: `${customPrefix}-raw`,
      r2Att: `${customPrefix}-attachments`,
      r2Html: `${customPrefix}-html`,
    };
  }
  const slug = slugifyDomain(zoneName);
  const prefix = `mailriz-${slug}`;
  return {
    workerName: prefix,
    d1Name: prefix,
    r2Raw: `${prefix}-raw`,
    r2Att: `${prefix}-attachments`,
    r2Html: `${prefix}-html`,
  };
}

export async function listConfigs(configDir: string): Promise<MultiConfig[]> {
  if (!existsSync(configDir)) return [];
  try {
    const files = await readdir(configDir);
    const configs: MultiConfig[] = [];
    for (const f of files) {
      if (f === 'config.json' || (f.startsWith('config-') && f.endsWith('.json'))) {
        try {
          const filePath = join(configDir, f);
          const raw = await readFile(filePath, 'utf8');
          const parsed = JSON.parse(raw) as MultiConfig;
          parsed._filePath = filePath;
          configs.push(parsed);
        } catch {}
      }
    }
    return configs;
  } catch {
    return [];
  }
}
