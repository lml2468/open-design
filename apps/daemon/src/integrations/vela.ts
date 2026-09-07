import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { createCommandInvocation } from '@open-design/platform';

import { resolveAgentLaunch } from '../runtimes/launch.js';
import { spawnEnvForAgent } from '../runtimes/env.js';
import { getAgentDef } from '../runtimes/registry.js';
import { resolveAmrProfile } from './vela-profile.js';
import { resolveEffectiveVelaConsoleOrigin } from './vela-console-origin.js';

export { resolveAmrProfile } from './vela-profile.js';

function isCanonicalAmrAuthAttemptId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export interface VelaUser {
  id: string;
  email: string;
  name?: string;
  image?: string | null;
  plan?: string;
}

export interface VelaLoginStatus {
  loggedIn: boolean;
  credentialRevision?: string;
  loginInFlight: boolean;
  profile: string;
  user: VelaUser | null;
  configPath: string;
  /**
   * Device-authorization URL parsed from `vela login` stdout, surfaced so the
   * user can complete sign-in manually when the browser did not auto-open.
   * Present only while a login is in flight and after vela has printed it.
   */
  activationUrl?: string;
  /** Device-authorization user code printed alongside the activation URL. */
  userCode?: string;
  /** True when vela warned it could not open the browser automatically. */
  browserOpenFailed?: boolean;
  /**
   * Origin of the vela web console this runtime talks to, when it was given
   * one. See {@link resolveVelaConsoleOrigin} — the client needs it to build
   * wallet / plans / upgrade links for a non-public AMR environment.
   */
  consoleOrigin?: string;
  authAttemptId?: string;
}

/**
 * The vela web console origin this runtime was configured with, normalized
 * without a trailing slash, or undefined when it was given none.
 *
 * Non-prod AMR environments are internal deployments, so their hostnames are
 * not literals in this public repository: packaging injects the origin from a
 * CI secret and the packaged runtime forwards it as `OD_VELA_WEB_URL`. Reporting
 * it on the login status is how the web client learns which console to link to.
 * The resolver combines that packaged origin with the settings-selected AMR
 * profile, so a runtime switch cannot keep linking to the package's backend.
 */
export function resolveVelaConsoleOrigin(
  env: NodeJS.ProcessEnv = process.env,
  configuredEnv: Record<string, string> = {},
): string | undefined {
  return resolveEffectiveVelaConsoleOrigin(env, configuredEnv);
}

interface VelaLoginAttemptSnapshot {
  authAttemptId?: string;
}

export interface VelaLoginActivation {
  activationUrl: string | null;
  userCode: string | null;
  browserOpenFailed: boolean;
}

// `vela login` is a device-authorization flow. Before it best-effort opens the
// browser it prints, to stdout, the exact lines:
//
//   Open this URL to continue:
//   <activation-url>
//
//   Code: <user-code>
//
// and, when the auto-open fails, warns on stderr "could not open browser
// automatically: …" (see apps/cli/internal/commands/login.go in the vela repo).
// The daemon spawns vela login headless, so this parser recovers the URL/code/
// warning from the captured streams to surface them to the user. Pure so the
// extraction rules stay unit-testable against vela's literal output format.
export function parseVelaLoginActivation(
  stdout: string,
  stderr: string,
): VelaLoginActivation {
  const urlMatch = /Open this URL to continue:\s*\r?\n\s*(\S+)/i.exec(stdout);
  // Anchor on a line start so a `user_code=` query param inside the URL is not
  // mistaken for the dedicated `Code:` line.
  const codeMatch = /^[^\S\r\n]*Code:\s*(\S+)/im.exec(stdout);
  return {
    activationUrl: urlMatch?.[1] ?? null,
    userCode: codeMatch?.[1] ?? null,
    browserOpenFailed: /could not open browser automatically/i.test(stderr),
  };
}

export interface VelaCredentialRevision {
  authSource: 'env' | 'file' | 'none';
  profile: string;
  loggedIn: boolean;
  userId: string;
  userEmail: string;
  configMtimeMs: number | null;
  /**
   * Non-secret fingerprint of the configured AMR env credentials
   * (`VELA_RUNTIME_KEY` / `VELA_LINK_URL`, which can come from `agentCliEnv.amr`
   * in app-config, not just process env). Env-backed sessions report
   * `user: null`, so without this an account switch that only rewrites the
   * Settings-backed env (leaving `~/.amr/config.json` untouched) would reuse the
   * previous account's cached plan/balance. File-backed sessions fingerprint
   * the stored keys as well, so a successful login is recognized even when a
   * filesystem preserves the config mtime.
   */
  credentialFingerprint: string;
}

export interface VelaControlApiContext {
  profile: string;
  apiUrl: string;
  controlKey: string;
  user: VelaUser | null;
  configMtimeMs: number | null;
}

