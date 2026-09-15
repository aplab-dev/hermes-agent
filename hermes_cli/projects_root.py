"""``projects.root`` — one folder that holds a sub-folder per project.

Configured in config.yaml (``projects: {root: ~/Documents/Hermes}``). When set, a project created without an
explicit folder (Desktop "New project" with no folder picked, ``hermes project create NAME``) gets
``<root>/<slug>`` created for it, seeded with a ``.hermes.md`` stub the agent reads as project context.
Folder creation is deliberately confined to the root: the gateway never builds arbitrary trees.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

_HERMES_MD_STUB = """# {name}

<!-- Контекст проекта: Hermes читает этот файл при работе в папке (nearest .hermes.md / HERMES.md).
     Опиши, что тут лежит, где что искать, какие правила соблюдать. -->
"""


# Cyrillic → Latin (GOST-ish, ASCII only) so a Russian project name still yields a readable folder/slug
# instead of the generic "project" that a strip-to-[a-z0-9] slugify produces.
_TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo", "ж": "zh", "з": "z", "и": "i",
    "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t",
    "у": "u", "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch", "ъ": "", "ы": "y",
    "ь": "", "э": "e", "ю": "yu", "я": "ya", "і": "i", "ї": "yi", "є": "ye", "ґ": "g",
}


def slug_for_name(name: str) -> str:
    """Folder/slug candidate for a human project name: transliterate Cyrillic, then the same
    lowercase ``[a-z0-9-]`` rule as ``projects_db._slugify`` (``"Налоги 2026"`` → ``nalogi-2026``)."""
    from hermes_cli.projects_db import _slugify
    text = "".join(_TRANSLIT.get(ch, ch) for ch in str(name or "").lower())
    return _slugify(text)


def projects_root(cfg: Optional[dict] = None) -> Optional[Path]:
    """Absolute ``projects.root`` from config, or None when unset."""
    if cfg is None:
        try:
            from hermes_cli.config import load_config
            cfg = load_config() or {}
        except Exception:
            return None
    section = cfg.get("projects") if isinstance(cfg, dict) else None
    raw = section.get("root") if isinstance(section, dict) else None
    if not isinstance(raw, str) or not raw.strip():
        return None
    return Path(os.path.abspath(os.path.expanduser(raw.strip())))


def is_under_root(path: str, root: Optional[Path] = None) -> bool:
    """True when ``path`` is the root or a descendant of it (after symlink resolution)."""
    root = root if root is not None else projects_root()
    if root is None:
        return False
    try:
        real_root = root.resolve()
        real = Path(os.path.abspath(os.path.expanduser(path))).resolve()
    except OSError:
        return False
    return real == real_root or real_root in real.parents


def create_project_folder(slug: str, name: str = "", root: Optional[Path] = None) -> str:
    """Create ``<root>/<slug>`` (idempotent) and seed ``.hermes.md`` when absent. Returns the path.

    Raises ``ValueError`` when no root is configured or ``slug`` is not a plain single segment.
    """
    root = root if root is not None else projects_root()
    if root is None:
        raise ValueError("projects.root is not configured; pick a folder or set projects.root in config.yaml")
    slug = str(slug or "").strip()
    if not slug or slug in (".", "..") or "/" in slug or "\\" in slug or os.sep in slug:
        raise ValueError(f"invalid project folder name {slug!r}")
    root.mkdir(parents=True, exist_ok=True)
    folder = root / slug
    folder.mkdir(exist_ok=True)
    stub = folder / ".hermes.md"
    if not stub.exists() and not (folder / "HERMES.md").exists():
        stub.write_text(_HERMES_MD_STUB.format(name=name.strip() or slug), encoding="utf-8")
    return str(folder)
