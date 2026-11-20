from sqlalchemy import text

from app.db import connection
from app.errors import NotFoundError

COLUMNS = "id, title, body, pinned, created_at"


def list_notes() -> list[dict]:
    """Pinned notes first, then the newest"""
    with connection() as conn:
        rows = conn.execute(text(f"SELECT {COLUMNS} FROM notes ORDER BY pinned DESC, created_at DESC, id DESC"))
        return [dict(row) for row in rows.mappings()]


def set_pinned(note_id: int, pinned: bool) -> dict:
    with connection() as conn:
        note = (
            conn.execute(text(f"UPDATE notes SET pinned = :pinned WHERE id = :id RETURNING {COLUMNS}"), {"id": note_id, "pinned": pinned})
            .mappings()
            .first()
        )
        if note is None:
            raise NotFoundError(f"Note {note_id} not found")
        return dict(note)
