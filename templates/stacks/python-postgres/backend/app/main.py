import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.errors import HttpError
from app.routes import notes

log = logging.getLogger("notes")

app = FastAPI(title="Notes")


@app.get("/api/health")
def health():
    return {"ok": True}


app.include_router(notes.router, prefix="/api")


@app.exception_handler(HttpError)
async def http_error(_request: Request, error: HttpError):
    return JSONResponse(status_code=error.status, content={"error": error.message})


@app.exception_handler(Exception)
async def unexpected(request: Request, error: Exception):
    log.exception("%s %s failed", request.method, request.url.path, exc_info=error)
    return JSONResponse(status_code=500, content={"error": "Something went wrong"})