export interface VelaApiContext {
  profile: string;
  apiUrl: string;
}

interface VelaProfileShape {
  controlKey?: string;
  runtimeKey?: string;
  apiUrl?: string;
  linkUrl?: string;
  user?: VelaUser | null;
}

interface VelaConfigFileShape {
  profiles?: Record<string, VelaProfileShape>;
}

interface VelaProfileConfigSnapshot {
  profile: string;
  stored: VelaProfileShape | undefined;
  configMtimeMs: number | null;
}

export function mergeVelaEnv(
  env: NodeJS.ProcessEnv = process.env,
  configuredEnv: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...env,
    ...configuredEnv,
  };
}

function configDir(): string {
  const amrHome = process.env.AMR_HOME?.trim();
  if (amrHome === '~') return homedir();
  if (amrHome?.startsWith('~/')) return path.join(homedir(), amrHome.slice(2));
  if (amrHome) return amrHome;
  return path.join(homedir(), '.amr');
}

export function amrConfigPath(): string {
  return path.join(configDir(), 'config.json');
}

function readConfigFile(): VelaConfigFileShape | null {
  const file = amrConfigPath();
  if (!existsSync(file)) return null;
  try {
    const data = readFileSync(file, 'utf8');
    const parsed = JSON.parse(data) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as VelaConfigFileShape;
  } catch {
    return null;
  }
}

function readVelaProfileConfigSnapshot(
  env: NodeJS.ProcessEnv = process.env,
  configuredEnv: Record<string, string> = {},
): VelaProfileConfigSnapshot {
  const mergedEnv = mergeVelaEnv(env, configuredEnv);
  const profile = resolveAmrProfile(mergedEnv);
  const file = readConfigFile();
  return {
    profile,
    stored: file?.profiles?.[profile],
    configMtimeMs: existsSync(amrConfigPath()) ? statSync(amrConfigPath()).mtimeMs : null,
  };
}

export function readVelaLoginStatus(
  env: NodeJS.ProcessEnv = process.env,
  configuredEnv: Record<string, string> = {},
): VelaLoginStatus {
  const rawStatus = readRawVelaLoginStatus(env, configuredEnv);
  const credentialRevision = velaCredentialRevisionDigest(
    readRawVelaCredentialRevision(env, configuredEnv, rawStatus),
  );
  return {
    ...rawStatus,
    credentialRevision,
  };
}

function readRawVelaLoginStatus(
  env: NodeJS.ProcessEnv = process.env,
  configuredEnv: Record<string, string> = {},
): Omit<VelaLoginStatus, 'credentialRevision'> {
  const mergedEnv = mergeVelaEnv(env, configuredEnv);
  const profile = resolveAmrProfile(mergedEnv);
  const configPath = amrConfigPath();
  const loginInFlight = isVelaLoginInFlight();
  // Only meaningful while signing in (loggedIn becomes true once vela writes the
  // runtime key); empty otherwise so completed sessions don't echo a stale URL.
  const activationFields: Partial<VelaLoginStatus> =
    loginInFlight && activeLoginActivation
      ? {
          ...(activeLoginActivation.activationUrl
            ? { activationUrl: activeLoginActivation.activationUrl }
            : {}),
          ...(activeLoginActivation.userCode
            ? { userCode: activeLoginActivation.userCode }
            : {}),
          ...(activeLoginActivation.browserOpenFailed
            ? { browserOpenFailed: true }
            : {}),
        }
      : {};
  const runtimeKey = mergedEnv.VELA_RUNTIME_KEY?.trim() ?? '';
  const linkUrl = mergedEnv.VELA_LINK_URL?.trim() ?? '';
  if (runtimeKey && linkUrl) {
    return {
      loggedIn: true,
      loginInFlight,
      profile,
      user: null,
      configPath,
      ...readVelaLoginAttemptSnapshot(),
    };
  }
  const file = readConfigFile();
  const stored = file?.profiles?.[profile];
  const storedRuntimeKey = stored?.runtimeKey?.trim() ?? '';
  if (!storedRuntimeKey) {
    return {
      loggedIn: false,
      loginInFlight,
      profile,
      user: null,
      configPath,
      ...activationFields,
      ...readVelaLoginAttemptSnapshot(),
    };
  }
  const rawUser = stored?.user ?? null;
  const user: VelaUser | null = rawUser
    ? {
        id: typeof rawUser.id === 'string' ? rawUser.id : '',
        email: typeof rawUser.email === 'string' ? rawUser.email : '',
        ...(typeof rawUser.name === 'string' ? { name: rawUser.name } : {}),
        ...(typeof rawUser.image === 'string' ? { image: rawUser.image } : {}),
        ...(typeof rawUser.plan === 'string' ? { plan: rawUser.plan } : {}),
      }
    : null;
  return {
    loggedIn: true,
    loginInFlight,
    profile,
    user,
    configPath,
    ...readVelaLoginAttemptSnapshot(),
  };
}

