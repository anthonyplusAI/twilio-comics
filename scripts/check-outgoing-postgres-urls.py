#!/usr/bin/env python3
"""Block pushes that introduce a credential-shaped PostgreSQL URL in any commit.

Inspect messages and changed blobs in every outgoing commit, including commits
followed by a cleanup commit. Never emit their contents or Git errors.
"""

from __future__ import annotations

from pathlib import Path
import re
import runpy
import subprocess
import sys


has_password_url = runpy.run_path(
    str(Path(__file__).with_name("check-postgres-url-literals.py"))
)["has_password_url"]
OBJECT_ID = re.compile(rb"[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?\Z")


class InspectionError(Exception):
    """A Git operation did not yield a trustworthy set of outgoing blobs."""


def git(*args: str) -> bytes:
    result = subprocess.run(
        ["git", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        check=False, timeout=30,
    )
    if result.returncode != 0:
        raise InspectionError
    return result.stdout


def valid_oid(oid: bytes) -> bool:
    return OBJECT_ID.fullmatch(oid) is not None


def commit_oid(oid: bytes) -> str:
    if not valid_oid(oid):
        raise InspectionError
    resolved = git("rev-parse", "--verify", f"{oid.decode('ascii')}^{{commit}}")
    result = resolved.strip()
    if not valid_oid(result):
        raise InspectionError
    return result.decode("ascii")


def remote_commits(remote_url: str) -> list[str]:
    """Use advertised remote refs for a new branch, not stale tracking refs."""
    output = git("ls-remote", "--heads", "--tags", "--", remote_url)
    commits: set[str] = set()
    for line in output.splitlines():
        parts = line.split(b"\t", 1)
        if len(parts) != 2 or not valid_oid(parts[0]):
            raise InspectionError
        oid = parts[0].decode("ascii")
        # A remote ref need not have been fetched locally. Only known objects can
        # be used as an exclusion; unknown ones make the scan larger, not weaker.
        exists = subprocess.run(
            ["git", "cat-file", "-e", f"{oid}^{{commit}}"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=30,
        )
        if exists.returncode == 0:
            commits.add(commit_oid(parts[0]))
    return sorted(commits)


def outgoing_commits(updates: bytes, remote_url: str) -> list[str]:
    found: set[str] = set()
    advertised: list[str] | None = None

    for line in updates.splitlines():
        parts = line.split()
        if len(parts) != 4:
            raise InspectionError
        _local_ref, local_oid, _remote_ref, remote_oid = parts
        if not valid_oid(local_oid) or not valid_oid(remote_oid):
            raise InspectionError
        if set(local_oid) == {ord("0")}:
            continue  # Ref deletion sends no commit blobs.

        local = commit_oid(local_oid)
        if set(remote_oid) == {ord("0")}:
            if advertised is None:
                advertised = remote_commits(remote_url)
            bases = advertised
        else:
            bases = [commit_oid(remote_oid)]

        revision_args = [local, "--not", *bases] if bases else [local]
        for raw_commit in git("rev-list", "--topo-order", *revision_args).splitlines():
            if not valid_oid(raw_commit):
                raise InspectionError
            found.add(raw_commit.decode("ascii"))

    return sorted(found)


def changed_blobs(commit: str) -> list[bytes]:
    """Return new blobs for changes, including merge resolutions."""
    output = git(
        "diff-tree", "--root", "-m", "-r", "--no-renames", "--raw", "-z",
        "--no-commit-id", commit,
    )
    if not output:
        return []
    fields = output.split(b"\0")
    if fields[-1] != b"" or len(fields) % 2 != 1:
        raise InspectionError

    blobs: set[bytes] = set()
    for index in range(0, len(fields) - 1, 2):
        metadata, path = fields[index : index + 2]
        tokens = metadata[1:].split()
        if not metadata.startswith(b":") or len(tokens) != 5 or not path:
            raise InspectionError
        _old_mode, new_mode, _old_oid, new_oid, status = tokens
        if not valid_oid(new_oid):
            raise InspectionError
        if status == b"D" or new_mode == b"160000":
            continue  # Deleted blobs and submodule commit pointers have no content.
        if status not in {b"A", b"C", b"M", b"R", b"T"}:
            raise InspectionError
        blobs.add(new_oid)
    return sorted(blobs)


def password_url_lines(content: bytes) -> tuple[int, ...]:
    return tuple(
        number
        for number, raw_line in enumerate(content.split(b"\n"), start=1)
        if has_password_url(raw_line.decode("utf-8", errors="replace"))
    )


def commit_message_lines(commit: str) -> tuple[int, ...]:
    _headers, separator, message = git("cat-file", "commit", commit).partition(b"\n\n")
    if not separator:
        raise InspectionError
    return password_url_lines(message)


def inspect(updates: bytes, remote_url: str) -> list[str]:
    locations: list[str] = []
    cache: dict[bytes, tuple[int, ...]] = {}
    for commit in outgoing_commits(updates, remote_url):
        for line in commit_message_lines(commit):
            locations.append(f"{commit}:[commit-message]:{line}")
        for blob_oid in changed_blobs(commit):
            if blob_oid not in cache:
                cache[blob_oid] = password_url_lines(
                    git("cat-file", "blob", blob_oid.decode("ascii"))
                )
            for line in cache[blob_oid]:
                locations.append(f"{commit}:[redacted-path]:{line}")
    return locations


def main() -> int:
    if len(sys.argv) != 3:
        print("PostgreSQL URL guard could not inspect this push; push blocked.", file=sys.stderr)
        return 1
    _remote_name, remote_url = sys.argv[1:]
    try:
        locations = inspect(sys.stdin.buffer.read(), remote_url)
    except Exception:
        # This is a safety gate: unexpected parsing/runtime failures must not
        # turn into an allow or print a Git error containing sensitive content.
        print("PostgreSQL URL guard could not inspect this push; push blocked.", file=sys.stderr)
        return 1
    if locations:
        for location in locations:
            print(location, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
