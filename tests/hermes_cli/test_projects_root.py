"""``projects.root``: folder-per-project creation confined to one configured root."""
import pytest

from hermes_cli import projects_root as pr


def test_projects_root_unset_returns_none():
    assert pr.projects_root({}) is None
    assert pr.projects_root({"projects": {"root": "  "}}) is None


def test_projects_root_expands_user(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    assert pr.projects_root({"projects": {"root": "~/Documents/Hermes"}}) == tmp_path / "Documents" / "Hermes"


def test_create_project_folder_seeds_hermes_md(tmp_path):
    root = tmp_path / "Hermes"
    path = pr.create_project_folder("taxes-2026", "Taxes 2026", root)
    assert path == str(root / "taxes-2026")
    stub = root / "taxes-2026" / ".hermes.md"
    assert stub.read_text(encoding="utf-8").startswith("# Taxes 2026")
    # idempotent: a second create keeps the user's edited stub
    stub.write_text("# edited", encoding="utf-8")
    assert pr.create_project_folder("taxes-2026", "Taxes 2026", root) == path
    assert stub.read_text(encoding="utf-8") == "# edited"


@pytest.mark.parametrize("bad", ["", ".", "..", "a/b", "a\\b"])
def test_create_project_folder_rejects_paths(tmp_path, bad):
    with pytest.raises(ValueError):
        pr.create_project_folder(bad, root=tmp_path)


def test_create_project_folder_without_root_raises(monkeypatch):
    monkeypatch.setattr(pr, "projects_root", lambda cfg=None: None)
    with pytest.raises(ValueError):
        pr.create_project_folder("x")


def test_is_under_root(tmp_path):
    root = tmp_path / "Hermes"
    root.mkdir()
    assert pr.is_under_root(str(root / "finances"), root)
    assert pr.is_under_root(str(root), root)
    assert not pr.is_under_root(str(tmp_path / "elsewhere"), root)
    assert not pr.is_under_root(str(root) + "-other", root)