export function readVelaCredentialRevision(
  env: NodeJS.ProcessEnv = process.env,
  configuredEnv: Record<string, string> = {},
): VelaCredentialRevision {
  return readRawVelaCredentialRevision(
    env,
    configuredEnv,
    readRawVelaLoginStatus(env, configuredEnv),
  );
}

function readRawVelaCredentialRevision(
  env: NodeJS.ProcessEnv,
  configuredEnv: Record<string, string>,
  status: Omit<VelaLoginStatus, 'credentialRevision'>,
): VelaCredentialRevision {
  const mergedEnv = mergeVelaEnv(env, configuredEnv);
  const hasEnvCredentials =
    (mergedEnv.VELA_RUNTIME_KEY?.trim() ?? '').length > 0 &&
    (mergedEnv.VELA_LINK_URL?.trim() ?? '').length > 0;
  // One-way hash (never the raw key) so the cache key distinguishes env-backed
  // accounts whose only difference is the configured runtime credential.
  const fileProfile = hasEnvCredentials
    ? undefined
    : readConfigFile()?.profiles?.[status.profile];
  const credentialFingerprint = createHash('sha256')
    .update(
      hasEnvCredentials
        ? `${mergedEnv.VELA_RUNTIME_KEY ?? ''}\n${mergedEnv.VELA_LINK_URL ?? ''}`
        : [
            fileProfile?.runtimeKey ?? '',
            fileProfile?.controlKey ?? '',
            fileProfile?.linkUrl ?? '',
            fileProfile?.apiUrl ?? '',
          ].join('\n'),
    )
    .digest('hex')
    .slice(0, 16);
  return {
    authSource: hasEnvCredentials ? 'env' : status.loggedIn ? 'file' : 'none',
    profile: status.profile,
    loggedIn: status.loggedIn,
    userId: status.user?.id ?? '',
    userEmail: status.user?.email ?? '',
    // Include the config mtime even for env-backed auth: the live billing
    // summary is fetched with the config profile's controlKey, so a config
    // rewrite (account switch) must invalidate the cached plan/balance — even
    // when VELA_RUNTIME_KEY is the active runtime credential. Otherwise an
    // env-backed session keeps serving the previous account's plan/balance.
    configMtimeMs: existsSync(status.configPath)
      ? statSync(status.configPath).mtimeMs
      : null,
    credentialFingerprint,
  };
}

const expiredVelaControlKeys = new Set<string>();

function velaCredentialRevisionDigest(revision: VelaCredentialRevision): string {
  return createHash('sha256')
    .update(JSON.stringify(revision))
    .digest('hex')
    .slice(0, 20);
}

/** Mark only the currently-active credential revision as rejected upstream. */
export function markVelaAuthorizationExpired(
  env: NodeJS.ProcessEnv = process.env,
  configuredEnv: Record<string, string> = {},
): string {
  const revision = velaCredentialRevisionDigest(readVelaCredentialRevision(env, configuredEnv));
  const control = readRawVelaControlApiContext(env, configuredEnv);
  if (control) expiredVelaControlKeys.add(velaControlKeyDigest(control.controlKey));
  return revision;
}

/** Test/logout seam. A rotated credential naturally has a different revision. */
export function clearVelaAuthorizationState(): void {
  expiredVelaControlKeys.clear();
}

function velaControlKeyDigest(controlKey: string): string {
  return createHash('sha256').update(controlKey).digest('hex').slice(0, 20);
}

export function readVelaControlApiContext(
  env: NodeJS.ProcessEnv = process.env,
  configuredEnv: Record<string, string> = {},
): VelaControlApiContext | null {
  const context = readRawVelaControlApiContext(env, configuredEnv);
  if (
    context
    && expiredVelaControlKeys.has(velaControlKeyDigest(context.controlKey))
  ) return null;
  return context;
}

function readRawVelaControlApiContext(
  env: NodeJS.ProcessEnv = process.env,
  configuredEnv: Record<string, string> = {},
): VelaControlApiContext | null {
  const mergedEnv = mergeVelaEnv(env, configuredEnv);
  const profile = resolveAmrProfile(mergedEnv);
  const envControlKey = mergedEnv.VELA_CONTROL_KEY?.trim() ?? '';
  const envApiUrl = mergedEnv.VELA_API_URL?.trim() ?? '';
  if (envControlKey) {
    const status = readRawVelaLoginStatus(env, configuredEnv);
    return {
      profile,
      apiUrl: envApiUrl || 'https://amr-api.open-design.ai',
      controlKey: envControlKey,
      user: status.user,
      configMtimeMs: null,
    };
  }
  const snapshot = readVelaProfileConfigSnapshot(env, configuredEnv);
  const apiContext = readVelaApiContext(env, configuredEnv, snapshot);
  const stored = snapshot.stored;
  const controlKey = stored?.controlKey?.trim() ?? '';
  if (!controlKey) return null;
  return {
    ...apiContext,
    controlKey,
    user: stored?.user ?? null,
    configMtimeMs: snapshot.configMtimeMs,
  };
}

