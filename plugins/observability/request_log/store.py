"""SQLite store for the request log (``HERMES_HOME/requests.db``).

One row per API call. ``request_json`` is the message list exactly as sent (plus tool names and the
non-message kwargs); ``response_json`` is what came back (content, reasoning, tool_calls). Prefix-cache
bookkeeping: ``prefix_shared_msgs`` / ``prefix_shared_chars`` compare this request with the previous one
of the same session (how much of the prompt was byte-identical → cacheable), next to
``cache_read_tokens`` (what the provider actually served from cache).
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Optional

_SCHEMA = """
CREATE TABLE IF NOT EXISTS api_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_request_id TEXT UNIQUE,
    session_id TEXT NOT NULL,
    turn_id TEXT,
    call_no INTEGER,
    started_at REAL,
    ended_at REAL,
    first_chunk_at REAL,
    model TEXT,
    provider TEXT,
    base_url TEXT,
    api_mode TEXT,
    finish_reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    prompt_tokens INTEGER,
    input_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    output_tokens INTEGER,
    reasoning_tokens INTEGER,
    cost_usd REAL,
    cost_status TEXT,
    request_chars INTEGER,
    message_count INTEGER,
    tool_count INTEGER,
    prefix_shared_msgs INTEGER,
    prefix_shared_chars INTEGER,
    request_json TEXT,
    response_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_requests_session ON api_requests(session_id, started_at);
"""

_lock = threading.Lock()
_initialized: set[str] = set()


def db_path() -> Path:
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home()) / "requests.db"


def connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=5)
    conn.row_factory = sqlite3.Row
    key = str(path)
    if key not in _initialized:
        with _lock:
            if key not in _initialized:
                conn.executescript(_SCHEMA)
                conn.commit()
                _initialized.add(key)
    return conn


def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def _message_chars(messages: list) -> int:
    return sum(len(_dumps(m)) for m in messages)


def _shared_prefix(prev: list, cur: list) -> tuple[int, int]:
    """(messages, chars) of the leading run of byte-identical messages between two request bodies —
    the part a prefix cache can serve. Serialized per message so key order/whitespace can't fake a diff."""
    n = chars = 0
    for a, b in zip(prev, cur):
        sa, sb = _dumps(a), _dumps(b)
        if sa != sb:
            break
        n += 1
        chars += len(sa)
    return n, chars


def record_request(*, api_request_id: str, session_id: str, turn_id: str, call_no: int, started_at: float,
                   model: str, provider: str, base_url: str, api_mode: str, messages: list, tools: list,
                   extra: dict) -> Optional[int]:
    """Insert the pending row for one API call. Returns the row id (None on failure)."""
    request = {"messages": messages, "tools": tools, "extra": extra}
    with connect() as conn:
        prev = conn.execute(
            "SELECT request_json FROM api_requests WHERE session_id = ? ORDER BY id DESC LIMIT 1", (session_id,)
        ).fetchone()
        shared_msgs = shared_chars = 0
        if prev and prev["request_json"]:
            try:
                shared_msgs, shared_chars = _shared_prefix(json.loads(prev["request_json"]).get("messages") or [], messages)
            except Exception:  # noqa: BLE001 — bookkeeping only
                pass
        cur = conn.execute(
            "INSERT OR REPLACE INTO api_requests (api_request_id, session_id, turn_id, call_no, started_at, model, provider, "
            "base_url, api_mode, status, request_chars, message_count, tool_count, prefix_shared_msgs, prefix_shared_chars, "
            "request_json) VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?)",
            (api_request_id, session_id, turn_id, call_no, started_at, model, provider, base_url, api_mode,
             _message_chars(messages), len(messages), len(tools), shared_msgs, shared_chars, _dumps(request)),
        )
        conn.commit()
        return cur.lastrowid


