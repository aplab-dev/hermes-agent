"""Per-turn spend: ``message.complete`` carries ``turn_usage`` (the session-counter delta over the
turn) and the delta is persisted on the turn's final assistant row (display_metadata.turn_usage)."""
from types import SimpleNamespace

from tui_gateway import server


def _agent(**kw):
    base = dict(session_input_tokens=0, session_output_tokens=0, session_cache_read_tokens=0,
                session_reasoning_tokens=0, session_api_calls=0, session_estimated_cost_usd=0.0,
                session_cost_status="estimated")
    base.update(kw)
    return SimpleNamespace(**base)


def test_turn_usage_delta_is_the_difference_over_the_turn():
    agent = _agent(session_input_tokens=1000, session_cache_read_tokens=4000, session_output_tokens=200,
                   session_api_calls=3, session_estimated_cost_usd=0.010)
    before = server._usage_counters(agent)
    agent.session_input_tokens += 500
    agent.session_cache_read_tokens += 2000
    agent.session_output_tokens += 120
    agent.session_api_calls += 2
    agent.session_estimated_cost_usd += 0.0019
    delta = server._turn_usage_delta(before, agent)
    assert delta["calls"] == 2 and delta["input"] == 500 and delta["cache_read"] == 2000 and delta["output"] == 120
    assert delta["cost_usd"] == 0.0019
    assert delta["cache_hit_pct"] == 80
    assert delta["cost_status"] == "estimated"


def test_turn_without_api_calls_has_no_usage():
    agent = _agent(session_api_calls=5)
    assert server._turn_usage_delta(server._usage_counters(agent), agent) is None


def test_persist_writes_display_metadata(tmp_path):
    from hermes_state import SessionDB
    db = SessionDB(tmp_path / "state.db")
    db.create_session("s1", source="cli")
    db.append_message("s1", "user", "hi")
    db.append_message("s1", "assistant", "hello")
    row_id = db.latest_message_row_id("s1", role="assistant", require_text=False)
    agent = SimpleNamespace(_session_db=db, session_id="s1")
    server._persist_turn_usage({"session_key": "s1"}, agent, {"calls": 1, "input": 10, "cache_read": 0, "output": 5,
                                                              "reasoning": 0, "cost_usd": 0.0001})
    meta = db._decode_display_metadata(db._read_one("SELECT display_metadata FROM messages WHERE id = ?", (row_id,))[0])
    assert meta["turn_usage"]["cost_usd"] == 0.0001 and meta["turn_usage"]["calls"] == 1
    db.close()
