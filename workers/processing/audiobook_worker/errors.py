from __future__ import annotations


class WorkerError(Exception):
    """Error with a stable code the orchestrator maps to a user-facing message."""

    def __init__(self, code: str, message: str, details: dict | None = None, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}
        self.retryable = retryable

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message, "details": self.details, "retryable": self.retryable}
