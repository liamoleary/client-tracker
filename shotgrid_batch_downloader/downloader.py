"""Batch downloader for ShotGrid (Autodesk Flow Production Tracking) media.

Downloads all Version media for a given ShotGrid project and organises it on
disk by parent entity (Asset, Shot, Sequence, ...).
"""

import argparse
import json
import os
import re
import sys

import shotgun_api3
from tqdm import tqdm

from config import (
    OUTPUT_DIR,
    PROJECT_ID,
    SCRIPT_KEY,
    SCRIPT_NAME,
    SHOTGRID_URL,
)


# Fields we request per Version.
VERSION_FIELDS = [
    "id",
    "code",
    "entity",
    "sg_uploaded_movie",
    "sg_uploaded_movie_mp4",
    "sg_uploaded_movie_webm",
    "sg_status_list",
]

# Attachment fields we try to download for each Version.
FILE_FIELDS = [
    "sg_uploaded_movie",
    "sg_uploaded_movie_mp4",
    "sg_uploaded_movie_webm",
]

# Characters that are illegal in file/folder names on Windows/macOS.
_ILLEGAL_FS_CHARS = re.compile(r'[\\/:*?"<>|]')


# ---------------------------------------------------------------------------
# Step 2 — Authenticate
# ---------------------------------------------------------------------------

def connect():
    """Create and verify a ShotGrid connection."""
    sg = shotgun_api3.Shotgun(
        SHOTGRID_URL,
        script_name=SCRIPT_NAME,
        api_key=SCRIPT_KEY,
    )
    info = sg.info()
    print("Connected to ShotGrid. Server info:")
    print(json.dumps(info, indent=2, default=str))
    return sg


# ---------------------------------------------------------------------------
# Step 3 — Fetch all Versions with pagination
# ---------------------------------------------------------------------------

def fetch_all_versions(sg):
    """Return a list of all Version dicts for PROJECT_ID, paginated."""
    filters = [["project", "is", {"type": "Project", "id": PROJECT_ID}]]
    page_size = 500
    page = 1
    all_versions = []
    while True:
        batch = sg.find(
            "Version",
            filters,
            VERSION_FIELDS,
            limit=page_size,
            page=page,
        )
        if not batch:
            break
        all_versions.extend(batch)
        if len(batch) < page_size:
            break
        page += 1
    print(f"Found {len(all_versions)} Versions for project {PROJECT_ID}.")
    return all_versions


# ---------------------------------------------------------------------------
# Step 4 — Build folder structure
# ---------------------------------------------------------------------------

def _sanitise(name):
    """Replace filesystem-illegal characters with underscores."""
    if name is None:
        return ""
    return _ILLEGAL_FS_CHARS.sub("_", str(name))


def get_entity_folder(version, base_output_dir):
    """Return (and create) the folder path for this Version's parent entity."""
    entity = version.get("entity")
    if not entity:
        folder_name = "_no_entity"
    else:
        entity_type = entity.get("type") or "Unknown"
        entity_name = entity.get("name") or f"id_{entity.get('id', 'unknown')}"
        folder_name = f"{entity_type}_{entity_name}"

    folder_name = _sanitise(folder_name)
    folder_path = os.path.abspath(os.path.join(base_output_dir, folder_name))
    os.makedirs(folder_path, exist_ok=True)
    return folder_path


# ---------------------------------------------------------------------------
# Step 5 — Download a single file
# ---------------------------------------------------------------------------

def download_file(url, dest_path, sg):
    """Download one ShotGrid attachment to ``dest_path``.

    Returns:
        True  -> downloaded successfully
        False -> skipped (already existed)
        None  -> error
    """
    try:
        if os.path.exists(dest_path) and os.path.getsize(dest_path) > 0:
            print(f"[SKIP] Already exists: {dest_path}")
            return False

        filename = os.path.basename(dest_path)
        # tqdm progress bar (size unknown here, just show the filename).
        with tqdm(
            desc=filename,
            unit="B",
            unit_scale=True,
            unit_divisor=1024,
            leave=False,
        ) as bar:
            sg.download_attachment({"url": url}, file_path=dest_path)
            if os.path.exists(dest_path):
                bar.update(os.path.getsize(dest_path))
        return True
    except Exception as e:  # pragma: no cover - network path
        print(f"[ERROR] Failed to download {url}: {e}")
        return None


