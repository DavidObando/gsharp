// <copyright file="Adr0174ChanTypeClauseParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0174 D2 — the channel type clause is spelled <c>chan[T]</c> with the
/// element type inside brackets (like <c>sequence[T]</c> and <c>map[K, V]</c>),
/// optionally headed by the variance keywords <c>in</c> (receive-only) or
/// <c>out</c> (send-only). This retires the juxtaposed <c>chan T</c> spelling
/// and with it the <c>(chan T)?</c> grouping carve-out: <c>chan[int32]?</c> and
/// <c>chan[int32?]</c> now say the two things directly. The parser still
/// recognizes the legacy shape long enough to emit a span-accurate
/// <c>GS0567</c> ("use <c>chan[T]</c>") and then binds the canonical form so
/// the file does not cascade — the same recovery ADR-0104 gave <c>map[K]V</c>.
/// </summary>
public class Adr0174ChanTypeClauseParserTests
{
    private const string LegacyDiagnosticId = "GS0567";

    private static Diagnostic[] AllParserDiagnostics(string source) => SyntaxTree.Parse(source).Diagnostics.ToArray();

    private static Diagnostic[] LegacyDiagnostics(string source)
        => SyntaxTree.Parse(source).Diagnostics.Where(d => d.Id == LegacyDiagnosticId).ToArray();

    // --- canonical `chan[T]` in every type-clause slot ---

    [Theory]
    [InlineData("var ch chan[int32] = chan[int32](1)")]
    [InlineData("let ch = chan[int32](1)")]
    [InlineData("let ch = chan[int32]()")]
    [InlineData("let ch = chan[string?](2)")]
    [InlineData("var ch chan[int32]? = nil")]
    [InlineData("var ch chan[int32?]? = nil")]
    [InlineData("var chs []chan[int32] = []chan[int32]{}")]
    [InlineData("var m map[string, chan[int32]] = map[string, chan[int32]]{}")]
    [InlineData("var nested chan[chan[int32]] = chan[chan[int32]](1)")]
    [InlineData("var ch chan[(int32, string)] = chan[(int32, string)](1)")]
    [InlineData("var ch chan[[]int32] = chan[[]int32](1)")]
    [InlineData("var r in chan[int32]? = nil")]
    [InlineData("var w out chan[int32]? = nil")]
    [InlineData("var g (chan[int32])? = nil")]
    public void CanonicalSpelling_IsAcceptedInAllTypeClauseSlots(string statement)
    {
        var source = $$"""
            package P
            func main() {
                {{statement}}
            }
            """;
        Assert.Empty(AllParserDiagnostics(source));
    }

    [Fact]
    public void DirectionalSpellings_InSignatures_NoDiagnostics()
    {
        const string source = """
            package P

            func produce(values []int32) in chan[int32] {
                let out = chan[int32]()
                return out
            }

            func route(input in chan[int32], evens out chan[int32], odds out chan[int32]) {
            }

            func both(ch chan[int32]) {
            }
            """;
        Assert.Empty(AllParserDiagnostics(source));
    }

    [Fact]
    public void DirectionalParameter_FollowedByForIn_IsNotConfusable()
    {
        // `in` heads the channel type in the parameter and heads the loop in
        // the body — the one genuinely confusable line D2 calls out.
        const string source = """
            package P
            func drain(ch in chan[int32]) {
                for v in ch {
                }
            }
            """;
        Assert.Empty(AllParserDiagnostics(source));
    }

    [Fact]
    public void DirectionalHead_IsATypeHead_NotATupleElementName()
    {
        const string source = """
            package P
            func main() {
                var pair (in chan[int32], out chan[int32]) = (chan[int32](1), chan[int32](1))
                var named (reader in chan[int32], writer out chan[int32]) = (chan[int32](1), chan[int32](1))
            }
            """;
        Assert.Empty(AllParserDiagnostics(source));
        var tree = SyntaxTree.Parse(source);
        var clauses = tree.Root.DescendantNodes().OfType<TypeClauseSyntax>().Where(t => t.IsChannel).ToArray();
        Assert.Equal(4, clauses.Count(t => t.ChanDirectionToken != null));
        Assert.All(clauses, t => Assert.False(t.IsLegacyChanSpelling));
    }

    [Fact]
    public void Construction_ParsesTypeClauseAppliedToArguments()
    {
        var tree = SyntaxTree.Parse("""
            package P
            func main() {
                let a = chan[int32]()
                let b = chan[int32](4)
                let c = chan[int32](4).Length()
            }
            """);
        Assert.Empty(tree.Diagnostics);
        var creations = tree.Root.DescendantNodes().OfType<ChannelCreationExpressionSyntax>().ToArray();
        Assert.Equal(3, creations.Length);
        Assert.Equal(0, creations[0].Arguments.Count);
        Assert.Equal(1, creations[1].Arguments.Count);
        Assert.True(creations[0].TypeClause.IsChannel);
        Assert.Null(creations[0].TypeClause.ChanDirectionToken);
    }

    // --- legacy `chan T` is rejected with GS0567 ---