export function readVelaApiContext(
  env: NodeJS.ProcessEnv = process.env,
  configuredEnv: Record<string, string> = {},
  snapshot: VelaProfileConfigSnapshot = readVelaProfileConfigSnapshot(env, configuredEnv),
): VelaApiContext {
  const mergedEnv = mergeVelaEnv(env, configuredEnv);
  return {
    profile: snapshot.profile,
    apiUrl:
      snapshot.stored?.apiUrl?.trim()
      || mergedEnv.VELA_API_URL?.trim()
      || 'https://amr-api.open-design.ai',
  };
}

export function forgetVelaLogin(env: NodeJS.ProcessEnv = process.env): void {
  const file = amrConfigPath();
  if (!existsSync(file)) return;
  const parsed = readConfigFile();
  if (!parsed?.profiles) return;
  const profile = resolveAmrProfile(env);
  if (!Object.prototype.hasOwnProperty.call(parsed.profiles, profile)) return;
  const keptProfileConfig = { ...(parsed.profiles[profile] ?? {}) };
  delete keptProfileConfig.controlKey;
  delete keptProfileConfig.runtimeKey;
  delete keptProfileConfig.user;
  const nextProfiles = { ...parsed.profiles };
  nextProfiles[profile] = keptProfileConfig;
  writeFileSync(
    file,
    JSON.stringify({ ...parsed, profiles: nextProfiles }, null, 2),
    'utf8',
  );
}

export interface SpawnedVelaLogin {
  pid: number;
  startedAt: string;
  profile: string;
  authAttemptId: string;
}

const activeLoginProcs = new Map<number, ChildProcess>();
interface VelaLoginAttemptRef {
  authAttemptId: string;
  generation: number;
}

interface VelaLoginAttemptState extends VelaLoginAttemptRef {
  authRequestId?: string;
  canceled: boolean;
  fallbackPending: boolean;
  fallbackStarted: boolean;
  currentPid: number | null;
}

let loginGeneration = 0;
let latestLoginAttempt: VelaLoginAttemptState | null = null;
// Children registered for supervision until their `close`/`error` terminal
// handler runs. Distinct from `isVelaLoginInFlight()`: status can drop the
// public idle projection between `exit` and `close` once `exitCode` is set
// (especially after cancel, which suppresses the fallbackPending bridge).
let pendingVelaLoginTerminals = 0;
const LOGIN_STARTUP_GRACE_MS = 250;
const LOGIN_ACTIVATION_GRACE_MS = 10_000;
const LOGIN_CANCEL_KILL_GRACE_MS = 2000;

