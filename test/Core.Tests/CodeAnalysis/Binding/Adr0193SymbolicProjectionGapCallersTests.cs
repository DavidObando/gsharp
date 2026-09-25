// <copyright file="Adr0193SymbolicProjectionGapCallersTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0193 Phase 2: <c>MemberLookup.MapOpenSignatureWithoutDeclarationMerge</c>
/// is the known symbolic-projection gap, kept inside the one GSA0007
/// suppression until Phase 4 adds its merge. GSA0007 cannot see a call to it,
/// because it is a named member rather than a door, so this test pins every
/// call site instead: a new caller fails here until it is reviewed and added.
/// </summary>
public sealed class Adr0193SymbolicProjectionGapCallersTests
{
    private static readonly string[] Expected =
    [
        "Binding/ExpressionBinder.Calls.Invocation.cs x6",
        "Binding/ExpressionBinder.Literals.cs x1",
        "Binding/OverloadResolution/OverloadResolver.Arguments.cs x1",
    ];

    [Fact]
    public void EveryCallerOfTheGapMemberIsListed()
    {
        var root = Path.Combine(TestSource.Root, "src", "Core", "CodeAnalysis");
        var call = new Regex(@"\bMapOpenSignatureWithoutDeclarationMerge\s*\(", RegexOptions.CultureInvariant);
        var definition = new Regex(@"\bTypeSymbol\s+MapOpenSignatureWithoutDeclarationMerge\s*\(", RegexOptions.CultureInvariant);
        var lineComment = new Regex(@"//[^\n]*", RegexOptions.CultureInvariant);
        var actual = Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories)
            .Select(path =>
            {
                // Whole-file scan, so a call split across lines still counts.
                var code = lineComment.Replace(File.ReadAllText(path), string.Empty);
                return (
                    Path: Path.GetRelativePath(root, path).Replace('\\', '/'),
                    Count: call.Matches(code).Count - definition.Matches(code).Count);
            })
            .Where(entry => entry.Count > 0)
            .Select(entry => $"{entry.Path} x{entry.Count}")
            .OrderBy(entry => entry, StringComparer.Ordinal)
            .ToArray();

        Assert.True(
            Expected.SequenceEqual(actual),
            "The callers of MapOpenSignatureWithoutDeclarationMerge changed. A new caller joins the Phase 4 gap; review it, then update the list to:"
                + Environment.NewLine
                + string.Join(Environment.NewLine, actual.Select(entry => $"        \"{entry}\",")));
    }
}
