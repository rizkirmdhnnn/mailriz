import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  slugifyDomain,
  configPathFor,
  listConfigs,
  deriveResourceNames,
  type MultiConfig,
} from '../src/config';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mailriz-config-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('multi-instance config utilities', () => {
  it('slugifies domain names safely for resource identifiers', () => {
    expect(slugifyDomain('example.com')).toBe('example-com');
    expect(slugifyDomain('inbox.sub.domain.co.uk')).toBe('inbox-sub-domain-co-uk');
    expect(slugifyDomain('Zaduna.ID')).toBe('zaduna-id');
  });

  it('derives unique resource names per domain or custom instance prefix', () => {
    const res1 = deriveResourceNames('zaduna.id');
    expect(res1.workerName).toBe('mailriz-zaduna-id');
    expect(res1.d1Name).toBe('mailriz-zaduna-id');
    expect(res1.r2Raw).toBe('mailriz-zaduna-id-raw');
    expect(res1.r2Att).toBe('mailriz-zaduna-id-attachments');
    expect(res1.r2Html).toBe('mailriz-zaduna-id-html');

    // Default legacy / custom prefix
    const resLegacy = deriveResourceNames('zaduna.id', 'mailriz');
    expect(resLegacy.workerName).toBe('mailriz');
    expect(resLegacy.d1Name).toBe('mailriz');
    expect(resLegacy.r2Raw).toBe('mailriz-raw');
    expect(resLegacy.r2Att).toBe('mailriz-attachments');
    expect(resLegacy.r2Html).toBe('mailriz-html');
  });

  it('finds all configuration files in the config directory', async () => {
    // Write legacy config.json
    await writeFile(join(dir, 'config.json'), JSON.stringify({ zone_name: 'legacy.com', worker_name: 'mailriz' }));
    // Write domain-scoped config
    await writeFile(join(dir, 'config-zaduna-id.json'), JSON.stringify({ zone_name: 'zaduna.id', worker_name: 'mailriz-zaduna-id' }));

    const configs = await listConfigs(dir);
    expect(configs).toHaveLength(2);
    expect(configs.map((c) => c.zone_name).sort()).toEqual(['legacy.com', 'zaduna.id']);
  });
});
