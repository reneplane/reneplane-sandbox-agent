"""Errors a service can raise. The handlers in main.py turn them into HTTP responses."""


class HttpError(Exception):
    status = 500

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class NotFoundError(HttpError):
    status = 404
