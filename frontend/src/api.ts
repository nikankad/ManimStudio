import type { Catalog, Job, RunResult, SceneDoc, Signature, Template } from './types';

export interface FunctionAnalysis {
  ok: boolean;
  error: string | null;
  hint: string;
  notes: string[];
  params: string[];
  undefined: string[];
  python: string;
  normalized: string;
  discontinuities: number[];
  gap: number | null;
  undefined_intervals: [number, number][];
  y_extent: [number, number] | null;
}

export interface ValueCheck {
  ok: boolean;
  error?: string;
  hint?: string;
  params?: string[];
  literal?: number | null;
}

export interface EquationCheck {
  ok: boolean;
  glyphs: number[];
  error: string | null;
}

const token = document.querySelector<HTMLMetaElement>('meta[name="me-token"]')?.content ?? '';

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MathEngine-Token': token },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as T;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { 'X-MathEngine-Token': token } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as T;
}

export interface AppInfo {
  version: string;
  channel: 'stable' | 'nightly' | 'dev';
  commit: string;
  repository: string;
  releases: string;
}
export interface UpdateInfo extends AppInfo {
  available: boolean;
  latest?: string;
  url?: string;
}

export interface RecentProject {
  path: string;
  name: string;
  folder: string;
  opened: number | null; // seconds since the epoch
  modified: number | null;
  size: number | null; // bytes
  exists: boolean;
  thumbnail: string | null; // data URL
}
export interface Sample {
  id: string;
  name: string;
  description: string;
  duration: number;
  thumbnail: string | null;
}

export const api = {
  version: () => get<AppInfo>('/api/version'),
  updateCheck: () => post<UpdateInfo>('/api/update_check', {}),
  openRelease: (url: string) => post<{ ok: boolean }>('/api/open_release', { url }),
  catalog: (header: string) => post<Catalog>('/api/catalog', { header }),
  tex: () => post<{ latex: boolean; dir: string | null; hint: string }>('/api/tex', {}),
  signature: (expr: string, header: string, object_classes: Record<string, string>) =>
    post<Signature>('/api/signature', { expr, header, object_classes }),
  run: (doc: SceneDoc, t: number | null, render: boolean, width = 960) =>
    post<RunResult>('/api/run', { doc, t, render, width }),
  code: (doc: SceneDoc) => post<{ code: string }>('/api/code', { doc }),
  exportCode: (doc: SceneDoc, path: string) => post<{ path: string }>('/api/export_code', { doc, path }),
  render: (doc: SceneDoc, quality: string, output?: string) => post<Job>('/api/render', { doc, quality, output }),
  job: (id: string) => get<Job>(`/api/render/${id}`),
  cancelJob: (id: string) => get<Job>(`/api/render/${id}/cancel`),
  mediaUrl: (id: string) => `/media/${id}.mp4?token=${encodeURIComponent(token)}`,
  initialProject: () => get<{ doc: SceneDoc; path: string | null; home: boolean }>('/api/project/initial'),
  openProject: (path: string) => post<{ doc: SceneDoc; path: string }>('/api/project/open', { path }),
  saveProject: (path: string, doc: SceneDoc) => post<{ path: string }>('/api/project/save', { path, doc }),
  home: () => get<{ recent: RecentProject[]; samples: Sample[] }>('/api/home'),
  removeRecent: (path: string) => post<{ recent: RecentProject[] }>('/api/recent/remove', { path }),
  openSample: (id: string) => post<{ doc: SceneDoc; path: null }>('/api/samples/open', { id }),
  analyzeFunction: (expr: string, params: Record<string, number>, domain: [number, number], y_range?: [number, number]) =>
    post<FunctionAnalysis>('/api/expr', { expr, params, domain, y_range }),
  checkValue: (expr: string, params: string[]) => post<ValueCheck>('/api/expr', { mode: 'value', expr, params }),
  checkEquation: (parts: string[], ctor: string) => post<EquationCheck>('/api/check_equation', { parts, ctor }),
  constructions: () => get<{ starters: Template[]; library: Template[]; path: string }>('/api/constructions'),
  saveLibrary: (library: Template[]) => post<{ path: string }>('/api/constructions', { library }),
  dialog: (kind: 'open' | 'save', filename = '', types: string[] = []) =>
    post<{ path: string | null; unsupported?: boolean }>('/api/dialog', { kind, filename, types }),
};

/** Native file dialog in the desktop window, a prompt in a plain browser. */
export async function askPath(kind: 'open' | 'save', filename: string, types: string[], promptText: string): Promise<string | null> {
  const res = await api.dialog(kind, filename, types);
  if (!res.unsupported) return res.path;
  return window.prompt(promptText, filename) || null;
}