// How long the login request blocks waiting for the direct attempt's activation
// URL before returning and letting the UI poll /status. Overridable so tests can
// exercise the slow-direct path without a multi-second wait. Never used to kill
// the direct attempt — see waitForLoginActivationSteadyState.
function resolveLoginActivationGraceMs(baseEnv: NodeJS.ProcessEnv): number {
  const raw = Number(baseEnv.OD_AMR_LOGIN_ACTIVATION_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : LOGIN_ACTIVATION_GRACE_MS;
}
// Cap the captured buffers: the activation URL + code land in the first handful
// of stdout lines, so a few KB is plenty and bounds memory if vela stays chatty.
const LOGIN_CAPTURE_LIMIT_BYTES = 8192;

// Activation details captured from the in-flight `vela login` child. Reset on
// each spawn (one interactive login at a time); `readVelaLoginStatus` only
// surfaces it while a login is actually in flight.
let activeLoginActivation: VelaLoginActivation | null = null;

interface VelaLoginActivationCapture {
  activation: VelaLoginActivation;
  stdout: string;
  stderr: string;
}

function appendHumanVelaLoginStdout(
  capture: VelaLoginActivationCapture,
  chunk: string,
): void {
  if (capture.stdout.length >= LOGIN_CAPTURE_LIMIT_BYTES) return;
  capture.stdout += chunk.slice(
    0,
    LOGIN_CAPTURE_LIMIT_BYTES - capture.stdout.length,
  );
}

// Attach lifetime listeners that accumulate the child's stdout/stderr and keep
// re-parsing the activation URL/code/warning as output streams in. Unlike
// `waitForImmediateLoginFailure` (which only reads the first 250ms), this lives
// for the whole login so a slow CreateDeviceAuthorization round-trip — common on
// constrained networks, exactly where the browser handoff also tends to fail —
// still surfaces the URL once it finally prints.
function beginLoginActivationCapture(
  child: ChildProcess,
  attempt: VelaLoginAttemptRef,
): VelaLoginActivationCapture {
  const activation: VelaLoginActivation = {
    activationUrl: null,
    userCode: null,
    browserOpenFailed: false,
  };
  const capture: VelaLoginActivationCapture = {
    activation,
    stdout: '',
    stderr: '',
  };
  activeLoginActivation = activation;
  const ownsCapture = () =>
    currentVelaLoginAttempt(attempt)?.currentPid === child.pid;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    // Once a replacement proxy child owns the attempt, late data from the old
    // direct child must not be attributed to the proxy route. The pid remains
    // owned through normal `close`, so legitimate close-drain data still lands.
    if (!ownsCapture()) return;
    const text = String(chunk);
    appendHumanVelaLoginStdout(capture, text);
    const parsed = parseVelaLoginActivation(capture.stdout, capture.stderr);
    if (parsed.activationUrl) activation.activationUrl = parsed.activationUrl;
    if (parsed.userCode) activation.userCode = parsed.userCode;
  });
  child.stderr?.on('data', (chunk) => {
    if (!ownsCapture()) return;
    if (capture.stderr.length < LOGIN_CAPTURE_LIMIT_BYTES) {
      capture.stderr += String(chunk);
    }
    if (
      !activation.browserOpenFailed
      && parseVelaLoginActivation('', capture.stderr).browserOpenFailed
    ) {
      activation.browserOpenFailed = true;
    }
  });
  return capture;
}

function isChildRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function hasRunningVelaLoginChild(): boolean {
  for (const [pid, child] of activeLoginProcs) {
    if (isChildRunning(child)) return true;
    activeLoginProcs.delete(pid);
  }
  return false;
}

export function isVelaLoginInFlight(): boolean {
  return hasRunningVelaLoginChild()
    || Boolean(latestLoginAttempt?.fallbackPending && !latestLoginAttempt.canceled);
}

/**
 * True once every supervised login child has finished its `close`/`error`
 * terminal handler and no late proxy fallback is still pending.
 *
 * Stronger than `isVelaLoginInFlight()` for tests that must observe the
 * close-deferred late-fallback decision: the public idle projection can
 * flip true between `exit` and `close` when the attempt was canceled.
 */
export function isVelaLoginSupervisorSettled(): boolean {
  return pendingVelaLoginTerminals === 0
    && !Boolean(latestLoginAttempt?.fallbackPending && !latestLoginAttempt.canceled);
}

export interface CancelVelaLoginResult {
  canceled: boolean;
  pids: number[];
}

export function cancelVelaLogin(
  expectedAuthAttemptId?: string | null,
  expectedAuthRequestId?: string | null,
): CancelVelaLoginResult {
  if (
    expectedAuthAttemptId !== undefined
    && expectedAuthAttemptId !== null
    && latestLoginAttempt?.authAttemptId !== expectedAuthAttemptId
  ) {
    return { canceled: false, pids: [] };
  }
  if (
    expectedAuthRequestId !== undefined
    && expectedAuthRequestId !== null
    && latestLoginAttempt?.authRequestId !== expectedAuthRequestId
  ) {
    return { canceled: false, pids: [] };
  }
  const attemptWasActive = Boolean(
    latestLoginAttempt
      && !latestLoginAttempt.canceled
      && (latestLoginAttempt.fallbackPending || hasRunningVelaLoginChild()),
  );
  if (latestLoginAttempt) latestLoginAttempt.canceled = true;
  // Invalidate every callback/captured stage belonging to the canceled
  // attempt before signalling its child. A late direct exit can therefore
  // never start the proxy fallback after the user has canceled.
  loginGeneration += 1;
  const pids: number[] = [];
  for (const [pid, child] of activeLoginProcs) {
    if (!isChildRunning(child)) {
      activeLoginProcs.delete(pid);
      continue;
    }
    try {
      child.kill('SIGTERM');
    } catch {
      activeLoginProcs.delete(pid);
      continue;
    }
    pids.push(pid);
    const killTimer = setTimeout(() => {
      try {
        if (isChildRunning(child)) child.kill('SIGKILL');
      } catch {
        activeLoginProcs.delete(pid);
      }
    }, LOGIN_CANCEL_KILL_GRACE_MS);
    killTimer.unref?.();
  }
  return { canceled: attemptWasActive || pids.length > 0, pids };
}

