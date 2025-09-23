from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from typing import Iterable, Optional

import boto3
from botocore.config import Config as BotoConfig

from .config import AgentConfig

LOGGER = logging.getLogger(__name__)


class MinioManager:
    def __init__(self, config: AgentConfig) -> None:
        endpoint_url = config.minio.endpoint
        if not config.minio.secure and endpoint_url.startswith("http://"):
            # boto3 expects plain HTTP when secure=False; keep as provided.
            pass
        session = boto3.session.Session()
        self.client = session.client(
            "s3",
            endpoint_url=endpoint_url,
            aws_access_key_id=config.minio.access_key,
            aws_secret_access_key=config.minio.secret_key,
            region_name=config.minio.region,
            config=BotoConfig(signature_version="s3v4"),
            verify=config.minio.verify_tls,
        )
        self.config = config

    def download_to_path(self, bucket: str, key: str, destination: Path) -> Path:
        destination.parent.mkdir(parents=True, exist_ok=True)
        LOGGER.info("Downloading s3://%s/%s -> %s", bucket, key, destination)
        self.client.download_file(bucket, key, str(destination))
        return destination

    def upload_file(self, bucket: str, key: str, source: Path, extra_metadata: Optional[dict[str, str]] = None) -> None:
        LOGGER.info("Uploading %s -> s3://%s/%s", source, bucket, key)
        metadata = extra_metadata or {}
        checksum = metadata.get("sha256") or compute_sha256(source)
        metadata.setdefault("sha256", checksum)
        self.client.upload_file(
            str(source),
            bucket,
            key,
            ExtraArgs={
                "Metadata": metadata,
            },
        )

    def ensure_objects(self, assets: Iterable[tuple[str, str]]) -> None:
        for bucket, key in assets:
            try:
                self.client.head_object(Bucket=bucket, Key=key)
            except Exception as exc:  # noqa: BLE001
                raise FileNotFoundError(f"Object missing in MinIO: s3://{bucket}/{key}") from exc

    def get_object_metadata(self, bucket: str, key: str) -> dict[str, str]:
        try:
            response = self.client.head_object(Bucket=bucket, Key=key)
        except Exception as exc:  # noqa: BLE001
            LOGGER.debug("Failed to retrieve metadata for s3://%s/%s: %s", bucket, key, exc)
            return {}
        metadata = response.get("Metadata") or {}
        return {str(k).lower(): str(v) for k, v in metadata.items() if k}


def compute_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

