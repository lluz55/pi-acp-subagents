import type { Run } from './run.mjs';
export const sectionNames: string[];
export interface CardOptions { expanded?: boolean; sections?: Set<string>; live?: boolean }
export interface Theme { fg(color: any, text: string): string }
export function formatTokens(num?: number): string;
export function lastAction(run: Run): string;
export function modelDisplay(run: Run): string;
export function compactLine(run: Run): string;
export function runSummary(run: Run): string;
export function cardRows(run: Run, options?: CardOptions): { text: string; color: string }[];
export function cardComponent(runs: Run[], options: CardOptions, theme: Theme | undefined, truncate: (text: string, width: number) => string): { render(width: number): string[]; invalidate(): void };
export function notificationText(run: Run, event: string, attention?: string): string;
