import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app, resetDatabase } from './helpers';

// Visible tests: the learner can run them. Each test starts from a fresh, seeded database.

beforeEach(resetDatabase);

describe('GET /api/notes', () => {
  it('returns every note', async () => {
    const response = await request(app).get('/api/notes');
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(6);
  });

  it('puts pinned notes first', async () => {
    const response = await request(app).get('/api/notes');
    const pinned = response.body.map((note: { pinned: boolean }) => note.pinned);
    expect(pinned).toEqual([true, true, false, false, false, false]);
  });

  it('lists the newest first within pinned and unpinned notes', async () => {
    const response = await request(app).get('/api/notes');
    expect(response.body.map((note: { id: number }) => note.id)).toEqual([5, 2, 6, 4, 3, 1]);
  });
});

describe('POST /api/notes/:id/pin', () => {
  it('moves a note to the top', async () => {
    expect((await request(app).post('/api/notes/1/pin')).status).toBe(200);
    const response = await request(app).get('/api/notes');
    expect(response.body.slice(0, 3).map((note: { id: number }) => note.id)).toEqual([5, 2, 1]);
  });

  it('answers 404 for a note that does not exist', async () => {
    expect((await request(app).post('/api/notes/999/pin')).status).toBe(404);
  });
});
