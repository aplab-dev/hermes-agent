"""``model_catalog.allowlist`` — per-provider shortlist applied at the shared payload layer."""
from hermes_cli import inventory


def _rows():
    return [
        {"slug": "openrouter", "name": "OpenRouter", "models": ["a/one", "b/two", "c/three"], "total_models": 3},
        {"slug": "local-vllm", "name": "local-vllm", "models": ["local"], "total_models": 1},
    ]


def test_shortlist_replaces_models_in_given_order():
    rows = _rows()
    inventory._apply_model_allowlist(rows, {"OpenRouter": ["c/three", "a/one", "c/three", " new/model "]})
    assert rows[0]["models"] == ["c/three", "a/one", "new/model"]
    assert rows[0]["total_models"] == 3
    assert rows[1]["models"] == ["local"]  # providers not listed are untouched


def test_empty_or_malformed_allowlist_is_noop():
    for bad in (None, {}, {"openrouter": []}, {"openrouter": 42}, "openrouter"):
        rows = _rows()
        inventory._apply_model_allowlist(rows, bad)
        assert rows == _rows()


def test_string_value_is_a_single_id():
    rows = _rows()
    inventory._apply_model_allowlist(rows, {"openrouter": "b/two"})
    assert rows[0]["models"] == ["b/two"]


def test_picker_context_reads_model_catalog_allowlist(monkeypatch):
    from hermes_cli import config as cfg_mod
    monkeypatch.setattr(cfg_mod, "load_config", lambda: {
        "model": {"provider": "openrouter", "default": "a/one"},
        "model_catalog": {"excluded_providers": ["anthropic"], "allowlist": {"openrouter": ["a/one"]}},
    })
    ctx = inventory.load_picker_context()
    assert ctx.excluded_providers == ["anthropic"]
    assert ctx.model_allowlist == {"openrouter": ["a/one"]}
