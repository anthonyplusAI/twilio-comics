#!/usr/bin/env python3
"""Contract checks for the source guard without storing complete DSNs here."""

from pathlib import Path
import runpy
import unittest


guard = runpy.run_path(str(Path(__file__).with_name("check-postgres-url-literals.py")))
has_password_url = guard["has_password_url"]


class PostgresUrlGuardTest(unittest.TestCase):
    def test_rejects_literal_and_templated_credentials(self) -> None:
        literal = "postgresql://" + "fixture_user:fixture_pass" + "@db.example.invalid/comics"
        template = "postgresql://" + "<user>:<password>" + "@db.example.invalid/comics"
        self.assertTrue(has_password_url(literal))
        self.assertTrue(has_password_url(template))

    def test_checks_each_url_even_when_a_template_follows_on_the_same_line(self) -> None:
        literal = "POSTGRESQL://" + "fixture_user:fixture_pass" + "@db.example.invalid/comics"
        template = "postgresql://" + "{user}:{password}" + "@db.example.invalid/comics"
        self.assertTrue(has_password_url(literal + " " + template))

    def test_allows_urls_without_embedded_credentials(self) -> None:
        self.assertFalse(has_password_url("postgresql://db.example.invalid/comics"))


if __name__ == "__main__":
    unittest.main()