export interface SpawnVelaLoginDeps {
  configuredEnv?: Record<string, string>;
  baseEnv?: NodeJS.ProcessEnv;
  correlationEnv?: Record<string, string>;
  defaultApiUrl?: string | null;
  // When set, block until the direct attempt reaches device-auth steady state
  // (prints its activation URL) or exits/errors before that, so the login route
  // can fall back to the IPv4 proxy on a real pre-activation failure rather than
  // only on a sub-250ms startup crash. See waitForLoginActivationSteadyState.
  waitForActivation?: boolean;
}

export interface SpawnVelaLoginWithFallbackDeps extends SpawnVelaLoginDeps {
  authAttemptId?: string | null;
  authRequestId?: string | null;
  proxyApiUrl: string;
}

export function parseVelaAuthAttemptId(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = (input as { authAttemptId?: unknown }).authAttemptId;
  return isCanonicalAmrAuthAttemptId(value) ? value : null;
}

export function parseVelaAuthRequestId(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = (input as { authRequestId?: unknown }).authRequestId;
  return typeof value === 'string'
    && /^pending-amr-auth-[a-z0-9]+-[a-z0-9]+$/.test(value)
    ? value
    : null;
}

function beginVelaLoginAttempt(
  authAttemptId?: string | null,
  authRequestId?: string | null,
): VelaLoginAttemptRef {
  if (isVelaLoginInFlight()) throw new Error('vela login already running');
  const attempt: VelaLoginAttemptState = {
    authAttemptId: isCanonicalAmrAuthAttemptId(authAttemptId)
      ? authAttemptId
      : randomUUID(),
    ...(authRequestId ? { authRequestId } : {}),
    generation: ++loginGeneration,
    canceled: false,
    fallbackPending: false,
    fallbackStarted: false,
    currentPid: null,
  };
  latestLoginAttempt = attempt;
  return attempt;
}

function currentVelaLoginAttempt(
  attempt: VelaLoginAttemptRef,
): VelaLoginAttemptState | null {
  const current = latestLoginAttempt;
  return current
    && current.authAttemptId === attempt.authAttemptId
    && current.generation === attempt.generation
    && loginGeneration === attempt.generation
    && !current.canceled
    ? current
    : null;
}

function readVelaLoginAttemptSnapshot(): VelaLoginAttemptSnapshot {
  const attempt = latestLoginAttempt;
  return attempt
    ? { authAttemptId: attempt.authAttemptId }
    : {};
}

type VelaLoginChildTerminal =
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'error'; error: Error };

async function waitForImmediateLoginFailure(
  capture: VelaLoginActivationCapture,
  terminal: Promise<VelaLoginChildTerminal>,
): Promise<void> {
  const result = await Promise.race<
    VelaLoginChildTerminal | { kind: 'running' }
  >([
    terminal,
    new Promise<{ kind: 'running' }>((resolve) => {
      const timer = setTimeout(
        () => resolve({ kind: 'running' }),
        LOGIN_STARTUP_GRACE_MS,
      );
      timer.unref?.();
    }),
  ]);

  if (result.kind === 'running') return;
  if (result.kind === 'error') {
    throw new Error(`vela login failed to start: ${result.error.message}`);
  }
  if (capture.activation.activationUrl) return;
  const detail = (capture.stderr || capture.stdout).trim();
  throw new Error(
    detail ||
      `vela login exited before authentication completed (code ${result.code ?? 'null'}, signal ${result.signal ?? 'null'})`,
  );
}

// Wait for the direct `vela login` attempt to either print its device-auth
// activation URL (healthy — the direct path works even on the transparent-proxy
// networks this fix targets, just possibly slowly) or exit/error BEFORE printing
// it (a real failure the caller can retry through the IPv4 proxy). Crucially, a
// merely slow-but-still-running direct login is NOT killed: once the grace
// elapses we simply stop blocking the request and let it keep running (the UI
// polls /status). Killing a slow-healthy direct login and re-routing it through
// the proxy is exactly the regression this avoids — on a corporate transparent
// proxy the proxy hop loses the client IP and the upstream 502s. Only an
// explicit pre-activation exit/error triggers the proxy fallback.
async function waitForLoginActivationSteadyState(
  capture: VelaLoginActivationCapture,
  graceMs: number,
  terminal: Promise<VelaLoginChildTerminal>,
): Promise<void> {
  if (capture.activation.activationUrl) return;

  const observed = new Promise<
    | { kind: 'activated' }
    | { kind: 'still-running' }
  >((resolve) => {
    let settled = false;
    let poll: NodeJS.Timeout | null = null;
    let timer: NodeJS.Timeout | null = null;
    const finish = (
      value:
        | { kind: 'activated' }
        | { kind: 'still-running' },
    ) => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    poll = setInterval(() => {
      if (capture.activation.activationUrl) finish({ kind: 'activated' });
    }, 50);
    timer = setTimeout(() => finish({ kind: 'still-running' }), graceMs);
    timer.unref?.();
    if (capture.activation.activationUrl) finish({ kind: 'activated' });
  });
  const result = await Promise.race([observed, terminal]);

  if (result.kind === 'activated') return;
  // `close` may win the Promise.race before the 50ms activation poll even
  // though its final drained stdout chunk already populated the capture.
  // Observed activation always owns this child; never launch a duplicate
  // device-auth attempt merely because the child exited immediately after it.
  if (capture.activation.activationUrl) return;
  // Slow but still alive: leave the direct attempt running and let the request
  // return — do NOT kill it or fall back to the proxy.
  if (result.kind === 'still-running') return;
  if (result.kind === 'error') {
    throw new Error(`vela login failed to start: ${result.error.message}`);
  }
  const detail = (capture.stderr || capture.stdout).trim();
  throw new Error(
    detail ||
      `vela login exited before device authorization started (code ${result.code ?? 'null'}, signal ${result.signal ?? 'null'})`,
  );
}

