/** Tabs of the project page; `?tab=` selects one. */
export type ProjectTab = 'overview' | 'listen' | 'publish' | 'settings';
export const PROJECT_TABS: readonly ProjectTab[] = ['overview', 'listen', 'publish', 'settings'];

export function parseTabParam(v: string | string[] | undefined): ProjectTab | undefined {
  return typeof v === 'string' && (PROJECT_TABS as readonly string[]).includes(v) ? (v as ProjectTab) : undefined;
}