    [Fact]
    public void LegacySpelling_InLocalDeclaration_ReportsGS0567()
    {
        const string source = """
            package P
            func main() {
                var ch chan int32 = chan[int32](1)
            }
            """;
        var d = Assert.Single(LegacyDiagnostics(source));
        Assert.Contains("'chan T' type-clause spelling has been removed", d.Message);
        Assert.Contains("chan[int32]", d.Message);
        Assert.Contains("ADR-0174", d.Message);
    }

    [Fact]
    public void LegacySpelling_DiagnosticSpan_CoversWholeShape()
    {
        // The span must run from `chan` through the element type so an IDE
        // quick-fix can replace the whole construct in one edit.
        const string source = """
            package P
            func main() {
                var ch chan int32 = chan[int32](1)
            }
            """;
        var d = Assert.Single(LegacyDiagnostics(source));
        Assert.Equal("chan int32", d.Location.Text.ToString(d.Location.Span));
    }

    [Fact]
    public void LegacySpelling_WithDirection_SpanIncludesTheDirection()
    {
        const string source = """
            package P
            func f(ch in chan int32) {
            }
            """;
        var d = Assert.Single(LegacyDiagnostics(source));
        Assert.Equal("in chan int32", d.Location.Text.ToString(d.Location.Span));
        Assert.Contains("chan[int32]", d.Message);
    }

    [Theory]
    [InlineData("func makeIt() chan int32 { return chan[int32](1) }", "chan[int32]")]
    [InlineData("func take(ch chan string) { }", "chan[string]")]
    [InlineData("func (self chan T) Drain[T]() { }", "chan[T]")]
    [InlineData("class Box { var ch chan int32? = nil }", "chan[int32?]")]
    [InlineData("func main() { let s sequence[chan int32] = nil }", "chan[int32]")]
    public void LegacySpelling_InEverySlot_ReportsGS0567_NamingTheReplacement(string declaration, string replacement)
    {
        var source = $$"""
            package P
            {{declaration}}
            """;
        var d = Assert.Single(LegacyDiagnostics(source));
        Assert.Contains(replacement, d.Message);
    }

    [Fact]
    public void LegacyNullableElement_RecoversAsChannelOfNullable()
    {
        // `chan int32?` was `chan (int32?)` (the element parse is greedy); the
        // recovered canonical clause therefore brackets the nullable element.
        var tree = SyntaxTree.Parse("""
            package P
            func main() {
                var ch chan int32? = nil
            }
            """);
        var clause = tree.Root.DescendantNodes().OfType<TypeClauseSyntax>().Single(t => t.IsChannel);
        Assert.True(clause.IsLegacyChanSpelling);
        Assert.NotNull(clause.ChanElementType!.QuestionToken);
        Assert.Null(clause.QuestionToken);
    }

    [Fact]
    public void MixedForms_EmitOneDiagnosticPerLegacySite_NoCascade()
    {
        const string source = """
            package P

            func legacyReturn() chan int32 {
                return chan[int32](1)
            }

            func legacyParam(ch chan string) {
            }

            func main() {
                var a chan[int32] = chan[int32](1)
                var b chan bool = chan[bool](1)
                var c in chan[int32]? = nil
            }
            """;
        var diagnostics = LegacyDiagnostics(source);
        Assert.Equal(3, diagnostics.Length);
        Assert.Empty(SyntaxTree.Parse(source).Diagnostics.Where(d => d.Id != LegacyDiagnosticId));
    }

    [Fact]
    public void MixedForms_EveryDiagnosticCarriesItsOwnReplacement()
    {
        const string source = """
            package P
            func main() {
                var a chan int32 = chan[int32](1)
                var b chan Item = nil
            }
            """;
        var diagnostics = LegacyDiagnostics(source);
        Assert.Equal(2, diagnostics.Length);
        Assert.Contains(diagnostics, d => d.Message.Contains("chan[int32]"));
        Assert.Contains(diagnostics, d => d.Message.Contains("chan[Item]"));
    }

    // --- the retired `make(chan …)` reports GS0566, once, naming the replacement ---

    [Fact]
    public void LegacyMake_ReportsGS0566_NamingTheExactReplacement_AndNotGS0567()
    {
        const string source = """
            package P
            func main() {
                let a = make(chan int32, 3)
                let b = make(chan string)
            }
            """;
        var tree = SyntaxTree.Parse(source);
        var retired = tree.Diagnostics.Where(d => d.Id == "GS0566").ToArray();
        Assert.Equal(2, retired.Length);
        Assert.Empty(tree.Diagnostics.Where(d => d.Id == LegacyDiagnosticId));
        Assert.Empty(tree.Diagnostics.Where(d => d.Id != "GS0566"));

        var buffered = retired.Single(d => d.Message.Contains("make(chan int32, 3)"));
        Assert.Contains("use 'chan[int32](3)' instead", buffered.Message);
        Assert.Equal("make(chan int32, 3)", buffered.Location.Text.ToString(buffered.Location.Span));

        var unbounded = retired.Single(d => d.Message.Contains("make(chan string)"));
        Assert.Contains("'chan[string]()'", unbounded.Message);
        Assert.Contains("'Chan.Unbounded[string]()'", unbounded.Message);
    }
}
