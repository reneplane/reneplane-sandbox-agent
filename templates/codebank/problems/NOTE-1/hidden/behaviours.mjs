/**
 * NOTE-1 "Pinned notes don't stay on top": the hidden checks, the same for every stack.
 *
 * Black-box: each one calls the learner's running API or reads the database. They run in order on one
 * database, so each works out what's expected from what the API returns now, not from fixed ids.
 * Plain ESM with no imports: this file runs inside the grader's judge container.
 *
 * `t` is the judge's harness: get(path), post(path), db.query(sql), engine, check(ok, message), fail(message).
 */

const API = 'API contract';
const statusOf = (response) => (response.error ? response.error : `returned ${response.status}`);

async function notes(t) {
  const response = await t.get('/api/notes');
  t.check(response.status === 200, `GET /api/notes ${statusOf(response)}, expected 200`);
  t.check(Array.isArray(response.body), 'GET /api/notes should return a JSON array of notes');
  for (const note of response.body) {
    t.check(typeof note.pinned === 'boolean', `note ${note.id} has no boolean "pinned" field`);
    t.check(!Number.isNaN(Date.parse(note.created_at)), `note ${note.id} has no "created_at" time`);
  }
  return response.body;
}

/** Where the list breaks the rule (pinned first, newest first within each group), or null */
function firstOutOfOrder(list) {
  for (let index = 1; index < list.length; index += 1) {
    const before = list[index - 1];
    const note = list[index];
    if (!before.pinned && note.pinned) return `"${note.title}" is pinned but comes after "${before.title}", which isn't`;
    if (before.pinned === note.pinned && Date.parse(before.created_at) < Date.parse(note.created_at)) {
      return `"${note.title}" is newer than "${before.title}" but comes after it`;
    }
  }
  return null;
}

export const behaviours = [
  {
    id: 'pinned-first',
    category: API,
    layer: 'backend',
    name: 'Pinned notes come before every other note',
    async run(t) {
      const list = await notes(t);
      const lastPinned = list.map((note) => note.pinned).lastIndexOf(true);
      const firstUnpinned = list.findIndex((note) => !note.pinned);
      t.check(lastPinned === -1 || firstUnpinned === -1 || lastPinned < firstUnpinned, firstOutOfOrder(list) ?? 'a pinned note comes after an unpinned one');
    },
  },
  {
    id: 'newest-first',
    category: API,
    layer: 'backend',
    name: 'Within pinned and unpinned notes, the newest comes first',
    async run(t) {
      const problem = firstOutOfOrder(await notes(t));
      t.check(problem === null, problem);
    },
  },
  {
    id: 'pin-moves-up',
    category: API,
    layer: 'backend',
    name: 'Pinning an old note moves it into the pinned group at the top',
    async run(t) {
      const before = await notes(t);
      const oldest = before.filter((note) => !note.pinned).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
      t.check(oldest, 'there is no unpinned note to pin');
      const response = await t.post(`/api/notes/${oldest.id}/pin`);
      t.check(response.status === 200, `POST /api/notes/${oldest.id}/pin ${statusOf(response)}, expected 200`);
      const after = await notes(t);
      const pinned = after.filter((note) => note.pinned).length;
      const position = after.findIndex((note) => note.id === oldest.id);
      t.check(position !== -1 && position < pinned, `"${oldest.title}" was pinned but is number ${position + 1} of ${after.length}, below unpinned notes`);
      t.check(firstOutOfOrder(after) === null, firstOutOfOrder(after));
    },
  },
  {
    id: 'unpin-moves-down',
    category: API,
    layer: 'backend',
    name: 'Unpinning a note moves it among the others, by its date',
    async run(t) {
      const before = await notes(t);
      const pinnedNote = before.find((note) => note.pinned);
      t.check(pinnedNote, 'there is no pinned note to unpin');
      const response = await t.post(`/api/notes/${pinnedNote.id}/unpin`);
      t.check(response.status === 200, `POST /api/notes/${pinnedNote.id}/unpin ${statusOf(response)}, expected 200`);
      const after = await notes(t);
      t.check(after.find((note) => note.id === pinnedNote.id)?.pinned === false, `"${pinnedNote.title}" is still pinned after unpinning it`);
      t.check(firstOutOfOrder(after) === null, firstOutOfOrder(after));
    },
  },
  {
    id: 'pin-is-saved',
    category: 'Database',
    layer: 'database',
    name: 'Pinning is saved in the database',
    async run(t) {
      const note = (await notes(t)).find((candidate) => !candidate.pinned);
      t.check(note, 'there is no unpinned note to pin');
      await t.post(`/api/notes/${note.id}/pin`);
      const rows = await t.db.query(`SELECT pinned FROM notes WHERE id = ${Number(note.id)}`);
      t.check(rows.length === 1, `note ${note.id} isn't in the notes table`);
      t.check(rows[0].pinned === true || Number(rows[0].pinned) === 1, `note ${note.id} was pinned through the API but notes.pinned is ${rows[0].pinned}`);
    },
  },

  // Regression: what worked before still works
  {
    id: 'health',
    category: 'Regression',
    layer: 'backend',
    name: 'GET /api/health still answers',
    async run(t) {
      const response = await t.get('/api/health');
      t.check(response.status === 200, `GET /api/health ${statusOf(response)}, expected 200`);
    },
  },
  {
    id: 'unknown-note',
    category: 'Regression',
    layer: 'backend',
    name: 'Pinning a note that does not exist answers 404',
    async run(t) {
      const response = await t.post('/api/notes/987654/pin');
      t.check(response.status === 404, `POST /api/notes/987654/pin ${statusOf(response)}, expected 404`);
    },
  },
];
