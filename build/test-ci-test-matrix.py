#!/usr/bin/env python3
"""Pin Issue4's expensive-band isolation and unchanged coverage (ADR-0154)."""

import importlib.util
import unittest
from pathlib import Path

BUILD = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, BUILD / (name + ".py"))
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load " + name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


matrix = load("generate-ci-test-matrix")
partition = load("verify-ci-test-partition")
PROJECT = "tools/cs2gs/Cs2Gs.Tests/Cs2Gs.Tests.gsproj"
COMPILER_PROJECT = "test/Compiler.Tests/Compiler.Tests.gsproj"


class CiTestMatrixTests(unittest.TestCase):
    def test_compiler_bands_partition_emit_and_top_level_issues(self):
        entries = matrix.sharded_entries(
            COMPILER_PROJECT, matrix.SHARDED_PROJECTS[COMPILER_PROJECT])

        def owner(name):
            selected = [entry["name"] for entry in entries
                        if partition.matches(name, entry["filter"])]
            self.assertEqual(len(selected), 1, (name, selected))
            return selected[0]

        for name, band in (
                ("GSharp.Compiler.Tests.Emit.Issue3329Tests.Control", "issue3"),
                ("GSharp.Compiler.Tests.Emit.Issue4675Tests.Control", "issue4-remainder"),
                ("GSharp.Compiler.Tests.Emit.Issue4776Tests.Control", "issue47-49"),
                ("GSharp.Compiler.Tests.Emit.Issue4986Tests.Control", "issue47-49"),
                ("GSharp.Compiler.Tests.Emit.Adr0208Tests.Control", "emit-remainder"),
                ("GSharp.Compiler.Tests.Issue3912Tests.Control", "top-issue3-4"),
                ("GSharp.Compiler.Tests.Issue4056Tests.Control", "top-issue3-4"),
                ("GSharp.Compiler.Tests.Issue5388Tests.Control", "top-issue5"),
                ("GSharp.Compiler.Tests.ImportedMemberMatrixTests.Control", "remainder")):
            self.assertEqual(owner(name), "compiler-" + band)

    def test_issue4_is_covered_once_with_issue47_isolated(self):
        entries = matrix.sharded_entries(PROJECT, matrix.SHARDED_PROJECTS[PROJECT])

        def owner(name):
            selected = [entry["name"] for entry in entries
                        if partition.matches(name, entry["filter"])]
            self.assertEqual(len(selected), 1, (name, selected))
            return selected[0]

        original = "cs2gs-issue4"
        expensive = owner("Cs2Gs.Tests.Issue4719CastNullTupleLeafTests.Control")
        self.assertNotEqual(
            expensive, original, "Issue47 work still shares the monolithic Issue4 shard")
        self.assertEqual(
            owner("Cs2Gs.Tests.Issue4779NullableReflectionArgumentsSelfMigrationTests.Control"),
            expensive)
        for name in ["Cs2Gs.Tests.Issue4Future.Control"] + [
                f"Cs2Gs.Tests.Issue4{digit}Future.Control" for digit in range(10)]:
            self.assertEqual(owner(name), expensive if ".Issue47" in name else original)
        for name, band in (
                ("Cs2Gs.Tests.Issue1Future.Control", "issue1"),
                ("Cs2Gs.Tests.Issue24Future.Control", "issue24"),
                ("Cs2Gs.Tests.Issue25Future.Control", "issue25"),
                ("Cs2Gs.Tests.Issue33Future.Control", "issue33"),
                ("Cs2Gs.Tests.Issue34Future.Control", "issue34"),
                ("Cs2Gs.Tests.Future.Control", "remainder")):
            self.assertEqual(owner(name), "cs2gs-" + band)


if __name__ == "__main__":
    unittest.main()
