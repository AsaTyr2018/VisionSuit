#!/usr/bin/env python3
"""Migrate LoRA assets from MyLora into VisionSuit via their public APIs."""

from __future__ import annotations

import argparse
import io
import logging
import mimetypes
import sys
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Iterable, List, Optional
from urllib.parse import quote, urljoin

try:
    import requests
except ImportError as exc:  # pragma: no cover - dependency guard
    print("The migrate_mylora_to_visionsuit.py script requires the 'requests' package.\n"
          "Install it with 'pip install requests' and try again.", file=sys.stderr)
    raise

DEFAULT_TIMEOUT = 30
MAX_PREVIEW_FILES = 99  # VisionSuit accepts at most 100 files per request (1 model + 99 previews).


class PreviewExtractor(HTMLParser):
    """Collect preview image URLs from MyLora detail pages."""

    def __init__(self) -> None:
        super().__init__()
        self.urls: List[str] = []

    def handle_starttag(self, tag: str, attrs: List[tuple[str, Optional[str]]]) -> None:
        if tag.lower() != "img":
            return
        attr_map = {key.lower(): value for key, value in attrs}
        src = attr_map.get("src")
        if not src:
            return
        if "/uploads/" in src and src not in self.urls:
            self.urls.append(src)


@dataclass
class MyLoraEntry:
    filename: str
    name: str
    tags: List[str]
    base_model: Optional[str]
    categories: List[str]
    preview_urls: List[str]

    @property
    def stem(self) -> str:
        return self.filename.rsplit(".", 1)[0]