def record_response(*, api_request_id: str, ended_at: float, first_chunk_at: Optional[float], finish_reason: Optional[str],
                    usage: Optional[dict], cost_usd: Optional[float], cost_status: str, response: dict,
                    response_model: Optional[str]) -> None:
    u = usage or {}
    with connect() as conn:
        conn.execute(
            "UPDATE api_requests SET status='ok', ended_at=?, first_chunk_at=?, finish_reason=?, prompt_tokens=?, input_tokens=?, "
            "cache_read_tokens=?, cache_write_tokens=?, output_tokens=?, reasoning_tokens=?, cost_usd=?, cost_status=?, "
            "response_json=?, model=COALESCE(?, model) WHERE api_request_id=?",
            (ended_at, first_chunk_at, finish_reason, u.get("prompt_tokens"), u.get("input_tokens"), u.get("cache_read_tokens"),
             u.get("cache_write_tokens"), u.get("output_tokens"), u.get("reasoning_tokens"), cost_usd, cost_status,
             _dumps(response), response_model, api_request_id),
        )
        conn.commit()


def record_error(*, api_request_id: str, ended_at: float, error: str) -> None:
    with connect() as conn:
        conn.execute("UPDATE api_requests SET status='error', ended_at=?, error=? WHERE api_request_id=?",
                     (ended_at, error[:2000], api_request_id))
        conn.commit()


_LIST_COLUMNS = ("id", "api_request_id", "session_id", "turn_id", "call_no", "started_at", "ended_at", "first_chunk_at",
                 "model", "provider", "api_mode", "finish_reason", "status", "error", "prompt_tokens", "input_tokens",
                 "cache_read_tokens", "cache_write_tokens", "output_tokens", "reasoning_tokens", "cost_usd", "cost_status",
                 "request_chars", "message_count", "tool_count", "prefix_shared_msgs", "prefix_shared_chars")


def list_requests(session_id: str, limit: int = 500) -> list[dict]:
    if not db_path().exists():
        return []
    with connect() as conn:
        rows = conn.execute(
            f"SELECT {', '.join(_LIST_COLUMNS)} FROM api_requests WHERE session_id = ? ORDER BY id ASC LIMIT ?",
            (session_id, limit)).fetchall()
    return [dict(r) for r in rows]


def list_requests_full(session_id: str, limit: int = 200) -> list[dict]:
    """Every call of the session WITH parsed request/response bodies (the board view lays them all out)."""
    if not db_path().exists():
        return []
    with connect() as conn:
        rows = conn.execute("SELECT * FROM api_requests WHERE session_id = ? ORDER BY id ASC LIMIT ?",
                            (session_id, limit)).fetchall()
    out = []
    for row in rows:
        d = dict(row)
        for key in ("request_json", "response_json"):
            raw = d.pop(key)
            try:
                d[key[:-5]] = json.loads(raw) if raw else None
            except Exception:  # noqa: BLE001
                d[key[:-5]] = None
        out.append(d)
    return out


def get_request(row_id: int) -> Optional[dict]:
    if not db_path().exists():
        return None
    with connect() as conn:
        row = conn.execute("SELECT * FROM api_requests WHERE id = ?", (row_id,)).fetchone()
    if row is None:
        return None
    out = dict(row)
    for key in ("request_json", "response_json"):
        raw = out.pop(key)
        try:
            out[key[:-5]] = json.loads(raw) if raw else None
        except Exception:  # noqa: BLE001
            out[key[:-5]] = None
    return out


def session_stats(session_id: str) -> dict:
    with connect() as conn:
        row = conn.execute(
            "SELECT count(*) n, sum(prompt_tokens) prompt, sum(cache_read_tokens) cached, sum(output_tokens) out, "
            "sum(reasoning_tokens) reasoning, sum(cost_usd) cost, sum(ended_at - started_at) secs FROM api_requests "
            "WHERE session_id = ? AND status = 'ok'", (session_id,)).fetchone()
    return dict(row) if row else {}


def prune(max_age_days: int) -> int:
    if max_age_days <= 0 or not db_path().exists():
        return 0
    cutoff = time.time() - max_age_days * 86400
    with connect() as conn:
        cur = conn.execute("DELETE FROM api_requests WHERE started_at < ?", (cutoff,))
        conn.commit()
        return cur.rowcount


def sessions_with_requests(session_ids: list[str]) -> set[str]:
    """Subset of *session_ids* that have at least one logged call (dashboard shows the button only for those)."""
    if not session_ids or not db_path().exists():
        return set()
    with connect() as conn:
        marks = ",".join("?" * len(session_ids))
        rows = conn.execute(f"SELECT DISTINCT session_id FROM api_requests WHERE session_id IN ({marks})", session_ids).fetchall()
    return {r[0] for r in rows}

