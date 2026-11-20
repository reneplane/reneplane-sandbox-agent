import express, { type ErrorRequestHandler } from 'express';
import { HttpError } from './errors';
import { notesRouter } from './routes/notes.routes';

export const app = express();
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});
app.use('/api', notesRouter);

const errors: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(`[backend] ${req.method} ${req.path} failed`, error);
  res.status(500).json({ error: 'Something went wrong' });
};
app.use(errors);

if (process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT ?? 8000);
  app.listen(port, '127.0.0.1', () => console.log(`[backend] listening on :${port}`));
}
