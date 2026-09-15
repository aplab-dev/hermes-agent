"""``projects.create`` with ``create_folder`` mints ``<projects.root>/<slug>`` and reports the root."""
from __future__ import annotations

from pathlib import Path

import pytest

from hermes_constants import reset_hermes_home_override, set_hermes_home_override
import tui_gateway.server as server


@pytest.fixture
def projects_env(tmp_path, monkeypatch):
    root = tmp_path / "Hermes"
    from tui_gateway import methods_projects  # noqa: F401  (registered on import of server)
    monkeypatch.setattr("hermes_cli.projects_root.projects_root", lambda cfg=None: root)
    home = tmp_path / "home"
    home.mkdir()
    token = set_hermes_home_override(home)
    try:
        yield root
    finally:
        reset_hermes_home_override(token)


def _call(method, params):
    resp = server._methods[method](1, params)
    assert "error" not in resp, resp.get("error")
    return resp["result"]


def test_create_folder_mints_root_slug(projects_env: Path):
    proj = _call("projects.create", {"name": "Taxes 2026", "create_folder": True, "use": True})["project"]
    assert proj["primary_path"] == str(projects_env / "taxes-2026")
    assert (projects_env / "taxes-2026" / ".hermes.md").exists()


def test_create_folder_under_root_creates_missing_dir(projects_env: Path):
    target = str(projects_env / "letters")
    proj = _call("projects.create", {"name": "Letters", "folders": [target], "create_folder": True})["project"]
    assert proj["primary_path"] == target
    assert (projects_env / "letters").is_dir()


def test_create_folder_outside_root_does_not_mkdir(projects_env: Path, tmp_path: Path):
    target = str(tmp_path / "outside" / "x")
    proj = _call("projects.create", {"name": "Outside", "folders": [target], "create_folder": True})["project"]
    assert proj["primary_path"] == target  # registered as before
    assert not (tmp_path / "outside").exists()  # but never built


def test_without_create_folder_nothing_is_built(projects_env: Path):
    proj = _call("projects.create", {"name": "Plain", "folders": [str(projects_env / "plain")]})["project"]
    assert proj["primary_path"] == str(projects_env / "plain")
    assert not (projects_env / "plain").exists()


def test_list_reports_root(projects_env: Path):
    assert _call("projects.list", {})["root"] == str(projects_env)


def test_cyrillic_name_gets_transliterated_slug_and_folder(projects_env: Path):
    proj = _call("projects.create", {"name": "Налоги 2026", "create_folder": True})["project"]
    assert proj["slug"] == "nalogi-2026"
    assert proj["primary_path"] == str(projects_env / "nalogi-2026")
