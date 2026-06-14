// <copyright file="Issue805MapTypeClauseSpellingParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #805 / ADR-0104 — the legacy Go-flavored map type-clause
/// spelling <c>map[K]V</c> has been removed. The canonical G# spelling
/// is <c>map[K,V]</c> with both type arguments inside the brackets,
/// separated by a comma. The parser still recognizes the legacy shape
/// long enough to emit a span-accurate <see cref="DiagnosticId"/>
/// diagnostic ("did you mean <c>map[K,V]</c>?") so the file does not
/// cascade into a thicket of follow-on parse errors.
/// </summary>
public class Issue805MapTypeClauseSpellingParserTests
{
    private const string DiagnosticId = "GS0366";

    private static Diagnostic[] LegacyMapDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(source);
        return tree.Diagnostics.Where(d => d.Id == DiagnosticId).ToArray();
    }

    private static Diagnostic[] AllParserDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(source);
        return tree.Diagnostics.ToArray();
    }

    // --- canonical `map[K,V]` is accepted in every type-clause slot ---

    [Theory]
    [InlineData("var m map[string,int32] = map[string,int32]{\"a\": 1}")]
    [InlineData("let m = map[string,int32]{\"a\": 1}")]
    [InlineData("let m = map[int32,string]{1: \"one\"}")]
    [InlineData("let m = map[string,string?]{}")]
    [InlineData("let m map[string,int32]? = nil")]
    [InlineData("let m sequence[map[string,int32]] = nil")]
    [InlineData("let m = map[string,async sequence[int32]]{}")]
    public void CanonicalSpelling_IsAcceptedInAllTypeClauseSlots(string statement)
    {
        var source = $$"""
            package P
            func main() {
                {{statement}}
            }
            """;
        var diagnostics = AllParserDiagnostics(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void CanonicalSpelling_InFunctionSignatures_NoDiagnostics()
    {
        const string source = """
            package P

            func makeIndex() map[string,int32] {
                return map[string,int32]{"a": 1}
            }

            func sum(m map[string,int32]) int32 {
                return 0
            }
            """;
        Assert.Empty(AllParserDiagnostics(source));
    }

    [Fact]
    public void CanonicalSpelling_InReceiverClause_NoDiagnostics()
    {
        const string source = """
            package P

            func (self map[K,V]) CountKeys[K, V]() int32 {
                return 0
            }
            """;
        Assert.Empty(AllParserDiagnostics(source));
    }

    // --- legacy `map[K]V` is rejected with GS0366 ---

    [Fact]
    public void LegacySpelling_InLocalDeclaration_ReportsGS0366()
    {
        const string source = """
            package P
            func main() {
                var m = map[string]int32{"a": 1}
            }
            """;
        var diagnostics = LegacyMapDiagnostics(source);
        var d = Assert.Single(diagnostics);
        Assert.Contains("'map[K]V' type-clause spelling has been removed", d.Message);
        Assert.Contains("map[string,int32]", d.Message);
        Assert.Contains("ADR-0104", d.Message);
    }

    [Fact]
    public void LegacySpelling_DiagnosticSpan_CoversWholeShape()
    {
        // `map[string]int32` is the full offending shape; the diagnostic
        // span must run from `map` through the value type so an IDE
        // quick-fix can replace the whole construct in one edit.
        const string source = """
            package P
            func main() {
                var m = map[string]int32{"a": 1}
            }
            """;
        var d = Assert.Single(LegacyMapDiagnostics(source));
        var spanText = d.Location.Text.ToString(d.Location.Span);
        Assert.Equal("map[string]int32", spanText);
    }

    [Fact]
    public void LegacySpelling_InReturnType_ReportsGS0366()
    {
        const string source = """
            package P
            func makeIndex() map[string]int32 {
                return map[string,int32]{}
            }
            """;
        var diagnostics = LegacyMapDiagnostics(source);
        var d = Assert.Single(diagnostics);
        Assert.Contains("map[string,int32]", d.Message);
    }

    [Fact]
    public void LegacySpelling_InParameterType_ReportsGS0366()
    {
        const string source = """
            package P
            func sum(m map[string]int32) int32 {
                return 0
            }
            """;
        var d = Assert.Single(LegacyMapDiagnostics(source));
        Assert.Contains("map[string,int32]", d.Message);
    }

    [Fact]
    public void LegacySpelling_InReceiverClause_ReportsGS0366()
    {
        const string source = """
            package P
            func (self map[K]V) CountKeys[K, V]() int32 {
                return 0
            }
            """;
        var d = Assert.Single(LegacyMapDiagnostics(source));
        Assert.Contains("map[K,V]", d.Message);
    }

    [Fact]
    public void LegacySpelling_InFieldDeclaration_ReportsGS0366()
    {
        const string source = """
            package P
            class Counter {
                var bins map[string]int32 = map[string,int32]{}
            }
            """;
        var d = Assert.Single(LegacyMapDiagnostics(source));
        Assert.Contains("map[string,int32]", d.Message);
    }

    [Fact]
    public void LegacySpelling_InNestedTypeClause_ReportsGS0366()
    {
        const string source = """
            package P
            func main() {
                let m sequence[map[string]int32] = nil
            }
            """;
        var d = Assert.Single(LegacyMapDiagnostics(source));
        Assert.Contains("map[string,int32]", d.Message);
    }

    // --- mixed forms in same file: multiple diagnostics, no cascades ---

    [Fact]
    public void MixedForms_EmitOneDiagnosticPerLegacySite_NoCascade()
    {
        const string source = """
            package P

            func legacyReturn() map[string]int32 {
                return map[string,int32]{}
            }

            func legacyParam(m map[string]int32) int32 {
                return 0
            }

            func main() {
                var a = map[string,int32]{"a": 1}
                var b = map[int32]string{1: "one"}
                var c = map[string,string]{}
                var d = map[string]string?{}
            }
            """;
        var diagnostics = LegacyMapDiagnostics(source);

        // Four legacy occurrences: legacyReturn return type, legacyParam
        // parameter type, the `map[int32]string` literal, and the
        // `map[string]string?` literal.
        Assert.Equal(4, diagnostics.Length);

        // No cascade: the parser recovers each legacy shape into the
        // canonical bound form, so no other parser diagnostics fire.
        var tree = SyntaxTree.Parse(source);
        var nonGS0366 = tree.Diagnostics.Where(d => d.Id != DiagnosticId).ToArray();
        Assert.Empty(nonGS0366);
    }

    [Fact]
    public void MixedForms_EveryDiagnosticCarriesItsOwnReplacement()
    {
        const string source = """
            package P
            func main() {
                var a = map[string]int32{"a": 1}
                var b = map[K]V{}
            }
            """;
        var diagnostics = LegacyMapDiagnostics(source);
        Assert.Equal(2, diagnostics.Length);
        Assert.Contains(diagnostics, d => d.Message.Contains("map[string,int32]"));
        Assert.Contains(diagnostics, d => d.Message.Contains("map[K,V]"));
    }
}
