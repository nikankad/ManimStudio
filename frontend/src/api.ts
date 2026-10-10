import type { Catalog, Job, RunResult, SceneDoc, Signature } from './types';

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

export const api = {
  catalog: (header: string) => post<Catalog>('/api/catalog', { header }),
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
  initialProject: () => get<{ doc: SceneDoc; path: string | null }>('/api/project/initial'),
  openProject: (path: string) => post<{ doc: SceneDoc; path: string }>('/api/project/open', { path }),
  saveProject: (path: string, doc: SceneDoc) => post<{ path: string }>('/api/project/save', { path, doc }),
  dialog: (kind: 'open' | 'save', filename = '', types: string[] = []) =>
    post<{ path: string | null; unsupported?: boolean }>('/api/dialog', { kind, filename, types }),
};

/** Native file dialog in the desktop window, a prompt in a plain browser. */
export async function askPath(kind: 'open' | 'save', filename: string, types: string[], promptText: string): Promise<string | null> {
  const res = await api.dialog(kind, filename, types);
  if (!res.unsupported) return res.path;
  return window.prompt(promptText, filename) || null;
}
