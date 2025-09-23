from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


def normalize_name(name: str) -> str:
    return os.path.basename(str(name or "").strip())


def must_be_allowed(name: str, allowed: set[str], kind: str) -> None:
    if name not in allowed:
        raise ValueError(f"{kind} '{name}' not in allowed list")


def ensure_extension(name: str, fallback: str = ".safetensors") -> str:
    candidate = Path(normalize_name(name))
    suffix = candidate.suffix or fallback
    stem = candidate.stem or Path(normalize_name(name)).stem or "model"
    return f"{stem}{suffix}"


def derive_pretty_name(
    display_name: Optional[str],
    fallback_name: str,
    default_suffix: str = ".safetensors",
) -> str:
    preferred = normalize_name(display_name) if display_name else ""
    base = preferred or normalize_name(fallback_name)
    if not base:
        base = "model"
    return ensure_extension(base, default_suffix)


def build_collision_suffix(source: str, length: int = 6) -> str:
    digest = hashlib.sha1(source.encode("utf-8")).hexdigest()
    return digest[:length]


@dataclass
class ResolvedSymlink:
    target: Path
    link: Path
    created: bool
