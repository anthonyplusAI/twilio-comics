#!/usr/bin/env python3
"""Reject tracked PostgreSQL URLs with literal username and password values.

Keep test URLs assembled from separate fixture fields. This avoids publishing
credential-shaped strings even when their passwords are intentionally fake.
"""

from pathlib import Path
import re
import subprocess


POSTGRES_URL = re.compile(r"postgres(?:ql)?://([^\s/\"'`@]+)@", re.IGNORECASE)


def has_password_url(line: str) -> bool:
    """A full user:password@ URL is forbidden even when it uses placeholders."""
    return any(":" in match.group(1) for match in POSTGRES_URL.finditer(line))


def main() -> int:
    tracked = subprocess.check_output(["git", "ls-files", "-z"]).split(b"\0")
    violations: list[str] = []

    for raw_path in tracked:
        if not raw_path:
            continue
        path = Path(raw_path.decode("utf-8"))
        if not path.is_file() or path.is_symlink():
            continue
        content = path.read_bytes()
        if b"\0" in content:
            continue
        try:
            lines = content.decode("utf-8").splitlines()
        except UnicodeDecodeError:
            continue

        for line_number, line in enumerate(lines, start=1):
            if has_password_url(line):
                violations.append(f"{path}:{line_number}")

    if violations:
        print("Tracked PostgreSQL URLs contain literal credentials at:")
        for location in violations:
            print(f"  {location}")
        print("Build fixture URLs from separate fields; store live values only in Key Vault.")
        return 1

    print("No tracked PostgreSQL URLs contain literal credentials.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
