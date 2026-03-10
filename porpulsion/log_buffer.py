"""
In-memory log buffer for exposing recent application logs via API/UI.

Uses a custom logging.Handler that appends to a thread-safe bounded deque.
"""
import logging
import threading
from collections import deque
from typing import Optional


_LOG_FORMAT = "%(asctime)s [%(name)s] %(levelname)s %(message)s"
_formatter = logging.Formatter(_LOG_FORMAT)

_buffer: Optional[deque] = None
_lock = threading.Lock()
_handler: Optional["LogBufferHandler"] = None


class LogBufferHandler(logging.Handler):
    """Appends log records to a bounded, thread-safe deque as structured dicts."""

    def __init__(self, buffer: deque, capacity: int):
        super().__init__()
        self._buffer = buffer
        self._capacity = capacity

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = self.format(record)
            entry = {
                "ts": record.created,
                "name": record.name,
                "level": record.levelname,
                "message": msg,
            }
            with _lock:
                self._buffer.append(entry)
        except Exception:
            self.handleError(record)


def install_log_handler(capacity: int = 1000) -> None:
    """Create the buffer and handler, attach to root logger."""
    global _buffer, _handler
    with _lock:
        if _handler is not None:
            return
        _buffer = deque(maxlen=capacity)
        _handler = LogBufferHandler(_buffer, capacity)
        _handler.setFormatter(_formatter)
    logging.getLogger().addHandler(_handler)


def get_recent_logs(limit: int = 200) -> list[dict]:
    """Return the last `limit` log entries (each with ts, name, level, message)."""
    with _lock:
        if _buffer is None:
            return []
        # deque doesn't support slicing; take last limit by iterating
        size = len(_buffer)
        n = min(limit, size)
        if n == 0:
            return []
        return list(_buffer)[-n:]
