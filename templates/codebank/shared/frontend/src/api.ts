/** The Notes API. Throws with the server's error message on a non-2xx response. */

export interface Note {
  id: number;
  title: string;
  body: string;
  pinned: boolean;
  created_at: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body as T;
}

/** Pinned notes first, then the newest: the order is the server's */
export const listNotes = () => api<Note[]>('/api/notes');
export const pinNote = (id: number) => api<Note>(`/api/notes/${id}/pin`, { method: 'POST' });
export const unpinNote = (id: number) => api<Note>(`/api/notes/${id}/unpin`, { method: 'POST' });
