export type KeyMode = "env" | "scratch" | "inject";
export type ReadMode = "all" | "territory";
export type Isolation = false | "credentials" | "home";
export type Action = "read" | "write" | "mcp";

export interface KeyEntry {
  kind: "file" | "ref";
  raw: string;
  scheme?: string;
  ref?: string;
  name?: string;
}

export interface RolePolicy {
  name: string;
  writes: string[];
  writesDeclared: string[];
  keys: string[];
  keyEntries: KeyEntry[];
  keyMode: KeyMode | null;
  env: string[];
  network: string[] | null;
  neverWrites: string[];
  neverWritesDeclared: string[];
  reads: string[];
  toolchain: string[];
  verify: string[] | null;
  localBinding: boolean;
  localPorts: number[];
  mcp: string[] | null;
  trustd: boolean;
  controlFiles: string[];
  [key: string]: unknown;
}

export interface KeyProvider {
  name: string;
  command: string[];
  mode: KeyMode | null;
}

export interface SeisinConfig {
  root: string;
  path: string;
  keyDirs: string[];
  keyProviders: Record<string, KeyProvider>;
  allowedDomains: string[];
  runtimeWrites?: string[];
  isolate: Isolation;
  read: ReadMode;
  redact: boolean | undefined;
  scanIgnore: string[];
  protect: Record<string, unknown>;
  roles: Record<string, RolePolicy>;
  [key: string]: unknown;
}

export interface Decision {
  allowed: boolean;
  owners: string[];
  reason: string;
  [key: string]: unknown;
}

export interface SandboxSettings {
  network: {
    allowedDomains?: string[];
    deniedDomains: string[];
    allowUnixSockets: string[];
    allowLocalBinding: boolean;
  };
  filesystem: {
    denyRead: string[];
    allowRead: string[];
    allowWrite: string[];
    denyWrite: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface Wall {
  action: string;
  target: string;
  times: number;
  reason: string;
  owners: string[];
  firstAt: string;
  lastAt: string;
}

export interface ScanHit {
  file: string;
  line?: number;
  shape: string;
  level: "certain" | "review" | "named";
}

export interface ScanResult {
  hits: ScanHit[];
  skipped: Record<string, number>;
  nestedPaths: string[];
  truncated: boolean;
  omitted: number;
}

export const CONFIG_NAME: "seisin.toml";
export const STATE_DIR: ".seisin";
export const LOG_NAME: "log.jsonl";

export function findConfig(from?: string): string | null;
export function loadConfig(path: string, text?: string): SeisinConfig;
export function parseToml(text: string): Record<string, unknown>;

export function covers(pattern: string, path: string): boolean;
export function ownersOf(config: SeisinConfig, path: string): string[];
export function keyHolders(config: SeisinConfig, key: string): string[];
export function explain(config: SeisinConfig, role: string, action: Action, target: string, cwd?: string): Decision;
export function explainFileRead(config: SeisinConfig, role: string, path: string, credentialHomes?: string[]): Decision;
export function readTarget(config: SeisinConfig, target: string, cwd?: string): { key: boolean; target: string };

export function settingsFor(config: SeisinConfig, role: string, spool?: string | null, observe?: boolean,
  options?: { agent?: string; program?: string }): SandboxSettings;

export function parseKey(entry: string): KeyEntry;
export function defaultName(ref: string): string;
export function entriesOf(role: Pick<RolePolicy, "keys" | "keyEntries">): KeyEntry[];
export const MODES: readonly KeyMode[];

export function walls(config: SeisinConfig, role: string, options: {
  file: string; entries?: Record<string, unknown>[] | null; min?: number; since?: string | null;
  limit?: number; fresh?: boolean; ask?: typeof explain;
}): Wall[];
export function wasted(walls: Wall[]): number;

export function inspect(config: SeisinConfig, role?: string | null, where?: string): Record<string, unknown>;
export function sharedPaths(config: SeisinConfig, roles?: RolePolicy[]): string[];
export function scan(root: string, protectedDirs?: string[], ignore?: string[], limit?: number,
  options?: { roots?: string[] | null }): ScanResult;

export interface LogEntry {
  role?: string;
  action?: string;
  target?: string;
  verdict?: string;
  at?: string;
  [key: string]: unknown;
}
export function readLog(file: string, options?: {
  role?: string; verdict?: string; since?: string; limit?: number;
}): LogEntry[];
export function logPath(root: string): string;
export function observed(entries: LogEntry[]): Map<string, { writes: Set<string>; keys: Set<string> }>;
export function generalise(paths: string[]): string[];

export function pendingRequests(file: string, options?: { includeSettled?: boolean; keyDirs?: string[] | null }): unknown[];
export function requestsPath(root: string): string;
export function grantFor(request: { action: string; target: string }, keyDir?: string | null): string;

export function targetsOf(tool: string, input?: Record<string, unknown>): unknown[];
export function decide(config: SeisinConfig, role: string, event: Record<string, unknown>, options?: {
  observe?: boolean; now?: (...args: unknown[]) => unknown; ask?: (...args: unknown[]) => unknown;
}): Record<string, unknown>;
