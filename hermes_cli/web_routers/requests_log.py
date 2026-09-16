"""Dashboard routes for the request_log plugin (``HERMES_HOME/requests.db``): every LLM API call of a session
with the exact wire prompt, reply, token buckets (incl. prefix-cache reads), latency and cost."""
from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, HTTPException

from hermes_cli.web_deps import late

router = APIRouter()

_profile_scope = late("_profile_scope", "hermes_cli.web_server_profiles")


def _store():
    from plugins.observability.request_log import store
    return store


def _resolve_session_ids(session_id: str) -> list[str]:
    """Ids the log may be keyed by for what the caller calls ``session_id``. The Desktop addresses a chat by
    its UI session id; the plugin keys rows by ``agent.session_id`` (which compaction rotates) — so also try
    the live gateway session's agent id and stored key, plus rotation ancestors of the stored key."""
    ids = [session_id]
    try:
        from tui_gateway import server as gateway
        live = gateway._sessions.get(session_id)
        if live:
            agent = live.get("agent")
            for cand in (getattr(agent, "session_id", None), live.get("session_key")):
                if cand and cand not in ids:
                    ids.append(str(cand))
    except Exception:  # noqa: BLE001 — no in-process gateway (plain dashboard): fall back to the id as given
        pass
    return ids


@router.get("/api/requests/{session_id}")
async def list_session_requests(session_id: str, profile: Optional[str] = None, full: int = 0):
    """Rows for the calls list + per-session totals; ``full=1`` includes parsed request/response bodies
    (the board view lays every call out at once)."""
    def _run():
        with _profile_scope(profile):
            store = _store()
            for sid in _resolve_session_ids(session_id):
                rows = store.list_requests_full(sid) if full else store.list_requests(sid)
                if rows:
                    return {"requests": rows, "stats": store.session_stats(sid), "session_id": sid}
            return {"requests": [], "stats": {}, "session_id": session_id}
    return await asyncio.to_thread(_run)


@router.get("/api/requests/{session_id}/{row_id}")
async def get_session_request(session_id: str, row_id: int, profile: Optional[str] = None):
    """One call in full: request (messages as sent, tool names, extra kwargs) and response."""
    def _run():
        with _profile_scope(profile):
            row = _store().get_request(row_id)
            if row is None or row.get("session_id") not in _resolve_session_ids(session_id):
                raise HTTPException(status_code=404, detail="request not found")
            return row
    return await asyncio.to_thread(_run)


@router.post("/api/requests/have")
async def sessions_with_requests(body: dict, profile: Optional[str] = None):
    """``{session_ids: [...]}`` → ``{session_ids: [...]}`` subset that has logged calls (Sessions list badge)."""
    ids = [str(s) for s in (body.get("session_ids") or []) if s][:500]
    def _run():
        with _profile_scope(profile):
            return {"session_ids": sorted(_store().sessions_with_requests(ids))}
    return await asyncio.to_thread(_run)
