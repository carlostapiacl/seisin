export type KeyMode = "env" | "run-file" | "inject";
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
  /** Folders only this role reads and writes; also part of `writes`. */
  private: string[];
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
  /** Refused as expected — the agent program's own housekeeping, not friction. */
  expected?: { kind: "plugins"; hint: string };
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

export function pendingRequests(file: string, options?: { includeSettled?: boolean; keyDirs?: string[] | null; readOnly?: boolean }): unknown[];
export function requestsPath(root: string): string;
export function grantFor(request: { action: string; target: string }, keyDir?: string | null): string;

/** Where a denied write goes, decided from the policy as it stands. Nothing executes it. */
export type HandoffType = "route" | "human" | "resolved" | "cycle" | "depth" | "throttled";
export interface HandoffDecision {
  type: HandoffType;
  /** The owners as the policy says now — for a key, the roles that declare it. */
  owners: string[];
  /** The role a route goes to; for cycle/depth/throttled, the one it would have gone to. */
  role?: string;
  /** For `human`: why a person decides. */
  reason?: "unowned" | "ambiguous" | "key" | "read";
  /** For `resolved`. */
  resolution?: "policy_changed";
  /** For a route: the receiver's depth in the handoff chain, and every role the chain has visited. */
  depth?: number;
  visited?: string[];
  max?: number;
  limit?: "senderChains" | "receiverConcurrent";
  /** The handoff chain this decision extends: the id of the request that started it. */
  chainId: string | null;
  /** Hash of the policy file the decision was made against. */
  revision: string | null;
}
export interface HandoffChain { id: string | null; depth: number; visited: string[] }
export interface QueuedRequest {
  key: string; role: string; action: "read" | "write"; target: string; grant: string;
  owners: string[]; ownersThen?: string[]; declared?: boolean;
  times: number; first: string; last: string; state: string;
  handoff: HandoffDecision;
  /** Present when the request was asked by a run started with `--handoff`. */
  chain?: HandoffChain;
  /** What whatever starts roles last recorded about it (recordHandoff). */
  attempt?: { outcome: string; role?: string; limit?: string; max?: number; reason?: string; depth?: number; chainId?: string; at: string };
  stale?: { runs: number; since: string };
}
export const MAX_DEPTH: number;
export function decideHandoff(input: {
  request: { role: string; target: string; action?: string; key?: string };
  config: SeisinConfig | { roles: Record<string, unknown> };
  chain?: Partial<HandoffChain> | null;
  limits?: { depth?: number; senderChains?: number; receiverConcurrent?: number };
  load?: { senderOpenChains?: number; receiverRunning?: number };
  revision?: string | null;
}): HandoffDecision;
export function requestQueue(config: SeisinConfig, history?: LogEntry[] | null): QueuedRequest[];
export function recordHandoff(file: string, key: string, decision: Partial<HandoffDecision> & { type: string }): boolean;

export function targetsOf(tool: string, input?: Record<string, unknown>): unknown[];
export function decide(config: SeisinConfig, role: string, event: Record<string, unknown>, options?: {
  observe?: boolean; now?: (...args: unknown[]) => unknown; ask?: (...args: unknown[]) => unknown;
}): Record<string, unknown>;
