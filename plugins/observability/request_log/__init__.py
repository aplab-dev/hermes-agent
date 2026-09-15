"""Request log plugin: persist every LLM API call — the prompt exactly as sent, the reply (thinking,
text, tool calls), token buckets incl. prefix-cache reads, latency and cost — to ``HERMES_HOME/requests.db``.

Purely local (no network), opt-in through ``plugins.enabled``. The dashboard reads the table under
Sessions → LLM calls (``hermes_cli/web_routers/requests_log.py``). Config (``request_log:`` in config.yaml):
``max_age_days`` (default 30, 0 = keep forever) prunes old rows on first use per process.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Optional

from . import store

logger = logging.getLogger(__name__)

_pruned = False


def _config() -> dict:
    try:
        from hermes_cli.config import load_config
        cfg = (load_config() or {}).get("request_log")
        return cfg if isinstance(cfg, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _prune_once() -> None:
    global _pruned
    if _pruned:
        return
    _pruned = True
    try:
        days = int(_config().get("max_age_days", 30))
        removed = store.prune(days)
        if removed:
            logger.info("request_log: pruned %d rows older than %d days", removed, days)
    except Exception as exc:  # noqa: BLE001
        logger.debug("request_log prune skipped: %s", exc)


def _tool_names(request: Any) -> list:
    body = request.get("body") if isinstance(request, dict) else None
    tools = body.get("tools") if isinstance(body, dict) else None
    names = []
    for t in tools or []:
        if isinstance(t, dict):
            fn = t.get("function") if isinstance(t.get("function"), dict) else t
            name = fn.get("name") if isinstance(fn, dict) else None
            if name:
                names.append(name)
    return names


def _request_extra(request: Any) -> dict:
    body = request.get("body") if isinstance(request, dict) else None
    if not isinstance(body, dict):
        return {}
    return {k: v for k, v in body.items() if k not in ("messages", "input", "tools", "model")}


def on_pre_api_request(*, session_id: str = "", turn_id: str = "", api_request_id: str = "", api_call_count: int = 0,
                       model: str = "", provider: str = "", base_url: str = "", api_mode: str = "",
                       request_messages: Any = None, started_at: Optional[float] = None, request: Any = None,
                       system_prompt: Any = None, **_: Any) -> None:
    if not api_request_id:
        return
    _prune_once()
    try:
        messages = list(request_messages) if isinstance(request_messages, list) else []
        # Anthropic / Responses transports carry the system prompt outside ``messages``; keep the canvas whole.
        if system_prompt and not any(isinstance(m, dict) and m.get("role") in ("system", "developer") for m in messages):
            messages = [{"role": "system", "content": system_prompt}, *messages]
        store.record_request(
            api_request_id=api_request_id, session_id=session_id or "", turn_id=turn_id or "", call_no=int(api_call_count or 0),
            started_at=float(started_at or time.time()), model=model or "", provider=provider or "", base_url=base_url or "",
            api_mode=api_mode or "", messages=messages, tools=_tool_names(request), extra=_request_extra(request),
        )
    except Exception as exc:  # noqa: BLE001 — logging must never break a turn
        logger.debug("request_log pre_api_request failed: %s", exc)


def _reasoning_text(assistant_message: Any) -> str:
    for attr in ("reasoning_content", "reasoning"):
        value = getattr(assistant_message, attr, None)
        if isinstance(value, str) and value.strip():
            return value
    extra = getattr(assistant_message, "model_extra", None)
    if isinstance(extra, dict):
        for key in ("reasoning_content", "reasoning"):
            if isinstance(extra.get(key), str) and extra[key].strip():
                return extra[key]
    return ""


def _tool_calls(assistant_message: Any) -> list:
    out = []
    for tc in getattr(assistant_message, "tool_calls", None) or []:
        fn = getattr(tc, "function", None)
        if fn is None and isinstance(tc, dict):
            fn = tc.get("function")
        name = getattr(fn, "name", None) if fn is not None and not isinstance(fn, dict) else (fn or {}).get("name")
        args = getattr(fn, "arguments", None) if fn is not None and not isinstance(fn, dict) else (fn or {}).get("arguments")
        out.append({"id": getattr(tc, "id", None) if not isinstance(tc, dict) else tc.get("id"), "name": name, "arguments": args})
    return out


def _estimate_cost(model: str, provider: str, base_url: str, usage: Optional[dict]) -> tuple[Optional[float], str]:
    if not usage:
        return None, "unknown"
    try:
        from agent.usage_pricing import CanonicalUsage, estimate_usage_cost
        cu = CanonicalUsage(
            input_tokens=int(usage.get("input_tokens") or 0), output_tokens=int(usage.get("output_tokens") or 0),
            cache_read_tokens=int(usage.get("cache_read_tokens") or 0), cache_write_tokens=int(usage.get("cache_write_tokens") or 0),
            reasoning_tokens=int(usage.get("reasoning_tokens") or 0),
        )
        result = estimate_usage_cost(model, cu, provider=provider, base_url=base_url)
        amount = result.amount_usd
        return (float(amount) if amount is not None else None), str(result.status)
    except Exception as exc:  # noqa: BLE001
        logger.debug("request_log cost estimate failed: %s", exc)
        return None, "unknown"


def on_post_api_request(*, api_request_id: str = "", model: str = "", provider: str = "", base_url: str = "",
                        started_at: Optional[float] = None, ended_at: Optional[float] = None,
                        first_chunk_at: Optional[float] = None, finish_reason: Optional[str] = None,
                        response_model: Optional[str] = None, usage: Optional[dict] = None,
                        assistant_message: Any = None, **_: Any) -> None:
    if not api_request_id:
        return
    try:
        content = getattr(assistant_message, "content", None)
        response = {
            "content": content if isinstance(content, (str, list)) else (str(content) if content is not None else None),
            "reasoning": _reasoning_text(assistant_message),
            "tool_calls": _tool_calls(assistant_message),
        }
        cost, status = _estimate_cost(response_model or model, provider, base_url, usage)
        store.record_response(
            api_request_id=api_request_id, ended_at=float(ended_at or time.time()), first_chunk_at=first_chunk_at,
            finish_reason=finish_reason, usage=usage, cost_usd=cost, cost_status=status, response=response,
            response_model=response_model,
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("request_log post_api_request failed: %s", exc)


def on_api_request_error(*, api_request_id: str = "", error: Any = None, status_code: Any = None, reason: Any = None,
                         ended_at: Optional[float] = None, **_: Any) -> None:
    if not api_request_id:
        return
    try:
        if isinstance(error, dict):
            text = f"{error.get('type') or 'error'}: {error.get('message') or ''}".strip()
        else:
            text = str(error or reason or "error")
        if status_code:
            text = f"HTTP {status_code} — {text}"
        store.record_error(api_request_id=api_request_id, ended_at=float(ended_at or time.time()), error=text)
    except Exception as exc:  # noqa: BLE001
        logger.debug("request_log api_request_error failed: %s", exc)


def register(ctx) -> None:
    for name, fn in (("pre_api_request", on_pre_api_request), ("post_api_request", on_post_api_request),
                     ("api_request_error", on_api_request_error)):
        ctx.register_hook(name, fn)
