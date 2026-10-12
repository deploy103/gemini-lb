"""Run with python -m scripts.import_legacy_gemini; never starts a server."""

import argparse
import asyncio
import json
from pathlib import Path

from app.modules.gemini.legacy import LegacyImportError, import_legacy


def main() -> None:
    parser = argparse.ArgumentParser(description="Offline legacy import into a NEW target directory")
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    parser.add_argument("--stopped", action="store_true", help="Confirm BOTH source and target are stopped")
    parser.add_argument("--dry-run", action="store_true", help="Validate and print counts without writing")
    args = parser.parse_args()
    try:
        counts = asyncio.run(import_legacy(args.source, args.target, stopped=args.stopped, dry_run=args.dry_run))
    except LegacyImportError as exc:
        parser.exit(2, f"Import refused: {exc}\n")
    print(json.dumps(counts, sort_keys=True))


if __name__ == "__main__":
    main()
