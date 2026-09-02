#!/usr/bin/env node
/**
 * mailriz-cli — interactive deployment wizard for MailRiz.
 *
 * Commands:
 *   setup    Deploy end-to-end (Worker + D1 + R2 + DNS + Email Routing + Access)
 *   status   Check deployed service health
 *   update   Update the Worker to the latest release (keeps data)
 *   destroy  Tear down everything (with double confirmation)
 */

import { text, password, select, confirm, isCancel } from '@clack/prompts';
import pc from 'picocolors';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import {
  banner, commandHeader, checkRow, heading, hint, bullet, link, rows,
  blank, spin, TaskList, finished, aborted, accent,
} from './ui';
import {
  verifyToken, listAccounts, listZones,
  listD1, createD1, d1Query, deleteD1,
  listR2Buckets, createR2Bucket, deleteR2Bucket,
  listWorkerScripts, deleteWorkerScript,
  listWorkerDomains, deleteWorkerDomain,
  enableEmailRouting, setCatchAllToWorker, getEmailRoutingSettings,
  getCatchAllRule, catchAllTargets, clearCatchAll, disableEmailRouting,
  getAccessOrganization, createAccessApp, createAccessPolicy,
  listAccessApps, deleteAccessApp, findAccessApp,
} from './cf';
import {
  createR2Client, deriveS3Credentials, emptyBucket, type R2Client,
} from './r2';
import {
  takeInventory, bucketsOf, describeBucket, leftovers, routingChoice,
  destroySummary, UNREADABLE, type Inventory,
} from './teardown';
import { applyMigrations } from './migrate';
import { resolveToken, sourceHint, validateToken, type TokenSources } from './token';
import { spawnAndWait } from './proc';
import { hashPassword, generateSigningKey } from '@mailriz/shared';
import {
  slugifyDomain,
  configPathFor,
  deriveResourceNames,
  listConfigs,
  type MultiConfig,
} from './config';

const execFileP = promisify(execFile);
const CONFIG_DIR = join(homedir(), '.mailriz');
const DEFAULT_CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const TMP_DIR = join(CONFIG_DIR, '.temp');
const RELEASE_URL = 'https://github.com/rizkirmdhnnn/mailriz/releases/latest/download/mailriz-worker.tar.gz';

type Config = MultiConfig;
/**
 * Resolve the token for a command that runs against an existing install.
 *
 * Order: what was typed, then the saved token, then the environment. An
 * empty answer is valid whenever one of the fallbacks exists — the prompt
 * used to advertise "same one you used for setup" while rejecting a blank
 * line, because nothing was ever saved to reuse.
 */
async function promptToken(cfg: Config, purpose: string): Promise<string> {
  const sources: TokenSources = {
    stored: cfg.api_token,
    env: process.env.CLOUDFLARE_API_TOKEN,
  };

  // Masked: this token can delete the Worker, the database and every stored
  // message, and terminals get recorded and shared. password() has no
  // placeholder, so the source hint becomes its own line.
  hint(sourceHint(sources));
  const answer = (await password({
    message: `Cloudflare API Token — ${purpose}`,
    validate: (v) => validateToken(v || '', sources),
  })) as string;
  if (isCancel(answer)) process.exit(0);

  return resolveToken(answer || '', sources);
}

function fail(msg: string): never {
  aborted(msg);
  process.exit(1);
}

async function selectOrCreateConfig(zoneName?: string): Promise<string> {
  return configPathFor(CONFIG_DIR, zoneName);
}

async function loadConfig(specifiedDomain?: string): Promise<Config | null> {
  const configs = await listConfigs(CONFIG_DIR);
  if (configs.length === 0) {
    try {
      const raw = await readFile(DEFAULT_CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw) as Config;
      parsed._filePath = DEFAULT_CONFIG_PATH;
      return parsed;
    } catch {
      return null;
    }
  }

  if (specifiedDomain) {
    const match = configs.find(
      (c) =>
        c.zone_name.toLowerCase() === specifiedDomain.toLowerCase() ||
        c.dashboard_hostname.toLowerCase() === specifiedDomain.toLowerCase() ||
        c.worker_name.toLowerCase() === specifiedDomain.toLowerCase()
    );
    return match || null;
  }

  if (configs.length === 1) {
    return configs[0]!;
  }

  // Multiple configs exist: interactive select
  blank();
  const chosen = (await select({
    message: 'Multiple MailRiz installations found. Select which one:',
    options: configs.map((c) => ({
      value: c._filePath || configPathFor(CONFIG_DIR, c.zone_name),
      label: `${c.zone_name} (${c.dashboard_hostname}) [Worker: ${c.worker_name}]`,
    })),
  })) as string;
  if (isCancel(chosen)) process.exit(0);

  const matched = configs.find((c) => (c._filePath || configPathFor(CONFIG_DIR, c.zone_name)) === chosen);
  return matched || null;
}

