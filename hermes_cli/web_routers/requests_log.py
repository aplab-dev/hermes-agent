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


@router.get("/api/requests/{session_id}")
async def list_session_requests(session_id: str, profile: Optional[str] = None):
    """Light rows (no bodies) for the calls list + per-session totals."""
    def _run():
        with _profile_scope(profile):
            store = _store()
            rows = store.list_requests(session_id)
            return {"requests": rows, "stats": store.session_stats(session_id) if rows else {}}
    return await asyncio.to_thread(_run)


@router.get("/api/requests/{session_id}/{row_id}")
async def get_session_request(session_id: str, row_id: int, profile: Optional[str] = None):
    """One call in full: request (messages as sent, tool names, extra kwargs) and response."""
    def _run():
        with _profile_scope(profile):
            row = _store().get_request(row_id)
            if row is None or row.get("session_id") != session_id:
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
