// <copyright file="CoverageMatrixGoldenTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CoverageMatrix

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System
import System.IO
import System.Linq
import System.Reflection
import System.Text
import Xunit

/// Introspects the front-end and back-end coverage surfaces and asserts that the
/// generated summary matches the checked-in golden. Any change to
/// (cref:SyntaxKind), (cref:BoundNodeKind),
/// (cref:BoundBinaryOperator)'s supported-operator table, or
/// (cref:BoundUnaryOperator)'s supported-operator table will fail this
/// test until both the golden and `docs/coverage-matrix.md` are updated.
open class CoverageMatrixGoldenTests {
    @Fact
    func Snapshot_MatchesGolden() {
        let generated = BuildSnapshot()
        let goldenPath = LocateGolden()
        GoldenFile.AssertMatches(
            goldenPath,
            generated,
            "Update both `$goldenPath` and `docs/coverage-matrix.md`, then re-run."
        )
    }

    shared {
        private func BuildSnapshot() string {
            let sb = StringBuilder()
            sb.AppendLine("# GSharp coverage-matrix snapshot")
            sb.AppendLine("# Generated from SyntaxKind, BoundNodeKind, BoundBinaryOperator,")
            sb.AppendLine("# and BoundUnaryOperator. Drift fails CoverageMatrixGoldenTests.")
            sb.AppendLine()
            sb.AppendLine("[SyntaxKind]")
            for name in Enum.GetNames(typeof(SyntaxKind)).OrderBy((n string) -> n, StringComparer.Ordinal) {
                sb.AppendLine(name)
            }
            sb.AppendLine()
            sb.AppendLine("[BoundNodeKind]")
            for name in Enum.GetNames(typeof(BoundNodeKind)).OrderBy((n string) -> n, StringComparer.Ordinal) {
                sb.AppendLine(name)
            }
            sb.AppendLine()
            sb.AppendLine("[BoundBinaryOperator]")
            for line in DescribeBinaryOperators().OrderBy((l string) -> l, StringComparer.Ordinal) {
                sb.AppendLine(line)
            }
            sb.AppendLine()
            sb.AppendLine("[BoundUnaryOperator]")
            for line in DescribeUnaryOperators().OrderBy((l string) -> l, StringComparer.Ordinal) {
                sb.AppendLine(line)
            }
            return sb.ToString().ReplaceLineEndings(Environment.NewLine)
        }

        private func DescribeBinaryOperators()[]string {
            let field FieldInfo? = typeof(BoundBinaryOperator).GetField(
                "supportedOperators",
                BindingFlags.NonPublic | BindingFlags.Static
            )
            Assert.NotNull(field)
            let ops[]?BoundBinaryOperator = cast[[]BoundBinaryOperator](field!!.GetValue(nil))
            return ops!!.Select(
                (
                    op BoundBinaryOperator
                ) -> "${op.SyntaxKind} ${op.Kind} (${op.LeftType.Name},${op.RightType.Name}) -> ${op.Type.Name}"
            )
                .ToArray()
        }

        private func DescribeUnaryOperators()[]string {
            let field FieldInfo? = typeof(BoundUnaryOperator).GetField(
                "supportedOperators",
                BindingFlags.NonPublic | BindingFlags.Static
            )
            Assert.NotNull(field)
            let ops[]?BoundUnaryOperator = cast[[]BoundUnaryOperator](field!!.GetValue(nil))
            return ops!!.Select(
                (op BoundUnaryOperator) -> "${op.SyntaxKind} ${op.Kind} (${op.OperandType.Name}) -> ${op.Type.Name}"
            )
                .ToArray()
        }

        private func LocateGolden() string {
            var dir DirectoryInfo? = DirectoryInfo(
                Path.GetDirectoryName(typeof(CoverageMatrixGoldenTests).Assembly.Location)!!
            )
            while dir != nil {
                if RepositoryRootMarker.IsRoot(dir.FullName) {
                    return Path.Combine(
                        dir.FullName,
                        "test",
                        "Core.Tests",
                        "CoverageMatrix",
                        "coverage-matrix.golden.txt"
                    )
                }
                dir = dir.Parent
            }
            return "coverage-matrix.golden.txt"
        }
    }
}
