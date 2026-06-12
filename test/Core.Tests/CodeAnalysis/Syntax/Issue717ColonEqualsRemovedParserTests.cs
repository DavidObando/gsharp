// <copyright file="Issue717ColonEqualsRemovedParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #717 / ADR-0077 — the legacy short variable-declaration operator
/// <c>:=</c> has been removed. The lexer still tokenises the operator so the
/// parser can surface a single high-quality <c>GS0305</c> diagnostic at the
/// offending span instead of cascading into a thicket of follow-on parse
/// errors. These tests pin down both the diagnostic surface and the
/// recovery behaviour (every removed form should produce exactly one
/// <c>GS0305</c> diagnostic and let the rest of the file bind cleanly).
/// </summary>
public class Issue717ColonEqualsRemovedParserTests
{
    private const string DiagnosticId = "GS0305";

    private static Diagnostic[] ColonEqualsDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(source);
        return tree.Diagnostics.Where(d => d.Id == DiagnosticId).ToArray();
    }

    [Fact]
    public void StandaloneShortVariableDeclaration_ReportsGS0305()
    {
        const string source = """
            package P
            func main() {
                x := 1
            }
            """;
        var diagnostics = ColonEqualsDiagnostics(source);
        var d = Assert.Single(diagnostics);
        Assert.Contains("':=' short variable declaration has been removed", d.Message);
        Assert.Contains("let x = …", d.Message);
        Assert.Contains("var x = …", d.Message);
        Assert.Contains("ADR-0077", d.Message);
    }

    [Fact]
    public void StandaloneShortVariableDeclaration_SpanCoversColonEqualsToken()
    {
        // `x := 1` — the `:=` token sits at column 5 (1-based) of line 3.
        const string source = """
            package P
            func main() {
                x := 1
            }
            """;
        var diagnostics = ColonEqualsDiagnostics(source);
        var d = Assert.Single(diagnostics);
        var location = d.Location;
        Assert.Equal(":=", location.Text.ToString(location.Span));
    }

    [Fact]
    public void MultipleShortVariableDeclarations_EmitOneDiagnosticPerSite_NoCascade()
    {
        const string source = """
            package P
            func main() {
                a := 1
                b := 2
                c := 3
                var s = a + b + c
            }
            """;
        var diagnostics = ColonEqualsDiagnostics(source);
        Assert.Equal(3, diagnostics.Length);
        // Recovery binds each as a `var`, so the trailing `var s = …` line
        // has every name in scope and produces no further parser diagnostics.
        var tree = SyntaxTree.Parse(source);
        var nonGS0305 = tree.Diagnostics.Where(d => d.Id != DiagnosticId).ToArray();
        Assert.Empty(nonGS0305);
    }

    [Fact]
    public void NestedInBlock_ReportsGS0305()
    {
        const string source = """
            package P
            func main() {
                {
                    x := 1
                }
            }
            """;
        Assert.Single(ColonEqualsDiagnostics(source));
    }

    [Fact]
    public void NestedInLambdaBody_ReportsGS0305()
    {
        const string source = """
            package P
            func main() {
                let f = (n int32) -> {
                    x := n + 1
                    x
                }
                var y = f(2)
            }
            """;
        Assert.Single(ColonEqualsDiagnostics(source));
    }

    [Fact]
    public void NestedInFunctionBody_ReportsGS0305()
    {
        const string source = """
            package P
            func inner() {
                x := 1
            }
            func main() {
                inner()
            }
            """;
        Assert.Single(ColonEqualsDiagnostics(source));
    }

    [Fact]
    public void MultiTargetShortDeclaration_ReportsGS0305()
    {
        const string source = """
            package P
            func main() {
                a, b := 1, 2
                var s = a + b
            }
            """;
        var diagnostics = ColonEqualsDiagnostics(source);
        var d = Assert.Single(diagnostics);
        Assert.Contains("':=' short variable declaration has been removed", d.Message);
        // Recovery treats the operator as `=` and binds the multi-assignment;
        // the targets `a` and `b` end up declared in scope, so the trailing
        // `var s = a + b` finds them.
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics.Where(x => x.Id != DiagnosticId));
    }

    [Fact]
    public void ForRangeWithColonEquals_ReportsGS0305()
    {
        const string source = """
            package P
            func main() {
                let xs = [1, 2, 3]
                for v := range xs {
                    var s = v + 1
                }
            }
            """;
        var diagnostics = ColonEqualsDiagnostics(source);
        var d = Assert.Single(diagnostics);
        Assert.Contains("for v in", d.Message);
    }

    [Fact]
    public void ForKVRangeWithColonEquals_ReportsGS0305()
    {
        const string source = """
            package P
            func main() {
                let xs = [10, 20, 30]
                for i, v := range xs {
                    var s = i + v
                }
            }
            """;
        var diagnostics = ColonEqualsDiagnostics(source);
        var d = Assert.Single(diagnostics);
        Assert.Contains("for i, v in", d.Message);
    }

    [Fact]
    public void ForEllipsisWithColonEquals_ReportsGS0305()
    {
        const string source = """
            package P
            func main() {
                for i := 0 ... 3 {
                    var s = i
                }
            }
            """;
        var diagnostics = ColonEqualsDiagnostics(source);
        var d = Assert.Single(diagnostics);
        Assert.Contains("for i in lo ... hi", d.Message);
    }

    [Fact]
    public void ForClauseInitWithColonEquals_ReportsGS0305()
    {
        const string source = """
            package P
            func main() {
                for i := 0; i < 3; i++ {
                    var s = i
                }
            }
            """;
        var diagnostics = ColonEqualsDiagnostics(source);
        var d = Assert.Single(diagnostics);
        Assert.Contains("let i = …", d.Message);
        Assert.Contains("var i = …", d.Message);
    }

    [Fact]
    public void IfInitWithColonEquals_ReportsGS0305()
    {
        const string source = """
            package P
            func main() {
                if x := 1; x > 0 {
                    var y = x
                }
            }
            """;
        var diagnostics = ColonEqualsDiagnostics(source);
        Assert.Single(diagnostics);
    }

    [Fact]
    public void AwaitForRangeWithColonEquals_ReportsGS0305()
    {
        const string source = """
            package P
            import System.Collections.Generic
            async func main() {
                await for v := range Stream() {
                    var s = v
                }
            }
            async func Stream() async sequence[int32] {
                yield 1
            }
            """;
        var diagnostics = ColonEqualsDiagnostics(source);
        var d = Assert.Single(diagnostics);
        Assert.Contains("await for v in", d.Message);
    }

    [Fact]
    public void SelectCaseBindWithColonEquals_ReportsGS0305()
    {
        const string source = """
            package P
            func main() {
                let ch = chan(int32)(1)
                go func () {
                    ch <- 1
                }()
                select {
                    case v := <-ch {
                        var s = v
                    }
                }
            }
            """;
        var diagnostics = ColonEqualsDiagnostics(source);
        var d = Assert.Single(diagnostics);
        Assert.Contains("case let v = <-ch", d.Message);
    }

    [Fact]
    public void CanonicalForms_DoNotReportGS0305()
    {
        const string source = """
            package P
            func main() {
                let x = 1
                var y = 2
                let xs = [1, 2, 3]
                for v in xs {
                    var s = v
                }
                for i in 0 ... 3 {
                    var s = i
                }
                for var k = 0; k < 3; k++ {
                    var s = k
                }
                if var z = 1; z > 0 {
                    var s = z
                }
            }
            """;
        Assert.Empty(ColonEqualsDiagnostics(source));
    }

    [Fact]
    public void LexerStillTokenisesColonEquals_SoDiagnosticsTargetTheToken()
    {
        // Confirm the lexer still emits a ColonEqualsToken even though the
        // parser hard-rejects every use. Without this guarantee the parser
        // diagnostic would degrade to a generic "unexpected `:`" error.
        var tokens = SyntaxTree.ParseTokens(":=")
            .Where(t => t.Kind != SyntaxKind.EndOfFileToken && t.Kind != SyntaxKind.WhitespaceToken)
            .ToArray();
        var token = Assert.Single(tokens);
        Assert.Equal(SyntaxKind.ColonEqualsToken, token.Kind);
        Assert.Equal(":=", token.Text);
    }
}