# ---------------------------------------------------------------------------
# Step 6 — Determine file extension
# ---------------------------------------------------------------------------

def get_extension(attachment_field_dict, field_name):
    """Return the file extension (including dot) for an attachment dict."""
    fallback = {
        "sg_uploaded_movie": ".mp4",
        "sg_uploaded_movie_mp4": ".mp4",
        "sg_uploaded_movie_webm": ".webm",
    }.get(field_name, ".bin")

    if attachment_field_dict:
        name = attachment_field_dict.get("name")
        if name:
            _, ext = os.path.splitext(name)
            if ext:
                return ext
    return fallback


# ---------------------------------------------------------------------------
# Step 7 — Process and download all Versions
# ---------------------------------------------------------------------------

def _attachment_has_downloadable_url(attachment):
    """Return True if the attachment dict has a usable upload URL."""
    if not attachment or not isinstance(attachment, dict):
        return False
    url = attachment.get("url")
    if not url:
        return False
    # Only uploads are real files. 'web' and 'local' aren't downloadable here.
    link_type = attachment.get("link_type")
    if link_type and link_type != "upload":
        return False
    return True


def download_all(sg, versions, base_output_dir, dry_run=False):
    """Process every Version, downloading its attachments (or logging a dry run)."""
    os.makedirs(base_output_dir, exist_ok=True)
    log_entries = []

    downloaded = 0
    skipped = 0
    errors = 0

    for version in tqdm(versions, desc="Processing versions", unit="ver"):
        folder = get_entity_folder(version, base_output_dir)

        code = version.get("code") or f"version_{version.get('id')}"
        safe_code = _sanitise(code)

        entity = version.get("entity") or {}
        entity_type = entity.get("type")
        entity_name = entity.get("name")
        entity_id = entity.get("id")

        for field in FILE_FIELDS:
            attachment = version.get(field)
            if not _attachment_has_downloadable_url(attachment):
                continue

            url = attachment["url"]
            ext = get_extension(attachment, field)

            # Only append a suffix for the transcode fields; the primary
            # uploaded movie keeps the Version code as-is.
            if field == "sg_uploaded_movie_mp4":
                filename = f"{safe_code}_mp4{ext}"
            elif field == "sg_uploaded_movie_webm":
                filename = f"{safe_code}_webm{ext}"
            else:
                filename = f"{safe_code}{ext}"

            dest_path = os.path.join(folder, filename)

            entry = {
                "version_id": version.get("id"),
                "version_code": code,
                "entity_type": entity_type,
                "entity_name": entity_name,
                "entity_id": entity_id,
                "field_name": field,
                "dest_path": dest_path,
                "status": None,
            }

            if dry_run:
                print(
                    f"[DRY-RUN] {folder} | {code} | {field} | {url} -> {dest_path}"
                )
                entry["status"] = "dry_run"
            else:
                result = download_file(url, dest_path, sg)
                if result is True:
                    entry["status"] = "downloaded"
                    downloaded += 1
                elif result is False:
                    entry["status"] = "skipped"
                    skipped += 1
                else:
                    entry["status"] = "error"
                    errors += 1

            log_entries.append(entry)

    log_path = os.path.join(base_output_dir, "download_log.json")
    with open(log_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(log_entries, indent=2))

    print("")
    print("=" * 60)
    print(f"Versions processed : {len(versions)}")
    print(f"Files downloaded   : {downloaded}")
    print(f"Files skipped      : {skipped}")
    print(f"Files errored      : {errors}")
    print(f"Log written to     : {log_path}")
    print("=" * 60)

    return log_entries


# ---------------------------------------------------------------------------
# Step 8 — CLI entry point
# ---------------------------------------------------------------------------

def _parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Batch download ShotGrid Version media for a project.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be downloaded without downloading anything.",
    )
    parser.add_argument(
        "--output-dir",
        default=OUTPUT_DIR,
        help=f"Root output directory (default: {OUTPUT_DIR}).",
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = _parse_args(argv)
    sg = connect()
    versions = fetch_all_versions(sg)
    print(f"Total Versions found: {len(versions)}")
    download_all(sg, versions, args.output_dir, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
