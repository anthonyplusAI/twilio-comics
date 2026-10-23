#!/usr/bin/env python3
"""Integration checks for the pre-push guard using disposable local Git repos."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
GUARD = SCRIPTS / "check-outgoing-postgres-urls.py"
HOOK = ROOT / ".githooks" / "pre-push"
ZERO_OID = "0" * 40


def fake_url(password: str = "fixture_pass") -> str:
    return "postgresql://" + "fixture_user:" + password + "@db.example.invalid/comics"


class TemporaryGitRepo:
    def __init__(self, directory: Path):
        self.directory = directory
        self.repo = directory / "repo"
        self.remote = directory / "remote.git"
        self.env = dict(os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
        self.git("init", "--bare", "-b", "main", str(self.remote), cwd=directory)
        self.git("init", "-b", "main", str(self.repo), cwd=directory)
        self.git("config", "user.name", "Fixture User")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "commit.gpgsign", "false")
        self.git("remote", "add", "origin", str(self.remote))

    def git(self, *args: str, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", *args], cwd=cwd or self.repo, env=self.env,
            text=True, capture_output=True, check=True,
        )

    def commit(self, name: str, content: str, message: str) -> str:
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        self.git("add", "--", name)
        self.git("commit", "-m", message)
        return self.git("rev-parse", "HEAD").stdout.strip()

    def push_without_hook(self, branch: str) -> None:
        self.git("-c", "core.hooksPath=/dev/null", "push", "origin", branch)

    def check(self, local_oid: str, remote_oid: str, ref: str) -> subprocess.CompletedProcess[bytes]:
        update = f"{ref} {local_oid} {ref} {remote_oid}\n".encode()
        return subprocess.run(
            [sys.executable, str(GUARD), "origin", str(self.remote)],
            input=update, cwd=self.repo, env=self.env, capture_output=True, check=False,
        )


class OutgoingPostgresGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.fixture = TemporaryGitRepo(Path(self.temp.name))

    def test_existing_branch_blocks_earlier_commit_even_after_cleanup(self) -> None:
        repo = self.fixture
        base = repo.commit("notes.txt", "clean\n", "base")
        repo.push_without_hook("main")
        leaked = repo.commit("notes.txt", fake_url() + "\n", "bad intermediate")
        current = repo.commit("notes.txt", "clean again\n", "cleanup")

        result = repo.check(current, base, "refs/heads/main")

        self.assertEqual(result.returncode, 1)
        self.assertIn(f"{leaked}:[redacted-path]:1".encode(), result.stderr)
        self.assertNotIn(fake_url().encode(), result.stderr + result.stdout)
        self.assertEqual(result.stdout, b"")

    def test_installed_hook_blocks_new_branch_and_does_not_create_remote_ref(self) -> None:
        repo = self.fixture
        repo.commit("notes.txt", "clean\n", "base")
        repo.push_without_hook("main")
        repo.git("switch", "-c", "feature")
        leaked = repo.commit("notes.txt", fake_url() + "\n", "bad intermediate")
        repo.commit("notes.txt", "clean again\n", "cleanup")

        (repo.repo / ".githooks").mkdir()
        (repo.repo / "scripts").mkdir()
        shutil.copy2(HOOK, repo.repo / ".githooks" / "pre-push")
        for name in ("check-outgoing-postgres-urls.py", "check-postgres-url-literals.py"):
            shutil.copy2(SCRIPTS / name, repo.repo / "scripts" / name)
        (repo.repo / ".githooks" / "pre-push").chmod(0o755)
        repo.git("config", "core.hooksPath", ".githooks")

        result = subprocess.run(
            ["git", "push", "origin", "feature"], cwd=repo.repo, env=repo.env,
            capture_output=True, check=False,
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"{leaked}:[redacted-path]:1".encode(), result.stderr)
        self.assertNotIn(fake_url().encode(), result.stderr + result.stdout)
        self.assertEqual(repo.git("ls-remote", "--heads", "origin", "feature").stdout, "")

    def test_new_branch_excludes_old_history_already_on_remote(self) -> None:
        repo = self.fixture
        repo.commit("notes.txt", fake_url() + "\n", "historical fixture")
        repo.push_without_hook("main")
        repo.git("switch", "-c", "feature")
        current = repo.commit("notes.txt", "clean now\n", "remove fixture")

        result = repo.check(current, ZERO_OID, "refs/heads/feature")

        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(result.stderr, b"")

    def test_unknown_existing_remote_commit_fails_closed_without_git_output(self) -> None:
        repo = self.fixture
        current = repo.commit("notes.txt", "clean\n", "base")

        result = repo.check(current, "a" * 40, "refs/heads/main")

        self.assertEqual(result.returncode, 1)
        self.assertEqual(
            result.stderr,
            b"PostgreSQL URL guard could not inspect this push; push blocked.\n",
        )

    def test_filename_with_alphanumeric_secret_is_redacted(self) -> None:
        repo = self.fixture
        base = repo.commit("notes.txt", "clean\n", "base")
        repo.push_without_hook("main")
        password = "Secret" + "123ABC"
        filename = "portrait" + password + ".txt"
        current = repo.commit(filename, fake_url(password) + "\n", "bad file")

        result = repo.check(current, base, "refs/heads/main")

        self.assertEqual(result.returncode, 1)
        self.assertIn(f"{current}:[redacted-path]:1".encode(), result.stderr)
        self.assertNotIn(password.encode(), result.stderr + result.stdout)
        self.assertNotIn(filename.encode(), result.stderr + result.stdout)

    def test_commit_message_url_is_blocked_without_printing_message(self) -> None:
        repo = self.fixture
        base = repo.commit("notes.txt", "clean\n", "base")
        repo.push_without_hook("main")
        leaked = repo.commit(
            "notes.txt", "still clean\n",
            "Summary\n\nAccidental URL: " + fake_url(),
        )
        current = repo.commit("notes.txt", "clean once more\n", "follow-up")

        result = repo.check(current, base, "refs/heads/main")

        self.assertEqual(result.returncode, 1)
        self.assertIn(f"{leaked}:[commit-message]:3".encode(), result.stderr)
        self.assertNotIn(fake_url().encode(), result.stderr + result.stdout)
        self.assertNotIn(b"Accidental URL", result.stderr + result.stdout)


if __name__ == "__main__":
    unittest.main()
