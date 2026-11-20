import { db } from '../db';
import { NotFoundError } from '../errors';

export interface Note {
  id: number;
  title: string;
  body: string;
  pinned: boolean;
  created_at: string;
}

/** Pinned notes first, then the newest */
export async function listNotes(): Promise<Note[]> {
  const { rows } = await db.query(`SELECT id, title, body, pinned, created_at FROM notes ORDER BY pinned DESC, created_at DESC, id DESC`);
  return rows;
}

export async function setPinned(noteId: number, pinned: boolean): Promise<Note> {
  const { rows } = await db.query(`UPDATE notes SET pinned = $2 WHERE id = $1 RETURNING id, title, body, pinned, created_at`, [noteId, pinned]);
  if (!rows[0]) throw new NotFoundError(`Note ${noteId} not found`);
  return rows[0];
}