async function saveConfig(cfg: Config): Promise<string> {
  await mkdir(CONFIG_DIR, { recursive: true });
  const targetPath = cfg._filePath || configPathFor(CONFIG_DIR, cfg.zone_name);
  await writeFile(targetPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  cfg._filePath = targetPath;
  return targetPath;
}

// ---------------------------------------------------------------- release fetch

async function fetchReleaseAsset(): Promise<{ dir: string; index: string; migrationsDir: string; assetsDir: string }> {
  await mkdir(TMP_DIR, { recursive: true });
  const tarPath = join(TMP_DIR, 'mailriz-worker.tar.gz');
  const res = await fetch(RELEASE_URL);
  if (!res.ok) throw new Error(`Failed to fetch release: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  await writeFile(tarPath, buf);
  // Extract
  await execFileP('tar', ['-xzf', tarPath, '-C', TMP_DIR]);
  const workerDir = join(TMP_DIR, 'worker');
  const index = join(workerDir, 'index.js');
  const migrationsDir = join(workerDir, 'migrations');
  const assetsDir = join(workerDir, 'assets');
  return { dir: workerDir, index, migrationsDir, assetsDir };
}

/**
 * Deploy the worker by generating a wrangler.jsonc in the release dir and
 * running `wrangler deploy` as a child process. This handles the full stack:
 * module bundle + static assets + D1 + R2 + env vars + cron triggers.
 */
async function deployWithWrangler(opts: {
  token: string;
  accountId: string;
  workerName: string;
  releaseDir: string;
  d1Id: string;
  r2Raw: string;
  r2Att: string;
  r2Html: string;
  adminEmail: string;
  dashboardHostname: string;
  /** Zone apex — where mail arrives. Not the dashboard hostname. */
  mailDomain: string;
  authMode: 'access' | 'session';
  accessAud?: string;
  accessTeamDomain?: string;
}) {
  const wranglerConfig = {
    name: opts.workerName,
    main: 'index.js',
    compatibility_date: '2026-06-01',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: false,
    // not_found_handling: the dashboard routes client-side, so a reload on
    // /inbox or /alias/:id has to serve index.html instead of 404ing.
    assets: {
      directory: './assets',
      binding: 'ASSETS',
      not_found_handling: 'single-page-application',
      // Without this the SPA fallback answers navigation requests to /api/*
      // with index.html — an iframe loading a message body got the dashboard
      // shell instead. Fetches were unaffected, so it only broke the frame.
      run_worker_first: ['/api/*'],
    },
    triggers: { crons: ['0 4 * * *'] },
    // A Custom Domain, not a route: Cloudflare creates the DNS record and
    // issues the certificate. A plain workers route matches URLs but creates
    // no DNS, so the hostname would never resolve.
    routes: [{ pattern: opts.dashboardHostname, custom_domain: true }],
    vars: {
      ADMIN_EMAIL: opts.adminEmail,
      // The Worker rejects every request when ACCESS_AUD is blank, so Access
      // has to be provisioned before this deploy, not after it.
      ACCESS_TEAM_DOMAIN: opts.accessTeamDomain || '',
      ACCESS_AUD: opts.accessAud || '',
      TRASH_RETENTION_DAYS: '30',
      AUTH_MODE: opts.authMode,
      // SESSION_PASSWORD_HASH and SESSION_SIGNING_KEY are deliberately absent:
      // they go up as secrets via putSessionSecrets(). vars and secrets share
      // the same env namespace, so declaring them here — even as '' — would
      // overwrite the secrets on every deploy.
      DASHBOARD_HOSTNAME: opts.dashboardHostname,
      MAIL_DOMAIN: opts.mailDomain,
    },
    // Slows online password guessing from "as fast as the Worker answers" to
    // a handful a minute. period only accepts 10 or 60.
    ratelimits: [
      { name: 'LOGIN_LIMITER', namespace_id: '1001', simple: { limit: 5, period: 60 } },
    ],
    d1_databases: [
      { binding: 'DB', database_name: 'mailriz', database_id: opts.d1Id, migrations_dir: 'migrations' },
    ],
    r2_buckets: [
      { binding: 'RAW_BUCKET', bucket_name: opts.r2Raw },
      { binding: 'ATTACHMENTS_BUCKET', bucket_name: opts.r2Att },
      { binding: 'HTML_BUCKET', bucket_name: opts.r2Html },
    ],
  };
  await writeFile(join(opts.releaseDir, 'wrangler.jsonc'), JSON.stringify(wranglerConfig, null, 2));
  const env = { ...process.env, CLOUDFLARE_API_TOKEN: opts.token, CLOUDFLARE_ACCOUNT_ID: opts.accountId };
  // Resolve wrangler from our own node_modules (it's a runtime dependency), so
  // the CLI works from any directory — no global install needed.
  await runWrangler(['deploy'], { cwd: opts.releaseDir, env });
}

/**
 * Run wrangler from our own node_modules, so the CLI works from any directory
 * with no global install. See spawnAndWait for why exit rather than close.
 */
function runWrangler(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string }
): Promise<void> {
  const require = createRequire(import.meta.url);
  const wranglerBin = join(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
  return spawnAndWait(process.execPath, [wranglerBin, ...args], opts);
}

/**
 * Push the session secrets to the deployed Worker.
 *
 * Through stdin, not a file: `wrangler secret bulk` accepts either, and a file
 * would leave the password hash and signing key sitting in ~/.mailriz/.temp,
 * which is never cleaned up.
 *
 * Has to run *after* deploy — a Worker must exist before secrets can be
 * attached to it. Between the two the Worker answers 500, by design, which is
 * why the health probe comes last.
 */
async function putSessionSecrets(opts: {
  token: string;
  accountId: string;
  releaseDir: string;
  passwordHash: string;
  signingKey: string;
}) {
  const env = { ...process.env, CLOUDFLARE_API_TOKEN: opts.token, CLOUDFLARE_ACCOUNT_ID: opts.accountId };
  await runWrangler(['secret', 'bulk'], {
    cwd: opts.releaseDir,
    env,
    stdin: JSON.stringify({
      SESSION_PASSWORD_HASH: opts.passwordHash,
      SESSION_SIGNING_KEY: opts.signingKey,
    }),
  });
}

/**
 * The Access application guarding the dashboard, created only if the hostname
 * does not already have one — two applications on the same hostname means two
 * aud tags, only one of which the Worker is told to trust.
 */
async function ensureAccessApp(
  token: string,
  accountId: string,
  hostname: string,
  adminEmail: string
): Promise<{ id: string; aud: string; reused: boolean }> {
  const existing = findAccessApp(await listAccessApps(token, accountId), hostname);
  if (existing?.id && existing.aud) {
    return { id: existing.id, aud: existing.aud, reused: true };
  }
  const app = await createAccessApp(token, accountId, 'mailriz', hostname);
  await createAccessPolicy(token, accountId, app.id, adminEmail);
  return { id: app.id, aud: app.aud, reused: false };
}

// ---------------------------------------------------------------- setup

const SCOPE_ROWS = [
  '1. Account → Workers Scripts     → Edit',
  '2. Account → D1                  → Edit',
  '3. Account → Workers R2 Storage  → Edit',
  '4. Zone    → Workers Routes      → Edit',
  '5. Zone    → Email Routing Rules → Edit',
  '6. Zone    → DNS                 → Edit',
  '7. Zone    → Zone Settings       → Edit',
];

/** Only needed for Cloudflare Access; password auth works without it. */
const ACCESS_SCOPE_ROW = '8. Account → Access: Apps and Policies → Edit  (optional)';

async function cmdSetup() {
  banner();

  // Refuse to run over a live installation: setup provisions and then
  // overwrites config.json wholesale, so a second run against a different
  // zone would strand the first one's Worker, Custom Domain and Access
  // Check if an install already exists for this specific domain or default
  const allConfigs = await listConfigs(CONFIG_DIR);
  const existingDefault = existsSync(DEFAULT_CONFIG_PATH) ? await loadConfig() : null;
  if (existingDefault && allConfigs.length === 0) {
    // Legacy single installation present
  }

  // ---- pre-flight, before anything is asked of the user
  commandHeader('preflight');

  let wranglerOk = false;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('wrangler/package.json');
    const bin = join(dirname(pkg), 'bin', 'wrangler.js');
    wranglerOk = existsSync(bin);
  } catch { wranglerOk = false; }
  checkRow(wranglerOk, 'wrangler', wranglerOk ? 'bundled' : 'not found');

  let cfReachable = false;
  try {
    const r = await fetch('https://api.cloudflare.com/client/v4/');
    cfReachable = r.ok || r.status === 401 || r.status === 403;
  } catch { cfReachable = false; }
  checkRow(cfReachable, 'cloudflare', cfReachable ? 'api reachable' : 'unreachable — check your network');

  // The state file will be placed in the config directory.
  checkRow(true, 'state', `will be created in ${CONFIG_DIR}`);

  try {
    const { stdout } = await execFileP('bun', ['--version']);
    const v = stdout.trim();
    const [majorRaw, minorRaw] = v.split('.').map(Number);
    const major = majorRaw ?? 0;
    const minor = minorRaw ?? 0;
    if (major < 1 || (major === 1 && minor < 1)) {
      checkRow(false, 'bun', `${v} — need >= 1.1`);
      fail('Bun >= 1.1 required. Install: curl -fsSL https://bun.sh/install | bash');
    }
    checkRow(true, 'bun', v);
  } catch {
    checkRow(false, 'bun', 'not installed');
    fail('Bun is required. Install: curl -fsSL https://bun.sh/install | bash');
  }

  // ---- token
  heading('Cloudflare API token');
  hint('MailRiz needs a token carrying these 7 scopes:');
  for (const row of SCOPE_ROWS) bullet(row);
  bullet(ACCESS_SCOPE_ROW);
  blank();
  hint('Token page (permissions and name are pre-filled):');
  // Pre-fill exact Cloudflare token permission groups required for setup,
  // deployment, email routing configuration, and clean teardown.
  const permissions = [
    // Account level
    { key: 'workers_scripts', type: 'edit' },
    { key: 'd1', type: 'edit' },
    { key: 'workers_r2', type: 'edit' },
    { key: 'access', type: 'edit' },
    { key: 'access_acct', type: 'edit' },
    // Zone level
    { key: 'zone', type: 'read' },
    { key: 'workers_routes', type: 'edit' },
    { key: 'email_routing_rules', type: 'edit' },
    { key: 'dns', type: 'edit' },
    { key: 'zone_settings', type: 'edit' },
  ];
  const tokenUrl = `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(
    JSON.stringify(permissions)
  )}&accountId=*&zoneId=all&name=mailriz-cli`;
  link(tokenUrl);
  blank();

  const openBrowser = (await confirm({
    message: 'Open that page in your browser now?',
    initialValue: true,
  })) as boolean;
  if (isCancel(openBrowser)) process.exit(0);
  if (openBrowser) await openUrl(tokenUrl);

  hint('blank = use $CLOUDFLARE_API_TOKEN');
  const token = (await password({
    message: 'Paste the token',
    validate: (v) => {
      if (v && v.length > 20) return undefined;
      return process.env.CLOUDFLARE_API_TOKEN ? undefined : 'Token looks too short';
    },
  })) as string;
  if (isCancel(token)) process.exit(0);
  const effectiveToken = token || process.env.CLOUDFLARE_API_TOKEN || '';

  blank();
  let verified;
  try {
    verified = await spin('token', () => verifyToken(effectiveToken), (v) => `valid · ${v.id}`);
  } catch (e: any) {
    fail(`Token verification failed: ${e.message}`);
  }

  // ---- account + zone
  const accounts = await spin(
    'accounts',
    () => listAccounts(effectiveToken),
    (a) => `${a.length} available`
  );
  if (accounts.length === 0) fail('No accounts on this token');

  let accountId: string;
  let accountObj = accounts[0]!;
  if (accounts.length > 1) {
    blank();
    const chosen = (await select({
      message: 'Which account?',
      options: accounts.map((a) => ({ value: a.id, label: a.name })),
    })) as string;
    if (isCancel(chosen)) process.exit(0);
    accountObj = accounts.find((a) => a.id === chosen)!;
    blank();
  }
  accountId = accountObj.id;

  const zones = await spin(
    'zones',
    () => listZones(effectiveToken, accountId),
    (z) => `${z.length} available`
  );
  if (zones.length === 0) fail('No zones on this account — add a domain first');

  let zoneObj = zones[0]!;
  if (zones.length > 1) {
    blank();
    const chosen = (await select({
      message: 'Which domain?',
      options: zones.map((z) => ({ value: z.id, label: `${z.name} (${z.status})` })),
    })) as string;
    if (isCancel(chosen)) process.exit(0);
    zoneObj = zones.find((z) => z.id === chosen)!;
  }
  const zoneId = zoneObj.id;

  // Check if an existing configuration exists for this zone
  const targetConfigPath = configPathFor(CONFIG_DIR, zoneObj.name);
  if (existsSync(targetConfigPath)) {
    commandHeader('setup', zoneObj.name);
    aborted(`MailRiz is already installed for ${zoneObj.name}.`);
    hint(`Config file exists at: ${targetConfigPath}`);
    hint(`To reconfigure, run: mailriz-cli reconfigure`);
    hint(`To destroy, run: mailriz-cli destroy`);
    blank();
    process.exit(1);
  }

  // Determine resource naming (domain-scoped)
  const resourceNames = deriveResourceNames(zoneObj.name);
  const workerName = resourceNames.workerName;

  blank();
  const takenOver = await spin(
    'existing install',
    async () => {
      const scripts = await listWorkerScripts(effectiveToken, accountId).catch(() => []);
      return scripts.some((s) => s.id === workerName);
    },
    (found) => (found ? `a "${workerName}" Worker already exists here` : 'none found')
  );
  if (takenOver) {
    blank();
    hint(`This account already runs a Worker named "${workerName}", but there is no`);
    hint(`${targetConfigPath} describing it.`);
    blank();
    hint('Continuing redeploys that Worker, repoints it at the hostname you pick');
    hint('next, and reuses the existing mailriz database and buckets for this domain.');
    blank();
    const proceed = (await confirm({
      message: 'Take over the existing deployment?',
      initialValue: false,
    })) as boolean;
    if (isCancel(proceed)) process.exit(0);
    if (!proceed) {
      aborted('Left alone — nothing was changed.');
      process.exit(1);
    }
  }

  // ---- configuration
  heading('Configuration');
  const dashboardHostname = (await text({
    message: 'Dashboard hostname',
    placeholder: `inbox.${zoneObj.name}`,
    initialValue: `inbox.${zoneObj.name}`,
    validate: (v) => (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(v || '') ? undefined : 'Invalid hostname'),
  })) as string;
  const adminEmail = (await text({
    message: 'Admin email (single-user access)',
    placeholder: 'you@example.com',
    validate: (v) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v || '') ? undefined : 'Invalid email'),
  })) as string;

  // Probe Zero Trust before offering Access. A token without that scope
  // answers 403, and finding that out here means the choice is made before
  // anything is deployed — rather than the run "succeeding" with an
  // unreachable dashboard.
  blank();
  let teamDomain = '';
  let accessAvailable = false;
  try {
    const org = await spin(
      'zero trust',
      () => getAccessOrganization(effectiveToken, accountId),
      (o) => o.auth_domain || 'available'
    );
    teamDomain = org.auth_domain || '';
    accessAvailable = true;
  } catch {
    // spin printed the failing row; explain what it means for the choice.
    hint('  Access needs a token with Zero Trust permissions, or a Zero Trust');
    hint('  organization on the account. Password auth works without either.');
  }
  blank();

  const useAccess = accessAvailable
    ? ((await confirm({
        message: 'Use Cloudflare Access for auth? (recommended)',
        initialValue: true,
      })) as boolean)
    : false;
  if (isCancel(useAccess)) process.exit(0);

  let authMode: 'access' | 'session' = 'access';
  let sessionHash: string | undefined;
  let signingKey: string | undefined;
  if (!useAccess) {
    hint('min 12 chars');
    const pw = (await password({
      message: accessAvailable
        ? 'Set a dashboard password'
        : 'Set a dashboard password (Access unavailable)',
      validate: (v) => (v && v.length >= 12 ? undefined : 'min 12 chars'),
    })) as string;
    if (isCancel(pw)) process.exit(0);
    // PBKDF2 with a per-password salt, and a signing key that has nothing to
    // do with the password — reading one must not yield the other.
    sessionHash = await hashPassword(pw);
    signingKey = generateSigningKey();
    authMode = 'session';
  }

  // ---- provisioning: one live task block owns the screen from here on.
  // Nothing interactive may print until tasks.stop(); warnings are queued and
  const d1Name = resourceNames.d1Name;
  const r2RawName = resourceNames.r2Raw;
  const r2AttName = resourceNames.r2Att;
  const r2HtmlName = resourceNames.r2Html;
  blank();
  commandHeader('setup', `${accountObj.name} / ${zoneObj.name}`);

  const tasks = new TaskList([
    { key: 'token', label: 'token' },
    { key: 'account', label: 'account' },
    { key: 'zone', label: 'zone' },
    { key: 'release', label: 'release' },
    { key: 'd1', label: 'd1' },
    { key: 'migrations', label: 'migrations' },
    { key: 'r2', label: 'r2' },
    // Access comes before the deploy: its aud tag is a Worker var, and the
    // Worker refuses every request while that var is empty.
    { key: 'access', label: 'access' },
    { key: 'worker', label: 'worker' },
    { key: 'routing', label: 'email routing' },
    { key: 'health', label: 'health' },
  ]);

  tasks.seed('token', `valid · ${verified.id}`);
  tasks.seed('account', accountObj.name);
  tasks.seed('zone', zoneObj.name);
  if (!useAccess) tasks.seed('access', 'session password', 'skip');
  tasks.start();

  // Annotated on the variable, not just the arrow, so TypeScript treats calls
  // to it as terminating control flow.
  const abort: (msg: string) => never = (msg) => {
    tasks.stop();
    fail(msg);
  };

  // Release artifact.
  tasks.run('release', 'downloading worker bundle…');
  let release: { dir: string; index: string; migrationsDir: string; assetsDir: string };
  try {
    release = await fetchReleaseAsset();
  } catch (e: any) {
    tasks.failTask('release', e.message);
    abort(`Release fetch failed: ${e.message}`);
  }
  tasks.ok('release', 'worker bundle ready');

  const migrations = existsSync(release.migrationsDir)
    ? (await readdirSorted(release.migrationsDir))
    : [];

  // D1.
  tasks.run('d1', 'provisioning database…');
  let d1;
  try {
    const d1s = await listD1(effectiveToken, accountId);
    d1 = d1s.find((d) => d.name === d1Name);
    if (!d1) d1 = await createD1(effectiveToken, accountId, d1Name);
    // A database without a uuid would otherwise flow into the query URL and
    // the wrangler binding as "undefined" and fail much further along.
    if (!d1.uuid) throw new Error('D1 API returned a database without a uuid');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    tasks.failTask('d1', msg);
    abort(`D1 provisioning failed: ${msg}`);
  }
  tasks.ok('d1', `${d1Name} (${d1.uuid.slice(0, 8)})`);
  // Migrations.
  tasks.run('migrations', `checking ${migrations.length}…`);
  let appliedNow: string[] = [];
  try {
    appliedNow = await applyMigrations(
      (sql) => d1Query(effectiveToken, accountId, d1.uuid, sql),
      release.migrationsDir,
      migrations
    );
  } catch (e: any) {
    tasks.failTask('migrations', e.message);
    abort(`Migration failed: ${e.message}`);
  }
  tasks.ok(
    'migrations',
    appliedNow.length > 0
      ? `${appliedNow.length} applied · ${migrations.length} total`
      : `up to date · ${migrations.length} total`
  );

  // Repair aliases left on the dashboard hostname by earlier builds.
  try {
    const fixed = await repairAliasDomains(
      effectiveToken, accountId, d1.uuid, dashboardHostname, zoneObj.name
    );
    if (fixed > 0) tasks.set('migrations', 'ok', `${migrations.length} applied · ${fixed} alias domains repaired`);
  } catch {
    // Best effort — a fresh install has no rows to fix.
  }

  // R2.
  tasks.run('r2', 'creating 3 buckets…');
  let r2Raw, r2Att, r2Html;
  try {
    const r2s = await listR2Buckets(effectiveToken, accountId);
    const ensure = async (name: string) =>
      r2s.find((b) => b.name === name) || await createR2Bucket(effectiveToken, accountId, name);
    r2Raw = await ensure(r2RawName);
    r2Att = await ensure(r2AttName);
    r2Html = await ensure(r2HtmlName);
  } catch (e: any) {
    tasks.failTask('r2', e.message);
    abort(`R2 provisioning failed: ${e.message}`);
  }
  tasks.ok('r2', 'raw · attachments · html');

  // Access, before the deploy — its aud tag ships as a Worker var.
  let accessAud = '';
  let accessAppId = '';
  if (useAccess) {
    tasks.run('access', 'creating application…');
    try {
      const app = await ensureAccessApp(effectiveToken, accountId, dashboardHostname, adminEmail);
      accessAud = app.aud;
      accessAppId = app.id;
      tasks.ok('access', `single-user · ${adminEmail}`);
    } catch (e: any) {
      // Falling through with an empty aud would deploy a Worker that rejects
      // every request, so this is fatal rather than a warning.
      tasks.failTask('access', e.message);
      abort(
        `Cloudflare Access setup failed: ${e.message}\n` +
        `  Without it the Worker has no audience tag and would reject every request.\n` +
        `  Re-run and choose password auth, or use a token with Zero Trust permissions.`
      );
    }
  } else {
    tasks.skip('access', 'password auth');
  }

  // Worker.
  tasks.run('worker', 'deploying…');
  try {
    await deployWithWrangler({
      token: effectiveToken,
      accountId,
      workerName,
      releaseDir: release.dir,
      d1Id: d1.uuid,
      r2Raw: r2Raw.name,
      r2Att: r2Att.name,
      r2Html: r2Html.name,
      adminEmail,
      dashboardHostname,
      mailDomain: zoneObj.name,
      authMode,
      accessAud,
      accessTeamDomain: teamDomain,
    });
    // Secrets can only be attached once the Worker exists, so this follows the
    // deploy. Until it lands the Worker answers 500 in session mode; the health
    // probe below runs after, so it sees the finished state.
    if (authMode === 'session') {
      await putSessionSecrets({
        token: effectiveToken,
        accountId,
        releaseDir: release.dir,
        passwordHash: sessionHash!,
        signingKey: signingKey!,
      });
    }
  } catch (e: any) {
    tasks.failTask('worker', e.message);
    abort(
      `Worker deploy failed: ${e.message}\n` +
      `  If it mentions the custom domain, check that ${dashboardHostname} has no\n` +
      `  existing DNS record — Cloudflare refuses to attach one over a CNAME.`
    );
  }
  // wrangler attaches the Custom Domain as part of the deploy, so reaching
  // here means DNS and the certificate were created too.
  tasks.ok('worker', `${workerName} → ${dashboardHostname}`);

  // Email Routing. Non-fatal, but mail won't arrive until it's on.
  tasks.run('routing', 'enabling catch-all…');
  // Recorded so teardown knows whether the zone's MX records are ours to
  // remove.
  let routingEnabledByUs = false;
  try {
    const settings = await getEmailRoutingSettings(effectiveToken, zoneId);
    if (!settings.enabled) {
      await enableEmailRouting(effectiveToken, zoneId);
      routingEnabledByUs = true;
    }
    await setCatchAllToWorker(effectiveToken, zoneId, workerName);
    tasks.ok('routing', `*@${zoneObj.name} → ${workerName}`);
  } catch (e: any) {
    tasks.warn('routing', 'needs manual setup', {
      title: 'Email Routing not configured — mail will not arrive yet',
      body: `${e.message}\n\nEnable it by hand: Email → Email Routing → Enable,\nthen set the catch-all action to Worker "${workerName}".`,
    });
  }

  // Health. DNS and the edge certificate take a moment after the deploy, so
  // give them one rather than reporting a failure that fixes itself.
  tasks.run('health', 'probing /healthz…');
  const healthy = await probeHealth(dashboardHostname, (attempt, total) =>
    tasks.run('health', `probing /healthz… (${attempt}/${total})`)
  );
  if (healthy) tasks.ok('health', 'responding');
  else tasks.warn('health', 'not responding yet — DNS or certificate still propagating');

  tasks.stop();

  // Asked explicitly: this token can delete the Worker, the database and every
  // stored message, so it is never written to disk without a yes.
  blank();
  const saveToken = (await confirm({
    message: 'Save this token so `update` and `destroy` don\'t ask again?',
    initialValue: false,
  })) as boolean;
  if (isCancel(saveToken)) process.exit(0);
  const savedConfigPath = configPathFor(CONFIG_DIR, zoneObj.name);
  if (saveToken) {
    hint(`  Stored in ${savedConfigPath} (chmod 600). Delete the file to revoke it locally.`);
  } else {
    hint('  Not saved. Later commands read $CLOUDFLARE_API_TOKEN, or ask you to paste it.');
  }

  const cfg: Config = {
    api_token: saveToken ? effectiveToken : undefined,
    account_id: accountId,
    zone_id: zoneId,
    zone_name: zoneObj.name,
    worker_name: workerName,
    dashboard_hostname: dashboardHostname,
    admin_email: adminEmail,
    d1_database_id: d1.uuid,
    r2_raw_bucket: r2Raw.name,
    r2_attachments_bucket: r2Att.name,
    r2_html_bucket: r2Html.name,
    auth_mode: authMode,
    access_aud: accessAud || undefined,
    access_team_domain: teamDomain || undefined,
    access_app_id: accessAppId || undefined,
    email_routing_enabled_by_setup: routingEnabledByUs,
    installed_at: new Date().toISOString(),
  };
  const finalConfigPath = await saveConfig(cfg);

  finished('MailRiz is live', [
    ['dashboard', accent(`https://${dashboardHostname}`)],
    ['inbox', `anything@${zoneObj.name}`],
    ['auth', authMode === 'access' ? `Cloudflare Access · ${adminEmail}` : `password · ${adminEmail}`],
    ['state', `${finalConfigPath} (chmod 600)`],
  ], 'Send yourself a mail at any address on the domain — it lands in the dashboard.');
}

