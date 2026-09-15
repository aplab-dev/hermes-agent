"""request_log plugin: one row per API call with the wire prompt, reply, usage, cost and prefix bookkeeping."""
from types import SimpleNamespace

import pytest

from plugins.observability.request_log import on_api_request_error, on_post_api_request, on_pre_api_request, store


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "db_path", lambda: tmp_path / "requests.db")
    store._initialized.clear()
    yield


def _pre(rid, call_no, messages, session="s1"):
    on_pre_api_request(session_id=session, turn_id="t1", api_request_id=rid, api_call_count=call_no,
                       model="deepseek/deepseek-v4-flash-0731", provider="openrouter", base_url="https://openrouter.ai/api/v1",
                       api_mode="chat_completions", request_messages=messages, started_at=100.0,
                       request={"method": "POST", "body": {"tools": [{"function": {"name": "read_file"}}], "temperature": 0.7}})


def test_request_then_response_row():
    msgs = [{"role": "system", "content": "SYS"}, {"role": "user", "content": "hi"}]
    _pre("r1", 1, msgs)
    am = SimpleNamespace(content="hello", reasoning_content="thinking…", tool_calls=[
        SimpleNamespace(id="c1", function=SimpleNamespace(name="read_file", arguments='{"path":"a"}'))])
    on_post_api_request(api_request_id="r1", model="deepseek/deepseek-v4-flash-0731", provider="openrouter",
                        base_url="https://openrouter.ai/api/v1", started_at=100.0, ended_at=101.5, first_chunk_at=100.4,
                        finish_reason="tool_calls", response_model="deepseek/deepseek-v4-flash-0731",
                        usage={"input_tokens": 200, "cache_read_tokens": 800, "output_tokens": 30, "reasoning_tokens": 10,
                               "prompt_tokens": 1000}, assistant_message=am)
    rows = store.list_requests("s1")
    assert len(rows) == 1
    r = rows[0]
    assert r["status"] == "ok" and r["call_no"] == 1 and r["cache_read_tokens"] == 800 and r["prompt_tokens"] == 1000
    assert r["tool_count"] == 1 and r["message_count"] == 2
    full = store.get_request(r["id"])
    assert full["request"]["messages"] == msgs
    assert full["request"]["tools"] == ["read_file"] and full["request"]["extra"] == {"temperature": 0.7}
    assert full["response"]["reasoning"] == "thinking…" and full["response"]["tool_calls"][0]["name"] == "read_file"


def test_prefix_bookkeeping_against_previous_call():
    base = [{"role": "system", "content": "SYS" * 100}, {"role": "user", "content": "hi"}]
    _pre("r1", 1, base)
    _pre("r2", 2, [*base, {"role": "assistant", "content": "ok"}, {"role": "user", "content": "more"}])
    r2 = store.list_requests("s1")[1]
    assert r2["prefix_shared_msgs"] == 2
    assert r2["prefix_shared_chars"] > 300
    # a changed system prompt shares nothing
    _pre("r3", 3, [{"role": "system", "content": "OTHER"}, *base[1:]])
    assert store.list_requests("s1")[2]["prefix_shared_msgs"] == 0


def test_error_row():
    _pre("r1", 1, [{"role": "user", "content": "hi"}])
    on_api_request_error(api_request_id="r1", error={"type": "RateLimitError", "message": "429"}, status_code=429, ended_at=101.0)
    r = store.list_requests("s1")[0]
    assert r["status"] == "error" and r["error"].startswith("HTTP 429")


def test_prune_by_age():
    _pre("old", 1, [{"role": "user", "content": "x"}])
    assert store.prune(max_age_days=1) == 1  # started_at=100.0 is far in the past
    assert store.list_requests("s1") == []
