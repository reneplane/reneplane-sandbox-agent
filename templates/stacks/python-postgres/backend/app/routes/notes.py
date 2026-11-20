from fastapi import APIRouter

from app.services.notes import list_notes, set_pinned

router = APIRouter()


@router.get("/notes")
def notes():
    return list_notes()


@router.post("/notes/{note_id}/pin")
def pin(note_id: int):
    return set_pinned(note_id, True)


@router.post("/notes/{note_id}/unpin")
def unpin(note_id: int):
    return set_pinned(note_id, False)