/** Open a URL with the platform's opener; silent when there's no GUI. */
async function openUrl(url: string): Promise<void> {
  const opener =
    process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'explorer'
    : 'xdg-open';
  try {
    await execFileP(opener, [url]);
    hint('  opened — create the token, then paste it below');
  } catch {
    hint(`  could not open a browser — visit the link above`);
  }
}

/**
 * Move aliases that were stored against the dashboard hostname onto the mail
 * domain. Earlier builds took the domain from the request Host header, so
 * aliases read as `name@inbox.example.com` while the catch-all only ever
 * delivers to `example.com` — every message bounced as "Address not found".
 *
 * Returns how many rows were corrected.
 */
async function repairAliasDomains(
  token: string,
  accountId: string,
  d1Id: string,
  dashboardHostname: string,
  mailDomain: string
): Promise<number> {
  if (dashboardHostname === mailDomain) return 0;
  const escaped = (s: string) => s.replace(/'/g, "''");
  const res = await d1Query(
    token,
    accountId,
    d1Id,
    `UPDATE aliases SET domain = '${escaped(mailDomain)}' ` +
    `WHERE domain = '${escaped(dashboardHostname)}';` +
    `SELECT changes() AS fixed;`
  );
  const rows = (res as any)?.[1]?.results ?? (res as any)?.results ?? [];
  return Number(rows?.[0]?.fixed ?? 0);
}

/**
 * Poll /healthz while DNS and the edge certificate settle. A fresh Custom
 * Domain is rarely answering the instant wrangler returns, so a single probe
 * reports a failure that would have cleared on its own.
 */
async function probeHealth(
  hostname: string,
  onAttempt: (attempt: number, total: number) => void,
  attempts = 10,
  delayMs = 3000
): Promise<boolean> {
  for (let i = 1; i <= attempts; i++) {
    onAttempt(i, attempts);
    try {
      if ((await fetch(`https://${hostname}/healthz`)).ok) return true;
    } catch {
      // DNS not resolving or the certificate isn't issued yet — keep waiting.
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

function readdirSorted(dir: string): Promise<string[]> {
  return import('node:fs/promises').then((fs) => fs.readdir(dir).then((f) => f.sort()));
}

// ---------------------------------------------------------------- status

async function cmdStatus(domain?: string) {
  banner();
  const cfg = await loadConfig(domain);
  if (!cfg) fail('Not installed. Run `mailriz-cli setup` first.');
  commandHeader('status', cfg.dashboard_hostname);
  const configPath = cfg._filePath || configPathFor(CONFIG_DIR, cfg.zone_name);
  rows([
    ['dashboard', `https://${cfg.dashboard_hostname}`],
    ['inbox', `anything@${cfg.zone_name}`],
    ['admin', cfg.admin_email],
    [
      'auth',
      cfg.auth_mode === 'access'
        ? cfg.access_team_domain
          ? `Cloudflare Access (${cfg.access_team_domain})`
          : // The Worker verifies Access JWTs against this domain's keys, so an
            // empty value rejects every request. Say so here rather than
            // leaving a locked-out dashboard to be guessed at.
            'Cloudflare Access — NO TEAM DOMAIN, run `reconfigure` to repair'
        : 'session password',
    ],
    ['worker', cfg.worker_name],
    ['d1', cfg.d1_database_id.slice(0, 8)],
    // Never the value — just whether a credential is sitting in the file.
    ['api token', cfg.api_token ? `saved in ${configPath}` : 'not saved'],
    ['installed', new Date(cfg.installed_at).toLocaleString()],
  ]);
  blank();

  try {
    await spin(
      'health',
      async () => {
        const res = await fetch(`https://${cfg.dashboard_hostname}/healthz`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res;
      },
      () => 'responding'
    );
  } catch {
    // spin already printed the failing row.
  }
  blank();
}

// ---------------------------------------------------------------- update

async function cmdUpdate(domain?: string) {
  banner();
  const cfg = await loadConfig(domain);
  if (!cfg) fail('Not installed. Run `mailriz-cli setup` first.');

  commandHeader('update', cfg.dashboard_hostname);
  hint('Replaces the Worker with the latest release. D1 and R2 data are untouched.');

  // Installations created before the aud tag was persisted would be redeployed
  // with a blank one, which locks the dashboard out entirely.
  if (cfg.auth_mode === 'access' && !cfg.access_aud) {
    blank();
    checkRow(false, 'access', 'no aud tag recorded for this installation');
    hint('  This install predates aud being saved. Redeploying would leave the');
    hint('  Worker rejecting every request. Run `reconfigure` instead — it');
    hint('  re-reads the Access application and keeps your mail.');
    blank();
    fail('Refusing to update — see above.');
  }
  blank();

  const token = await promptToken(cfg, 'to redeploy');

  // Session credentials changed shape: the password is now PBKDF2 with a salt,
  // and the cookie is signed with a key of its own. Neither can be derived
  // from the old bare SHA-256 — that is the point of a password hash — so the
  // only way forward is to set the password once more.
  let newHash: string | undefined;
  let newSigningKey: string | undefined;
  if (cfg.auth_mode === 'session') {
    blank();
    hint('Session credentials are being upgraded (salted hash + separate cookie key).');
    hint('The old password cannot be carried over, so set it again — existing');
    hint('sessions will end and you will log in once more.');
    hint('min 12 chars');
    const pw = (await password({
      message: 'Dashboard password',
      validate: (v) => (v && v.length >= 12 ? undefined : 'min 12 chars'),
    })) as string;
    if (isCancel(pw)) process.exit(0);
    newHash = await hashPassword(pw);
    newSigningKey = generateSigningKey();
  }

  blank();
  const tasks = new TaskList([
    { key: 'release', label: 'release' },
    // A release can carry schema changes; update never applied them, so new
    // columns were missing and the Worker failed on first query.
    { key: 'migrations', label: 'migrations' },
    { key: 'worker', label: 'worker' },
    { key: 'aliases', label: 'aliases' },
    { key: 'health', label: 'health' },
  ]);
  tasks.start();

  const abort: (msg: string) => never = (msg) => { tasks.stop(); fail(msg); };

  tasks.run('release', 'downloading latest…');
  let release: { dir: string; index: string; migrationsDir: string; assetsDir: string };
  try {
    release = await fetchReleaseAsset();
  } catch (e: any) {
    tasks.failTask('release', e.message);
    abort(`Release fetch failed: ${e.message}`);
  }
  tasks.ok('release', 'worker bundle ready');

  // Schema before code: the new bundle may query columns this release adds.
  tasks.run('migrations', 'checking…');
  try {
    const files = existsSync(release.migrationsDir) ? await readdirSorted(release.migrationsDir) : [];
    const applied = await applyMigrations(
      (sql) => d1Query(token, cfg.account_id, cfg.d1_database_id, sql),
      release.migrationsDir,
      files
    );
    tasks.ok('migrations', applied.length > 0 ? `${applied.length} applied` : 'up to date');
  } catch (e: any) {
    tasks.failTask('migrations', e.message);
    abort(`Migration failed: ${e.message}`);
  }

  tasks.run('worker', 'redeploying…');
  try {
    await deployWithWrangler({
      token,
      accountId: cfg.account_id,
      workerName: cfg.worker_name,
      releaseDir: release.dir,
      d1Id: cfg.d1_database_id,
      r2Raw: cfg.r2_raw_bucket,
      r2Att: cfg.r2_attachments_bucket,
      r2Html: cfg.r2_html_bucket,
      adminEmail: cfg.admin_email,
      dashboardHostname: cfg.dashboard_hostname,
      mailDomain: cfg.zone_name,
      authMode: cfg.auth_mode,
      accessAud: cfg.access_aud,
      accessTeamDomain: cfg.access_team_domain,
    });
    if (cfg.auth_mode === 'session') {
      await putSessionSecrets({
        token,
        accountId: cfg.account_id,
        releaseDir: release.dir,
        passwordHash: newHash!,
        signingKey: newSigningKey!,
      });
    }
  } catch (e: any) {
    tasks.failTask('worker', e.message);
    abort(`Update failed: ${e.message}`);
  }
  tasks.ok('worker', cfg.worker_name);

  // Aliases created by earlier builds sit on the dashboard hostname and can
  // never receive mail; move them to the mail domain.
  tasks.run('aliases', 'checking domains…');
  try {
    const fixed = await repairAliasDomains(
      token, cfg.account_id, cfg.d1_database_id, cfg.dashboard_hostname, cfg.zone_name
    );
    tasks.ok('aliases', fixed > 0 ? `${fixed} moved to @${cfg.zone_name}` : 'already correct');
  } catch (e: any) {
    tasks.warn('aliases', 'could not check', {
      title: 'Alias domains not verified',
      body:
        `${e.message}\n\nIf mail bounces as "Address not found", your aliases may still\n` +
        `be stored against ${cfg.dashboard_hostname} instead of ${cfg.zone_name}.`,
    });
  }

  tasks.run('health', 'probing /healthz…');
  let healthy = false;
  try {
    healthy = (await fetch(`https://${cfg.dashboard_hostname}/healthz`)).ok;
  } catch {}
  if (healthy) tasks.ok('health', 'responding');
  else tasks.warn('health', 'not reachable yet');

  tasks.stop();

  finished('Updated', [
    ['dashboard', accent(`https://${cfg.dashboard_hostname}`)],
    ['data', 'preserved — D1 and R2 untouched'],
  ]);
}

// ---------------------------------------------------------------- reconfigure

/**
 * Repair or change an existing installation in place. `setup` used to double
 * as this, which is why it never refused to run twice; this reuses the
 * recorded account, zone, database and buckets, and touches only what a
 * repair needs — auth, admin email, Access application, deployed Worker.
 */
async function cmdReconfigure(domain?: string) {
  banner();
  const cfg = await loadConfig(domain);
  if (!cfg) fail('Not installed. Run `mailriz-cli setup` first.');

  commandHeader('reconfigure', cfg.dashboard_hostname);
  hint('Reuses this installation — the database and buckets are not touched.');
  hint(`Zone ${cfg.zone_name} and hostname ${cfg.dashboard_hostname} are fixed;`);
  hint('changing either means destroy and setup.');
  blank();

  const token = await promptToken(cfg, 'to reconfigure');
  blank();

  try {
    await spin('token', () => verifyToken(token), (v) => `valid · ${v.id}`);
  } catch (e: any) {
    fail(`Token verification failed: ${e.message}`);
  }

  const adminEmail = (await text({
    message: 'Admin email',
    placeholder: cfg.admin_email,
    initialValue: cfg.admin_email,
    validate: (v) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v || '') ? undefined : 'Invalid email'),
  })) as string;
  if (isCancel(adminEmail)) process.exit(0);

  blank();
  let teamDomain = '';
  let accessAvailable = false;
  try {
    const org = await spin(
      'zero trust',
      () => getAccessOrganization(token, cfg.account_id),
      (o) => o.auth_domain || 'available'
    );
    teamDomain = org.auth_domain || '';
    accessAvailable = true;
  } catch {
    hint('  Access needs a token with Zero Trust permissions. Password auth');
    hint('  works without them.');
  }
  blank();

  const useAccess = accessAvailable
    ? ((await confirm({
        message: 'Use Cloudflare Access for auth? (recommended)',
        initialValue: cfg.auth_mode === 'access',
      })) as boolean)
    : false;
  if (isCancel(useAccess)) process.exit(0);

  const authMode: 'access' | 'session' = useAccess ? 'access' : 'session';
  let sessionHash: string | undefined;
  let signingKey: string | undefined;
  if (!useAccess) {
    hint('min 12 chars');
    const pw = (await password({
      message: accessAvailable ? 'Set a dashboard password' : 'Set a dashboard password (Access unavailable)',
      validate: (v) => (v && v.length >= 12 ? undefined : 'min 12 chars'),
    })) as string;
    if (isCancel(pw)) process.exit(0);
    sessionHash = await hashPassword(pw);
    signingKey = generateSigningKey();
  }

  blank();
  const tasks = new TaskList([
    { key: 'release', label: 'release' },
    { key: 'migrations', label: 'migrations' },
    { key: 'access', label: 'access' },
    { key: 'worker', label: 'worker' },
    { key: 'routing', label: 'email routing' },
    { key: 'health', label: 'health' },
  ]);
  tasks.start();

  const abort: (msg: string) => never = (msg) => { tasks.stop(); fail(msg); };

  tasks.run('release', 'downloading latest…');
  let release: { dir: string; index: string; migrationsDir: string; assetsDir: string };
  try {
    release = await fetchReleaseAsset();
  } catch (e: any) {
    tasks.failTask('release', e.message);
    abort(`Release fetch failed: ${e.message}`);
  }
  tasks.ok('release', 'worker bundle ready');

  tasks.run('migrations', 'checking…');
  try {
    const files = existsSync(release.migrationsDir) ? await readdirSorted(release.migrationsDir) : [];
    const applied = await applyMigrations(
      (sql) => d1Query(token, cfg.account_id, cfg.d1_database_id, sql),
      release.migrationsDir,
      files
    );
    tasks.ok('migrations', applied.length > 0 ? `${applied.length} applied` : 'up to date');
  } catch (e: any) {
    tasks.failTask('migrations', e.message);
    abort(`Migration failed: ${e.message}`);
  }

  let accessAud = '';
  let accessAppId = '';
  if (useAccess) {
    tasks.run('access', 'checking application…');
    try {
      const app = await ensureAccessApp(token, cfg.account_id, cfg.dashboard_hostname, adminEmail);
      accessAud = app.aud;
      accessAppId = app.id;
      if (app.reused && adminEmail !== cfg.admin_email) {
        tasks.warn('access', `reused · ${accessAppId.slice(0, 8)}`, {
          title: 'Access policy not updated',
          body:
            `An application already guards ${cfg.dashboard_hostname}, so it was reused\n` +
            `rather than duplicated. Its policy still names ${cfg.admin_email}.\n` +
            `Update it under Zero Trust → Access → Applications to admit ${adminEmail}.`,
        });
      } else {
        tasks.ok('access', app.reused ? `reused · ${adminEmail}` : `created · ${adminEmail}`);
      }
    } catch (e: any) {
      tasks.failTask('access', e.message);
      abort(
        `Cloudflare Access setup failed: ${e.message}\n` +
        `  Without an audience tag the Worker rejects every request, so this stops here.`
      );
    }
  } else {
    tasks.skip('access', 'password auth');
  }

  tasks.run('worker', 'redeploying…');
  try {
    await deployWithWrangler({
      token,
      accountId: cfg.account_id,
      workerName: cfg.worker_name,
      releaseDir: release.dir,
      d1Id: cfg.d1_database_id,
      r2Raw: cfg.r2_raw_bucket,
      r2Att: cfg.r2_attachments_bucket,
      r2Html: cfg.r2_html_bucket,
      adminEmail,
      dashboardHostname: cfg.dashboard_hostname,
      mailDomain: cfg.zone_name,
      authMode,
      accessAud,
      accessTeamDomain: teamDomain,
    });
    if (authMode === 'session') {
      await putSessionSecrets({
        token,
        accountId: cfg.account_id,
        releaseDir: release.dir,
        passwordHash: sessionHash!,
        signingKey: signingKey!,
      });
    }
  } catch (e: any) {
    tasks.failTask('worker', e.message);
    abort(`Worker deploy failed: ${e.message}`);
  }
  tasks.ok('worker', `${cfg.worker_name} → ${cfg.dashboard_hostname}`);

  // A rename or a manual edit in the dashboard can leave the catch-all
  // pointing somewhere else; put it back rather than leaving mail undelivered.
  tasks.run('routing', 'checking catch-all…');
  let routingEnabledByUs = cfg.email_routing_enabled_by_setup;
  try {
    const settings = await getEmailRoutingSettings(token, cfg.zone_id);
    if (!settings.enabled) {
      await enableEmailRouting(token, cfg.zone_id);
      routingEnabledByUs = true;
    }
    if (!catchAllTargets(await getCatchAllRule(token, cfg.zone_id).catch(() => null), cfg.worker_name)) {
      await setCatchAllToWorker(token, cfg.zone_id, cfg.worker_name);
      tasks.ok('routing', `*@${cfg.zone_name} → ${cfg.worker_name} (restored)`);
    } else {
      tasks.ok('routing', `*@${cfg.zone_name} → ${cfg.worker_name}`);
    }
  } catch (e: any) {
    tasks.warn('routing', 'needs manual setup', {
      title: 'Email Routing not configured — mail will not arrive',
      body: `${e.message}\n\nSet the catch-all action to Worker "${cfg.worker_name}" by hand.`,
    });
  }

  tasks.run('health', 'probing /healthz…');
  const healthy = await probeHealth(cfg.dashboard_hostname, (a, t) =>
    tasks.run('health', `probing /healthz… (${a}/${t})`)
  );
  if (healthy) tasks.ok('health', 'responding');
  else tasks.warn('health', 'not responding yet');

  tasks.stop();

  await saveConfig({
    ...cfg,
    // Refresh a saved token with the one that just worked, so rotating a
    // credential does not leave the revoked one on disk for `destroy` to
    // fail on later. A config that never stored a token still doesn't.
    api_token: cfg.api_token ? token : undefined,
    admin_email: adminEmail,
    auth_mode: authMode,
    access_aud: accessAud || undefined,
    access_team_domain: teamDomain || undefined,
    access_app_id: accessAppId || undefined,
    email_routing_enabled_by_setup: routingEnabledByUs,
  });

  finished('Reconfigured', [
    ['dashboard', accent(`https://${cfg.dashboard_hostname}`)],
    ['auth', authMode === 'access' ? `Cloudflare Access · ${adminEmail}` : `password · ${adminEmail}`],
    ['data', 'preserved — D1 and R2 untouched'],
  ]);
}

// ---------------------------------------------------------------- destroy


async function cmdDestroy(domain?: string) {
  banner();
  const cfg = await loadConfig(domain);
  if (!cfg) fail('Not installed.');

  commandHeader('destroy', cfg.dashboard_hostname);
  console.log(`  ${pc.red(pc.bold('This is irreversible.'))} ${pc.dim('There is no backup and no undo.')}`);
  blank();

  const token = await promptToken(cfg, 'to delete everything');

  // Verify before anything else: a revoked token used to sail through every
  // DELETE, each one failing and each one reported as "deleted".
  blank();
  let tokenId: string;
  try {
    tokenId = (await spin('token', () => verifyToken(token), (v) => `valid · ${v.id}`)).id;
  } catch (e: any) {
    fail(
      `Token verification failed: ${e.message}\n` +
      `  Nothing was deleted. Check the token has not been revoked.`
    );
  }

  // S3 credentials for emptying the buckets, derived from the same token.
  let r2: R2Client | null = null;
  try {
    r2 = createR2Client(cfg.account_id, await deriveS3Credentials(tokenId, token));
  } catch {
    r2 = null;
  }

  let inv: Inventory;
  /** Non-fatal lookup failures — the preview below has a hole in it. */
  const inventoryNotes: string[] = [];
  try {
    inv = await spin(
      'inventory',
      () => takeInventory(cfg, token, r2, (m) => inventoryNotes.push(m)),
      () => 'read from Cloudflare'
    );
  } catch (e: any) {
    fail(`Could not read the installation: ${e.message}\n  Nothing was deleted.`);
  }
  for (const n of inventoryNotes) hint(`  ${n}`);

  // What is really there, not what config.json claims.
  blank();
  heading('This will permanently delete');
  const storedObjects = [...inv.buckets.values()].reduce<number>(
    (n, c) => (typeof c === 'number' && c > 0 ? n + c : n),
    0
  );
  rows([
    ['worker', inv.workerExists ? cfg.worker_name : pc.dim(`${cfg.worker_name} — already gone`)],
    [
      'dns',
      inv.domains.length
        ? `${cfg.dashboard_hostname} — custom domain and its record`
        : pc.dim(`${cfg.dashboard_hostname} — already gone`),
    ],
    [
      'd1',
      inv.d1Exists
        ? `${cfg.d1_database_id.slice(0, 8)} — every stored email`
        : pc.dim(`${cfg.d1_database_id.slice(0, 8)} — already gone`),
    ],
  ]);
  for (const name of bucketsOf(cfg)) {
    rows([['r2', `${name} — ${describeBucket(inv.buckets.get(name), inv.bucketsTruncated.has(name))}`]]);
  }
  if (cfg.auth_mode === 'access') {
    rows([['access', inv.accessAppId ? `application ${inv.accessAppId.slice(0, 8)}` : pc.dim('no application found')]]);
  }
  const targetConfigPath = cfg._filePath || configPathFor(CONFIG_DIR, cfg.zone_name);
  rows([['state', targetConfigPath]]);

  // The buckets are the part people do not picture: D1 holds the metadata,
  // R2 holds the messages themselves.
  blank();
  const unreadable = [...inv.buckets.values()].some((c) => c === UNREADABLE);
  if (storedObjects > 0 || inv.bucketsTruncated.size > 0) {
    console.log(
      `  ${pc.red(pc.bold('R2 data will be erased.'))} ` +
      pc.dim('Every raw message, attachment and HTML')
    );
    hint('body is deleted from the buckets before the buckets themselves go.');
    hint('That is the complete archive — nothing is exported first.');
  } else if (unreadable) {
    console.log(
      `  ${pc.red(pc.bold('R2 data will be erased.'))} ` +
      pc.dim('The buckets exist but their contents')
    );
    hint('could not be listed, so how much mail is in them is unknown. Everything');
    hint('found in them will be deleted.');
  } else {
    hint('The buckets hold no objects, so there is no stored mail to lose.');
  }

  // Email Routing: only remove what MailRiz put there.
  blank();
  let disableRouting = false;
  const choice = routingChoice(inv.routingEnabled, cfg.email_routing_enabled_by_setup);
  if (choice === 'disable') {
    disableRouting = true;
    hint('Email Routing was enabled by setup, so it will be turned off and its');
    hint(`MX, SPF and DKIM records removed from ${cfg.zone_name}.`);
  } else if (choice === 'keep' && inv.routingEnabled) {
    hint('Email Routing was already on before MailRiz, so it stays on. Only the');
    hint('catch-all rule pointing at the Worker is removed.');
  } else if (choice === 'ask') {
    hint('This installation predates MailRiz recording whether it enabled Email');
    hint(`Routing on ${cfg.zone_name}. Turning it off removes the MX, SPF and DKIM`);
    hint('records, which breaks mail if the zone used routing before MailRiz.');
    blank();
    const answer = (await confirm({
      message: `Turn Email Routing off for ${cfg.zone_name} too?`,
      initialValue: false,
    })) as boolean;
    if (isCancel(answer)) process.exit(0);
    disableRouting = answer;
  }

  blank();
  // Typing the hostname beats a second yes/no — it can't be muscle-memoried.
  const typed = (await text({
    message: `Type the dashboard hostname to confirm`,
    placeholder: cfg.dashboard_hostname,
  })) as string;
  if (isCancel(typed)) process.exit(0);
  if (typed.trim() !== cfg.dashboard_hostname) {
    aborted('Hostname did not match — nothing was deleted.');
    process.exit(0);
  }

  blank();
  const tasks = new TaskList([
    { key: 'routing', label: 'email routing' },
    { key: 'dns', label: 'dns' },
    { key: 'worker', label: 'worker' },
    { key: 'access', label: 'access' },
    { key: 'r2', label: 'r2' },
    { key: 'd1', label: 'd1' },
    { key: 'verify', label: 'verify' },
    { key: 'state', label: 'state' },
  ]);
  tasks.start();

  /** Steps that did not complete. The config file survives if this is non-empty. */
  const failures: string[] = [];
  const record = (label: string, e: unknown) => {
    failures.push(`${label}: ${(e as Error).message}`);
  };

  // Catch-all first: once the Worker is gone a rule still pointing at it
  // black-holes every message the domain receives.
  tasks.run('routing', 'releasing catch-all…');
  if (inv.unreadable.includes('email routing')) {
    // Not "not enabled" — the state was never read.
    tasks.warn('routing', 'state unreadable — catch-all not touched');
  } else if (!inv.routingEnabled) {
    tasks.skip('routing', 'not enabled');
  } else {
    try {
      if (inv.catchAllPointsAtWorker) await clearCatchAll(token, cfg.zone_id);
      if (disableRouting) {
        await disableEmailRouting(token, cfg.zone_id);
        tasks.ok('routing', `disabled · MX and SPF removed from ${cfg.zone_name}`);
      } else {
        tasks.ok('routing', inv.catchAllPointsAtWorker ? 'catch-all released' : 'nothing pointed here');
      }
    } catch (e) {
      tasks.failTask('routing', (e as Error).message);
      record('email routing', e);
    }
  }

  // Custom Domain before the script: it owns the DNS record, and deleting the
  // Worker does not reliably take it along.
  tasks.run('dns', 'removing custom domain…');
  if (inv.unreadable.includes('custom domain')) {
    tasks.warn('dns', 'could not be listed — record may remain');
  } else if (inv.domains.length === 0) {
    tasks.skip('dns', 'no custom domain found');
  } else {
    try {
      for (const d of inv.domains) await deleteWorkerDomain(token, cfg.account_id, d.id);
      tasks.ok('dns', `${cfg.dashboard_hostname} detached`);
    } catch (e) {
      tasks.failTask('dns', (e as Error).message);
      record('custom domain', e);
    }
  }

  tasks.run('worker', 'deleting script…');
  try {
    const outcome = await deleteWorkerScript(token, cfg.account_id, cfg.worker_name);
    tasks.ok('worker', outcome === 'absent' ? 'was already gone' : 'deleted');
  } catch (e) {
    tasks.failTask('worker', (e as Error).message);
    record('worker', e);
  }

  tasks.run('access', 'removing application…');
  if (inv.unreadable.includes('access application')) {
    tasks.warn('access', 'could not be listed — application may remain');
  } else if (!inv.accessAppId) {
    tasks.skip('access', cfg.auth_mode === 'access' ? 'no application found' : 'password auth');
  } else {
    try {
      const outcome = await deleteAccessApp(token, cfg.account_id, inv.accessAppId);
      tasks.ok('access', outcome === 'absent' ? 'was already gone' : 'deleted');
    } catch (e) {
      tasks.failTask('access', (e as Error).message);
      record('access application', e);
    }
  }

  // Empty, then delete: Cloudflare rejects the bucket delete while objects
  // remain.
  tasks.run('r2', 'emptying buckets…');
  const allBuckets = bucketsOf(cfg);
  let purged = 0;
  let bucketsGone = 0;
  let alreadyGone = 0;
  for (const name of allBuckets) {
    if (inv.buckets.get(name) === null) {
      alreadyGone++;
      continue;
    }
    try {
      if (r2) {
        const n = await emptyBucket(r2, name, (d) =>
          tasks.run('r2', `emptying ${name}… ${purged + d} objects`)
        );
        purged += n;
      }
      tasks.run('r2', `deleting ${name}…`);
      await deleteR2Bucket(token, cfg.account_id, name);
      bucketsGone++;
    } catch (e) {
      record(`r2 bucket ${name}`, e);
    }
  }
  const objects = `${purged} object${purged === 1 ? '' : 's'} deleted`;
  if (failures.some((f) => f.startsWith('r2 bucket'))) {
    tasks.failTask('r2', `${bucketsGone + alreadyGone}/${allBuckets.length} removed · ${objects}`);
  } else {
    tasks.ok(
      'r2',
      alreadyGone
        ? `${bucketsGone} removed · ${alreadyGone} already gone · ${objects}`
        : `${bucketsGone} buckets removed · ${objects}`
    );
  }

  tasks.run('d1', 'deleting database…');
  try {
    const outcome = await deleteD1(token, cfg.account_id, cfg.d1_database_id);
    tasks.ok('d1', outcome === 'absent' ? 'was already gone' : 'deleted');
  } catch (e) {
    tasks.failTask('d1', (e as Error).message);
    record('d1 database', e);
  }

  // Every row above reports what its own call returned; this is the only step
  // that checks the account actually looks empty.
  tasks.run('verify', 're-reading account…');
  let leftover: string[] = [];
  try {
    leftover = leftovers(await takeInventory(cfg, token, r2, () => {}), cfg);
    tasks.set(
      'verify',
      leftover.length ? 'fail' : 'ok',
      leftover.length ? `${leftover.length} still present` : 'account is clean'
    );
  } catch (e) {
    tasks.failTask('verify', (e as Error).message);
    record('verification', e);
  }

  // The config file is the only record of what belongs to this installation,
  // so removing it while anything survives makes the leftovers unfindable.
  const clean = failures.length === 0 && leftover.length === 0;
  tasks.run('state', 'removing config…');

  if (clean) {
    try {
      await rm(targetConfigPath, { force: true });
      // Also clean up default config if it pointed to this
      if (targetConfigPath !== DEFAULT_CONFIG_PATH && existsSync(DEFAULT_CONFIG_PATH)) {
        try {
          const defRaw = await readFile(DEFAULT_CONFIG_PATH, 'utf8');
          const defObj = JSON.parse(defRaw);
          if (defObj.zone_name === cfg.zone_name || defObj.worker_name === cfg.worker_name) {
            await rm(DEFAULT_CONFIG_PATH, { force: true });
          }
        } catch {}
      }
      // The extracted release otherwise sits in ~/.mailriz/.temp indefinitely.
      await rm(TMP_DIR, { recursive: true, force: true });
      tasks.ok('state', 'config and cached release removed');
    } catch (e) {
      tasks.failTask('state', (e as Error).message);
      record('config file', e);
    }
  } else {
    tasks.warn('state', 'kept — teardown incomplete');
  }

  tasks.stop();

  if (clean) {
    finished('Destroyed', destroySummary({
      hostname: cfg.dashboard_hostname,
      zoneName: cfg.zone_name,
      purged,
      bucketsRemoved: bucketsGone,
      workerWasPresent: inv.workerExists,
      domainWasPresent: inv.domains.length > 0,
      d1WasPresent: inv.d1Exists,
      routingWasEnabled: inv.routingEnabled,
      routingDisabled: disableRouting,
      catchAllWasPointing: inv.catchAllPointsAtWorker,
    }), 'The edge certificate for the hostname is not removed by this API — drop it\nunder SSL/TLS → Edge Certificates if you want it gone.');
    return;
  }

  blank();
  aborted('Teardown incomplete — nothing was assumed deleted.');
  for (const f of failures) bullet(f);
  for (const l of leftover) bullet(`still present: ${l}`);
  hint(`${targetConfigPath} was kept so you can run destroy again once the cause is`);
  hint('fixed — usually a token missing a scope, or one that has been revoked.');
  blank();
  process.exit(1);
}

// ---------------------------------------------------------------- main

const COMMANDS: [string, string][] = [
  ['setup', 'Deploy end-to-end — Worker, D1, R2, DNS, Email Routing, Access'],
  ['status', 'Show the installation and probe the Worker'],
  ['update', 'Move the Worker to the latest release, keeping all data'],
  ['reconfigure', 'Change auth, admin email or repair Access — keeps all data'],
  ['destroy', 'Delete the Worker, DNS, database and every stored message'],
];

function cmdHelp(unknown?: string): void {
  banner();
  if (unknown) {
    aborted(`Unknown command: ${unknown}`);
  }
  commandHeader('commands');
  rows(COMMANDS.map(([name, desc]) => [name, pc.dim(desc)]));
  blank();
  hint('Run without a command to start setup. Config lives in ~/.mailriz/config.json.');
  blank();
}

const cmd = process.argv[2] || 'setup';
const targetDomain = process.argv[3];

if (cmd === 'setup') cmdSetup();
else if (cmd === 'status') cmdStatus(targetDomain);
else if (cmd === 'update') cmdUpdate(targetDomain);
else if (cmd === 'reconfigure') cmdReconfigure(targetDomain);
else if (cmd === 'destroy') cmdDestroy(targetDomain);
else if (['help', '--help', '-h'].includes(cmd)) cmdHelp();
else {
  cmdHelp(cmd);
  process.exit(1);
}