class MyLoraClient:
    def __init__(self, base_url: str, username: str, password: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.username = username
        self.password = password
        self.session = requests.Session()

    def login(self) -> None:
        login_url = urljoin(self.base_url + "/", "login")
        logging.info("Authenticating with MyLora at %s", login_url)
        response = self.session.post(
            login_url,
            data={"username": self.username, "password": self.password, "save_account": "on"},
            headers={"Accept": "text/html,application/json"},
            timeout=DEFAULT_TIMEOUT,
            allow_redirects=True,
        )
        if response.status_code not in (200, 303):
            raise RuntimeError(f"MyLora login failed with status {response.status_code}: {response.text[:200]}")
        # Validate session by requesting a protected endpoint.
        categories_url = urljoin(self.base_url + "/", "categories")
        check = self.session.get(categories_url, headers={"Accept": "application/json"}, timeout=DEFAULT_TIMEOUT)
        if check.status_code != 200:
            raise RuntimeError(
                f"MyLora session validation failed with status {check.status_code}: {check.text[:200]}"
            )
        logging.info("MyLora authentication succeeded (%d categories detected).", len(check.json()))

    def fetch_entries(self, batch_size: int = 100) -> Iterable[MyLoraEntry]:
        offset = 0
        while True:
            params = {"q": "*", "limit": batch_size, "offset": offset}
            grid_url = urljoin(self.base_url + "/", "grid_data")
            response = self.session.get(grid_url, params=params, headers={"Accept": "application/json"}, timeout=DEFAULT_TIMEOUT)
            if response.status_code != 200:
                raise RuntimeError(
                    f"Failed to fetch MyLora grid data (status {response.status_code}): {response.text[:200]}"
                )
            payload = response.json()
            if not isinstance(payload, list):
                raise RuntimeError("Unexpected MyLora grid_data payload: expected a list")
            if not payload:
                break
            logging.info("Fetched %d entries from MyLora (offset=%d).", len(payload), offset)
            for entry in payload:
                filename = entry.get("filename")
                name = entry.get("name") or (filename.rsplit(".", 1)[0] if isinstance(filename, str) else None)
                if not filename or not name:
                    logging.warning("Skipping entry without filename or name: %s", entry)
                    continue
                tags_raw = entry.get("tags") or ""
                tags = [tag.strip() for tag in tags_raw.split(",") if tag and tag.strip()]
                categories = entry.get("categories") or []
                if not isinstance(categories, list):
                    categories = []
                preview_urls = []
                if entry.get("preview_url"):
                    preview_urls.append(entry["preview_url"])
                detail_previews = self._fetch_previews_for(filename)
                for url in detail_previews:
                    if url not in preview_urls:
                        preview_urls.append(url)
                yield MyLoraEntry(
                    filename=filename,
                    name=name,
                    tags=tags,
                    base_model=entry.get("base_model"),
                    categories=[str(cat) for cat in categories],
                    preview_urls=preview_urls,
                )
            if len(payload) < batch_size:
                break
            offset += batch_size

    def _fetch_previews_for(self, filename: str) -> List[str]:
        detail_url = urljoin(self.base_url + "/", f"detail/{quote(filename)}")
        response = self.session.get(detail_url, headers={"Accept": "text/html"}, timeout=DEFAULT_TIMEOUT)
        if response.status_code != 200:
            logging.debug("Skipping preview scrape for %s (status %d).", filename, response.status_code)
            return []
        parser = PreviewExtractor()
        parser.feed(response.text)
        parser.close()
        return parser.urls

    def download_file(self, relative_path: str) -> tuple[str, bytes]:
        url = urljoin(self.base_url + "/", relative_path.lstrip("/"))
        response = self.session.get(url, timeout=DEFAULT_TIMEOUT)
        if response.status_code != 200:
            raise RuntimeError(f"Failed to download {relative_path} (status {response.status_code}).")
        filename = relative_path.rsplit("/", 1)[-1]
        return filename, response.content


class VisionSuitClient:
    def __init__(self, base_url: str, email: str, password: str, visibility: str = "private") -> None:
        self.base_url = base_url.rstrip("/")
        self.email = email
        self.password = password
        self.visibility = visibility
        self.session = requests.Session()
        self.token: Optional[str] = None

    def login(self) -> None:
        login_url = urljoin(self.base_url + "/", "auth/login")
        logging.info("Authenticating with VisionSuit at %s", login_url)
        response = self.session.post(
            login_url,
            json={"email": self.email, "password": self.password},
            timeout=DEFAULT_TIMEOUT,
        )
        if response.status_code != 200:
            raise RuntimeError(f"VisionSuit login failed with status {response.status_code}: {response.text[:200]}")
        payload = response.json()
        token = payload.get("token")
        if not token:
            raise RuntimeError("VisionSuit login response did not include a token.")
        self.token = token
        self.session.headers["Authorization"] = f"Bearer {token}"
        logging.info("VisionSuit authentication succeeded (role: %s).", payload.get("user", {}).get("role"))

    def fetch_existing_models(self) -> dict[str, dict[str, dict]]:
        models_url = urljoin(self.base_url + "/", "assets/models")
        response = self.session.get(models_url, timeout=DEFAULT_TIMEOUT)
        if response.status_code != 200:
            raise RuntimeError(
                f"Failed to retrieve existing VisionSuit models (status {response.status_code}): {response.text[:200]}"
            )
        models = response.json()
        by_slug = {model.get("slug"): model for model in models if model.get("slug")}
        by_title = {model.get("title", "").lower(): model for model in models if model.get("title")}
        return {"by_slug": by_slug, "by_title": by_title}

    def upload_lora(self, entry: MyLoraEntry, model_bytes: bytes, previews: List[tuple[str, bytes]], description: Optional[str], tags: List[str]) -> dict:
        upload_url = urljoin(self.base_url + "/", "uploads")
        form_data: List[tuple[str, str]] = [
            ("assetType", "lora"),
            ("context", "asset"),
            ("title", entry.name),
            ("visibility", self.visibility),
            ("galleryMode", "new"),
            ("targetGallery", f"{entry.name} Collection"),
            ("trigger", entry.tags[0] if entry.tags else entry.stem),
        ]
        if description:
            form_data.append(("description", description))
        for tag in tags:
            form_data.append(("tags", tag))

        files: List[tuple[str, tuple[str, io.BytesIO, str]]] = []
        model_stream = io.BytesIO(model_bytes)
        files.append(("files", (entry.filename, model_stream, "application/octet-stream")))
        for name, data in previews[:MAX_PREVIEW_FILES]:
            stream = io.BytesIO(data)
            mime_type, _ = mimetypes.guess_type(name)
            files.append(("files", (name, stream, mime_type or "application/octet-stream")))

        response = self.session.post(upload_url, data=form_data, files=files, timeout=DEFAULT_TIMEOUT)
        if response.status_code not in (200, 201):
            raise RuntimeError(
                f"VisionSuit upload failed for {entry.filename} (status {response.status_code}): {response.text[:200]}"
            )
        return response.json()


@dataclass
class MigrationStats:
    migrated: int = 0
    skipped_existing: int = 0
    failed: int = 0


def build_description(entry: MyLoraEntry) -> str:
    parts = ["Migrated from MyLora."]
    if entry.base_model:
        parts.append(f"Base model: {entry.base_model}.")
    if entry.categories:
        parts.append("Categories: " + ", ".join(entry.categories) + ".")
    if entry.tags:
        parts.append("Tags: " + ", ".join(entry.tags) + ".")
    return "\n".join(parts)


def normalize_tags(entry: MyLoraEntry) -> List[str]:
    normalized: List[str] = []
    for tag in entry.tags:
        clean = tag.strip()
        if clean:
            normalized.append(clean)
    for category in entry.categories:
        clean = str(category).strip()
        if clean:
            normalized.append(clean)
    if entry.base_model:
        normalized.append(entry.base_model.strip())
    return normalized


def download_mylora_assets(client: MyLoraClient, entry: MyLoraEntry) -> tuple[bytes, List[tuple[str, bytes]]]:
    _, model_bytes = client.download_file(f"uploads/{entry.filename}")
    if not model_bytes:
        raise RuntimeError(f"Model file for {entry.filename} was empty.")
    previews: List[tuple[str, bytes]] = []
    for preview_url in entry.preview_urls:
        try:
            name, data = client.download_file(preview_url)
        except Exception as exc:  # pragma: no cover - network failure handling
            logging.warning("Failed to download preview %s: %s", preview_url, exc)
            continue
        if data:
            previews.append((name, data))
    return model_bytes, previews


def migrate(args: argparse.Namespace) -> MigrationStats:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    mylora = MyLoraClient(args.mylora_base_url, args.mylora_username, args.mylora_password)
    visionsuit = VisionSuitClient(args.visionsuit_base_url, args.visionsuit_email, args.visionsuit_password, args.visibility)

    mylora.login()
    visionsuit.login()

    existing = visionsuit.fetch_existing_models()
    stats = MigrationStats()

    for entry in mylora.fetch_entries():
        slug_candidate = entry.stem.lower().replace(" ", "-")
        if slug_candidate in existing["by_slug"] or entry.name.lower() in existing["by_title"]:
            logging.info("Skipping %s (already present in VisionSuit).", entry.filename)
            stats.skipped_existing += 1
            continue

        try:
            model_bytes, previews = download_mylora_assets(mylora, entry)
            tags = normalize_tags(entry)
            description = build_description(entry)
            response = visionsuit.upload_lora(entry, model_bytes, previews, description, tags)
            stats.migrated += 1
            asset_slug = response.get("assetSlug")
            if asset_slug:
                existing["by_slug"][asset_slug] = {"slug": asset_slug}
            existing["by_title"][entry.name.lower()] = {"title": entry.name}
            logging.info("Migrated %s → VisionSuit asset %s", entry.filename, asset_slug or "<unknown>")
        except Exception as exc:  # pragma: no cover - migration failure logging
            stats.failed += 1
            logging.error("Failed to migrate %s: %s", entry.filename, exc)

    logging.info(
        "Migration complete. Migrated=%d, skipped=%d, failed=%d",
        stats.migrated,
        stats.skipped_existing,
        stats.failed,
    )
    return stats


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Migrate MyLora assets into VisionSuit.")
    parser.add_argument("--mylora-base-url", required=True, help="Base URL for the MyLora instance (e.g. http://127.0.0.1:5000)")
    parser.add_argument("--mylora-username", required=True, help="Admin username for MyLora")
    parser.add_argument("--mylora-password", required=True, help="Admin password for MyLora")
    parser.add_argument("--visionsuit-base-url", required=True, help="VisionSuit API base URL (e.g. http://127.0.0.1:4000/api)")
    parser.add_argument("--visionsuit-email", required=True, help="VisionSuit admin email")
    parser.add_argument("--visionsuit-password", required=True, help="VisionSuit admin password")
    parser.add_argument("--visibility", choices=["private", "public"], default="private", help="Visibility for migrated assets")
    return parser.parse_args(argv)


if __name__ == "__main__":  # pragma: no cover - CLI entry point
    migrate(parse_args())
