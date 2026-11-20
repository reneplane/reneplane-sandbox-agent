import { Router } from 'express';
import { listNotes, setPinned } from '../services/notes.service';

export const notesRouter = Router();

notesRouter.get('/notes', async (_req, res) => {
  res.json(await listNotes());
});

notesRouter.post('/notes/:id/pin', async (req, res) => {
  res.json(await setPinned(Number(req.params.id), true));
});

notesRouter.post('/notes/:id/unpin', async (req, res) => {
  res.json(await setPinned(Number(req.params.id), false));
});
