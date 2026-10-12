"""Show a file in the system's file manager, or open it with the default app (for a finished export)."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def command(path: Path, reveal: bool, platform: str | None = None) -> list[str] | None:
    """The command that shows ``path`` in the file manager (``reveal``) or opens it, or None where it's done in-process."""
    platform = platform or sys.platform
    if platform == "darwin":
        return ["open", "-R", str(path)] if reveal else ["open", str(path)]
    if platform.startswith("win"):
        return ["explorer", f"/select,{path}"] if reveal else None  # None: os.startfile
    return ["xdg-open", str(path.parent if reveal else path)]  # Linux file managers can't all select a file


def open_path(path: Path, reveal: bool = False) -> bool:
    """Do it; False when the file is gone or nothing could be launched."""
    if not path.is_file():
        return False
    cmd = command(path, reveal)
    try:
        if cmd is None:
            os.startfile(str(path))  # type: ignore[attr-defined]  # Windows only
        else:
            subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, AttributeError):
        return False
    return True
