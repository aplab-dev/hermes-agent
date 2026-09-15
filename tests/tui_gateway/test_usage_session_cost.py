"""``_get_usage`` forwards the agent's accumulated session cost so the Desktop status bar can
show $ spend (CLI ``display.show_cost`` parity) without an extra RPC."""
from types import SimpleNamespace

from tui_gateway import server


def _agent(**overrides):
    base = dict(
        model="deepseek/deepseek-v4-flash-0731", session_input_tokens=100, session_output_tokens=10,
        session_prompt_tokens=100, session_completion_tokens=10, session_total_tokens=110, session_api_calls=1,
        session_reasoning_tokens=0, context_compressor=None,
        session_estimated_cost_usd=0.0, session_cost_status="unknown",
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def test_estimated_cost_is_forwarded_rounded():
    usage = server._get_usage(_agent(session_estimated_cost_usd=0.01234567, session_cost_status="estimated"))
    assert usage["cost_usd"] == 0.012346
    assert usage["cost_status"] == "estimated"


def test_included_route_reports_zero_with_status():
    usage = server._get_usage(_agent(session_estimated_cost_usd=0.0, session_cost_status="included"))
    assert usage["cost_usd"] == 0.0
    assert usage["cost_status"] == "included"


def test_unknown_pricing_omits_cost():
    usage = server._get_usage(_agent())
    assert "cost_usd" not in usage and "cost_status" not in usage