interface SpawnVelaLoginAttemptDeps extends SpawnVelaLoginDeps {
  attempt: VelaLoginAttemptRef;
  onLatePreActivationFailure?: () => Promise<void>;
}

async function spawnVelaLoginAttempt(
  deps: SpawnVelaLoginAttemptDeps,
): Promise<SpawnedVelaLogin> {
  const attemptState = currentVelaLoginAttempt(deps.attempt);
  if (!attemptState) throw new Error('vela login attempt is no longer active');
  if (hasRunningVelaLoginChild()) throw new Error('vela login already running');
  const def = getAgentDef('amr');
  if (!def) throw new Error('AMR runtime def not registered');
  const baseEnv = deps.baseEnv ?? process.env;
  const configuredEnv = withDefaultVelaApiUrl(
    deps.configuredEnv ?? {},
    baseEnv,
    deps.defaultApiUrl,
  );
  const launch = resolveAgentLaunch(def, configuredEnv);
  const bin = launch.selectedPath;
  if (!bin) throw new Error('vela binary not found; install vela or configure VELA_BIN');
  const env: NodeJS.ProcessEnv = {
    ...spawnEnvForAgent('amr', baseEnv, configuredEnv),
    ...(deps.correlationEnv ?? {}),
    // The UUID is daemon-owned and written after configured/base env so a
    // child cannot replace the correlation key selected for this attempt.
    OPEN_DESIGN_AMR_AUTH_ATTEMPT_ID: deps.attempt.authAttemptId,
  };
  // This fallback-only change does not opt the child into a structured stage
  // protocol that the packaged Vela CLI cannot emit.
  delete env.OPEN_DESIGN_AMR_AUTH_STAGE_FORMAT;
  // Route through createCommandInvocation so an npm/Node-style `vela.cmd` or
  // `vela.bat` shim on Windows gets wrapped under `cmd.exe /d /s /c …` with
  // verbatim args, matching what `execAgentFile` / chat-run spawning do. A
  // direct `spawn(bin, args)` on a `.cmd` shim quietly fails to find the
  // shim's actual entry point. POSIX is unchanged (no wrapping needed).
  const invocation = createCommandInvocation({ command: bin, args: ['login'], env });
  let child: ChildProcess;
  try {
    child = spawn(invocation.command, invocation.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      detached: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
  } catch (error) {
    throw error;
  }
  if (typeof child.pid !== 'number') throw new Error('failed to spawn vela login');
  activeLoginProcs.set(child.pid, child);
  pendingVelaLoginTerminals += 1;
  attemptState.currentPid = child.pid;
  let spawnReturned = false;
  let terminalHandled = false;
  let activationCapture: VelaLoginActivationCapture | null = null;
  let settleTerminal: (value: VelaLoginChildTerminal) => void = () => undefined;
  const terminal = new Promise<VelaLoginChildTerminal>((resolve) => {
    settleTerminal = resolve;
  });
  const handleTerminal = () => {
    if (terminalHandled) return;
    terminalHandled = true;
    pendingVelaLoginTerminals = Math.max(0, pendingVelaLoginTerminals - 1);
    if (typeof child.pid === 'number') activeLoginProcs.delete(child.pid);
    const current = currentVelaLoginAttempt(deps.attempt);
    if (!current || current.currentPid !== child.pid) return;
    current.currentPid = null;
    const terminatedBeforeActivation =
      !activationCapture?.activation.activationUrl;
    const shouldFallback = Boolean(
      terminatedBeforeActivation
        && spawnReturned
        && deps.onLatePreActivationFailure
        && !activeLoginActivation?.activationUrl
        && !current.fallbackStarted,
    );
    if (!shouldFallback) {
      current.fallbackPending = false;
      activeLoginActivation = null;
      return;
    }
    // Mark pending before starting the async retry so /status never exposes a
    // false idle window between the dead direct child and its proxy successor.
    current.fallbackStarted = true;
    current.fallbackPending = true;
    activeLoginActivation = null;
    void deps.onLatePreActivationFailure?.()
      .catch(() => undefined)
      .finally(() => {
        const stillCurrent = currentVelaLoginAttempt(deps.attempt);
        if (stillCurrent) stillCurrent.fallbackPending = false;
      });
  };
  child.once('exit', () => {
    const current = currentVelaLoginAttempt(deps.attempt);
    if (
      current
      && current.currentPid === child.pid
      && !activationCapture?.activation.activationUrl
    ) {
      // `exit` precedes stdio drain/`close` on Node. Keep status continuous but
      // defer the activation/fallback decision until `close`, after every
      // queued stdout chunk has reached the parser.
      current.fallbackPending = true;
    }
  });
  child.once('close', (code, signal) => {
    handleTerminal();
    settleTerminal({ kind: 'exit', code, signal });
  });
  child.once('error', (error) => {
    handleTerminal();
    settleTerminal({ kind: 'error', error });
  });
  // Capture the activation URL/code/warning for the whole login (not just the
  // 250ms startup race) so readVelaLoginStatus can surface them. Start before
  // the grace wait so no early stdout is missed.
  activationCapture = beginLoginActivationCapture(child, deps.attempt);
  await waitForImmediateLoginFailure(activationCapture, terminal);
  if (deps.waitForActivation) {
    await waitForLoginActivationSteadyState(
      activationCapture,
      resolveLoginActivationGraceMs(baseEnv),
      terminal,
    );
  }
  spawnReturned = true;
  // vela opens the browser itself (OpenBrowser in apps/cli/.../login.go), but it
  // also prints the activation URL + code to stdout first and warns on stderr if
  // the auto-open failed. We capture those above and expose them via
  // readVelaLoginStatus() so the UI can offer a manual link when the browser
  // never opened. Callers still poll readVelaLoginStatus() to detect completion.
  return {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    profile: resolveAmrProfile(env),
    authAttemptId: deps.attempt.authAttemptId,
  };
}

export async function spawnVelaLogin(
  deps: SpawnVelaLoginDeps = {},
): Promise<SpawnedVelaLogin> {
  const attempt = beginVelaLoginAttempt();
  return spawnVelaLoginAttempt({ ...deps, attempt });
}

export async function spawnVelaLoginWithFallback(
  deps: SpawnVelaLoginWithFallbackDeps,
): Promise<SpawnedVelaLogin> {
  const attempt = beginVelaLoginAttempt(deps.authAttemptId, deps.authRequestId);
  const sharedSpawnDeps: SpawnVelaLoginDeps = {
    ...(deps.configuredEnv ? { configuredEnv: deps.configuredEnv } : {}),
    ...(deps.baseEnv ? { baseEnv: deps.baseEnv } : {}),
    ...(deps.correlationEnv ? { correlationEnv: deps.correlationEnv } : {}),
    ...(deps.waitForActivation !== undefined
      ? { waitForActivation: deps.waitForActivation }
      : {}),
  };
  const spawnProxy = async (): Promise<SpawnedVelaLogin> => {
    const current = currentVelaLoginAttempt(attempt);
    if (!current) throw new Error('vela login attempt is no longer active');
    current.fallbackStarted = true;
    current.fallbackPending = true;
    try {
      return await spawnVelaLoginAttempt({
        ...sharedSpawnDeps,
        defaultApiUrl: deps.proxyApiUrl,
        attempt,
      });
    } finally {
      const stillCurrent = currentVelaLoginAttempt(attempt);
      if (stillCurrent) stillCurrent.fallbackPending = false;
    }
  };

  try {
    return await spawnVelaLoginAttempt({
      ...sharedSpawnDeps,
      attempt,
      onLatePreActivationFailure: async () => {
        await spawnProxy();
      },
    });
  } catch (directErr) {
    const directMessage = directErr instanceof Error
      ? directErr.message
      : String(directErr);
    if (/already running|no longer active/i.test(directMessage)) throw directErr;
    return spawnProxy();
  }
}

function withDefaultVelaApiUrl(
  configuredEnv: Record<string, string>,
  baseEnv: NodeJS.ProcessEnv,
  defaultApiUrl: string | null | undefined,
): Record<string, string> {
  const trimmed = defaultApiUrl?.trim();
  if (!trimmed) return configuredEnv;
  if ((configuredEnv.VELA_API_URL ?? '').trim()) return configuredEnv;
  if ((baseEnv.VELA_API_URL ?? '').trim()) return configuredEnv;
  return { ...configuredEnv, VELA_API_URL: trimmed };
}
