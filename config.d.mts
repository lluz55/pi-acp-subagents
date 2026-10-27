export interface Agent {
  harness: string;
  description?: string;
  instructions?: string;
  model?: string;
  mode?: string;
  config?: Record<string, string | boolean>;
  cwd?: string;
  timeoutSeconds?: number;
  permissions?: 'ask' | 'allow' | 'deny';
}
export interface Harness { command: string; args: string[]; env?: Record<string, string> }
export interface Config { harnesses: Record<string, Harness>; agents: Record<string, Agent> }
export type ResolvedAgent = Agent & Harness & { name: string };
export const extensionDir: string;
export const agentDir: string;
export const configPath: string;
export const runsDir: string;
export const defaults: Config;
export function loadConfig(path?: string): Promise<Config>;
export function resolveAgent(config: Config, name: string): ResolvedAgent;

