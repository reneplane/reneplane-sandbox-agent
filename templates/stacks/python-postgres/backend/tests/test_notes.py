"""Visible tests: the learner can run them. Each test starts from a fresh, seeded database."""


def test_returns_every_note(client):
    response = client.get("/api/notes")
    assert response.status_code == 200
    assert len(response.json()) == 6


def test_puts_pinned_notes_first(client):
    pinned = [note["pinned"] for note in client.get("/api/notes").json()]
    assert pinned == [True, True, False, False, False, False]


def test_lists_the_newest_first_within_pinned_and_unpinned_notes(client):
    assert [note["id"] for note in client.get("/api/notes").json()] == [5, 2, 6, 4, 3, 1]


def test_pinning_moves_a_note_to_the_top(client):
    assert client.post("/api/notes/1/pin").status_code == 200
    assert [note["id"] for note in client.get("/api/notes").json()][:3] == [5, 2, 1]


def test_pinning_a_missing_note_answers_404(client):
    assert client.post("/api/notes/999/pin").status_code == 404
