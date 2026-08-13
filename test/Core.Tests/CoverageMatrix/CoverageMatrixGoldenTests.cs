// <copyright file="CoverageMatrixGoldenTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CoverageMatrix;

/// <summary>
/// Introspects the front-end and back-end coverage surfaces and asserts that the
/// generated summary matches the checked-in golden. Any change to
/// <see cref="SyntaxKind"/>, <see cref="BoundNodeKind"/>,
/// <see cref="BoundBinaryOperator"/>'s supported-operator table, or
/// <see cref="BoundUnaryOperator"/>'s supported-operator table will fail this
/// test until both the golden and `docs/coverage-matrix.md` are updated.
/// </summary>
public class CoverageMatrixGoldenTests
{
    [Fact]
    public void Snapshot_MatchesGolden()
    {
        var generated = BuildSnapshot();
        var goldenPath = LocateGolden();
        GoldenFile.AssertMatches(
            goldenPath,
            generated,
            $"Update both `{goldenPath}` and `docs/coverage-matrix.md`, then re-run.");
    }

    private static string BuildSnapshot()
    {
        var sb = new StringBuilder();

        sb.AppendLine("# GSharp coverage-matrix snapshot");
        sb.AppendLine("# Generated from SyntaxKind, BoundNodeKind, BoundBinaryOperator,");
        sb.AppendLine("# and BoundUnaryOperator. Drift fails CoverageMatrixGoldenTests.");
        sb.AppendLine();

        sb.AppendLine("[SyntaxKind]");
        foreach (var name in Enum.GetNames(typeof(SyntaxKind)).OrderBy(n => n, StringComparer.Ordinal))
        {
            sb.AppendLine(name);
        }

        sb.AppendLine();
        sb.AppendLine("[BoundNodeKind]");
        foreach (var name in Enum.GetNames(typeof(BoundNodeKind)).OrderBy(n => n, StringComparer.Ordinal))
        {
            sb.AppendLine(name);
        }

        sb.AppendLine();
        sb.AppendLine("[BoundBinaryOperator]");
        foreach (var line in DescribeBinaryOperators().OrderBy(l => l, StringComparer.Ordinal))
        {
            sb.AppendLine(line);
        }

        sb.AppendLine();
        sb.AppendLine("[BoundUnaryOperator]");
        foreach (var line in DescribeUnaryOperators().OrderBy(l => l, StringComparer.Ordinal))
        {
            sb.AppendLine(line);
        }

        return sb.ToString().ReplaceLineEndings(Environment.NewLine);
    }

    private static string[] DescribeBinaryOperators()
    {
        var field = typeof(BoundBinaryOperator).GetField(
            "supportedOperators",
            BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(field);
        var ops = (BoundBinaryOperator[])field.GetValue(null);
        return ops.Select(op =>
            $"{op.SyntaxKind} {op.Kind} ({op.LeftType.Name},{op.RightType.Name}) -> {op.Type.Name}").ToArray();
    }

    private static string[] DescribeUnaryOperators()
    {
        var field = typeof(BoundUnaryOperator).GetField(
            "supportedOperators",
            BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(field);
        var ops = (BoundUnaryOperator[])field.GetValue(null);
        return ops.Select(op =>
            $"{op.SyntaxKind} {op.Kind} ({op.OperandType.Name}) -> {op.Type.Name}").ToArray();
    }

    private static string LocateGolden()
    {
        var dir = new DirectoryInfo(Path.GetDirectoryName(typeof(CoverageMatrixGoldenTests).Assembly.Location));
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "GSharp.sln")))
            {
                return Path.Combine(dir.FullName, "test", "Core.Tests", "CoverageMatrix", "coverage-matrix.golden.txt");
            }

            dir = dir.Parent;
        }

        return "coverage-matrix.golden.txt";
    }
}
