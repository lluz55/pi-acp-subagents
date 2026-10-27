import type { ResolvedAgent } from './config.mjs';
export interface LoopAnalysis {
  isStuck: boolean;
  confidence: 'low' | 'medium' | 'high';
  pattern?: string;
  message: string;
  remainingSeconds: number;
  repeatedCount?: number;
}
export interface Run {
  id: string;
  agent: string;
  harness: string;
  task: string;
  cwd: string;
  model?: string;
  stages?: { id: string; status: string; startedAt?: number; finishedAt?: number }[];
  stderr?: string;
  status: 'starting' | 'running' | 'permission' | 'completed' | 'cancelled' | 'timed_out' | 'failed';
  startedAt: number;
  finishedAt?: number;
  text: string;
  thought: string;
  tools: Record<string, unknown>;
  plan: unknown[];
  usage?: unknown;
  error?: string;
  notice?: string;
  attention?: string;
  previewTruncated?: boolean;
  logPath?: string;
  sessionId?: string;
  stopReason?: string;
  timeoutSeconds?: number;
  deadline?: number;
  toolHistory?: { toolCallId: string; title: string; status: string; at: number; output?: string }[];
  extendTimeout?: (seconds: number) => { timeoutSeconds: number; remainingSeconds: number };
  setTimeoutSeconds?: (seconds: number) => { timeoutSeconds: number; remainingSeconds: number };
}
export interface PermissionRequest {
  sessionId: string;
  toolCall: { toolCallId: string; title?: string };
  options: { optionId: string; name: string; kind: string }[];
}
export function clean(text: unknown): string;
export function detectLoop(run: Run): LoopAnalysis;
export function newRun(agent: ResolvedAgent, task: string, cwd: string, timeoutSeconds?: number): Run;
export function executeRun(run: Run, agent: ResolvedAgent, options?: {
  signal?: AbortSignal;
  onChange?: (run: Run) => void;
  requestPermission?: (run: Run, params: PermissionRequest, signal: AbortSignal) => Promise<string | undefined>;
  onTimeoutWarning?: (run: Run, remainingSeconds: number) => void;
  logDir?: string;
}): Promise<Run>;
export function runText(run: Run, options?: { expanded?: boolean }): string;
export function applyUpdate(run: Run, update: Record<string, unknown>): void;
