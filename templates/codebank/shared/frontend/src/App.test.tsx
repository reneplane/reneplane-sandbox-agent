import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

// Visible tests for the notes page. The API is replaced with fixed notes, so no backend is needed.

const NOTES = [
  { id: 2, title: 'Release checklist', body: 'Tag, then publish.', pinned: true, created_at: '2026-11-08T09:00:00Z' },
  { id: 6, title: 'Standup notes', body: 'Nothing blocking.', pinned: false, created_at: '2026-11-20T04:00:00Z' },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Notes page', () => {
  it('lists the notes in the order the API gives', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(NOTES), { headers: { 'Content-Type': 'application/json' } }));
    render(<App />);
    const titles = (await screen.findAllByRole('heading', { level: 2 })).map((heading) => heading.textContent);
    expect(titles).toEqual(['Release checklist Pinned', 'Standup notes ']);
  });

  it('offers Unpin on a pinned note and Pin on the others', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(NOTES), { headers: { 'Content-Type': 'application/json' } }));
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Unpin' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pin' })).toBeTruthy();
  });
});
