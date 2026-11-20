import { useCallback, useEffect, useState } from 'react';
import { listNotes, pinNote, unpinNote, type Note } from './api';

/** The notes, as the API orders them, with Pin and Unpin */
export function App() {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    listNotes()
      .then(setNotes)
      .catch((reason: Error) => setError(reason.message));
  }, []);
  useEffect(load, [load]);

  const toggle = async (note: Note) => {
    try {
      await (note.pinned ? unpinNote(note.id) : pinNote(note.id));
      load();
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  return (
    <>
      <header className="site-header">
        <span className="logo">Notes</span>
      </header>
      <main>
        {error && <p role="alert">{error}</p>}
        {!notes ? (
          <p>Loading…</p>
        ) : (
          <ul className="notes">
            {notes.map((note) => (
              <li key={note.id} className={note.pinned ? 'note pinned' : 'note'}>
                <div>
                  <h2>
                    {note.title} {note.pinned && <span className="badge">Pinned</span>}
                  </h2>
                  <p>{note.body}</p>
                </div>
                <button onClick={() => void toggle(note)}>{note.pinned ? 'Unpin' : 'Pin'}</button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
