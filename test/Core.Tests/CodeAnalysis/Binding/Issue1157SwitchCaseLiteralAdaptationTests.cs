// <copyright file="Issue1157SwitchCaseLiteralAdaptationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1157: a constant integer LITERAL case label adapts to a narrow /
/// unsigned governing (discriminant) type when its value is representable
/// there — the switch-case-label analogue of the binary-operator constant
/// adaptation restored by #1144. A label that does NOT fit the governing
/// type still errors with GS0171, and non-integer discriminants (string,
/// enum) are unaffected.
/// </summary>
public class Issue1157SwitchCaseLiteralAdaptationTests
{
    // ── The exact repro: switch-EXPRESSION over uint8 ──────────────────

    [Fact]
    public void SwitchExpression_UInt8_LiteralLabelsAdapt_NoDiagnostics()
    {
        var source = Wrap(@"func F(b uint8) int32 {
        return switch b {
            case 0: 10
            case 1: 20
            default: 30
        }
    }");
        Assert.Empty(Errors(source));
    }

    // ── switch-STATEMENT over uint8 routes through the same path ────────

    [Fact]
    public void SwitchStatement_UInt8_LiteralLabelsAdapt_NoDiagnostics()
    {
        var source = Wrap(@"func F(b uint8) {
        switch b {
            case 0 { var a = 1 }
            case 1 { var c = 2 }
            default { var d = 3 }
        }
    }");
        Assert.Empty(Errors(source));
    }

    // ── Other narrow / unsigned governing types ────────────────────────

    [Theory]
    [InlineData("uint8", "0", "1")]
    [InlineData("uint16", "0", "1000")]
    [InlineData("int16", "0", "100")]
    [InlineData("int8", "0", "100")]
    [InlineData("uint32", "0", "40000")]
    [InlineData("uint64", "0", "1")]
    public void SwitchExpression_NarrowGoverningType_FittingLabels_NoDiagnostics(
        string type, string a, string b)
    {
        var source = Wrap(@"func F(v " + type + @") int32 {
        return switch v {
            case " + a + @": 10
            case " + b + @": 20
            default: 30
        }
    }");
        Assert.Empty(Errors(source));
    }

    // ── Negative literal fits int8 but not uint8 ───────────────────────

    [Fact]
    public void SwitchExpression_Int8_NegativeLiteralFits_NoDiagnostics()
    {
        var source = Wrap(@"func F(v int8) int32 {
        return switch v {
            case -1: 10
            default: 30
        }
    }");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void SwitchExpression_UInt8_NegativeLiteralDoesNotFit_GS0171()
    {
        var source = Wrap(@"func F(v uint8) int32 {
        return switch v {
            case -1: 10
            default: 30
        }
    }");
        Assert.Contains(Errors(source), d => d.Id == "GS0171");
    }

    // ── Out-of-range label still errors ────────────────────────────────

    [Fact]
    public void SwitchExpression_UInt8_OutOfRangeLiteral_StillErrorsGS0171()
    {
        var source = Wrap(@"func F(b uint8) int32 {
        return switch b {
            case 300: 10
            default: 30
        }
    }");
        Assert.Contains(Errors(source), d => d.Id == "GS0171");
    }

    // ── Nullable discriminant adapts to underlying then widens ─────────

    [Fact]
    public void SwitchExpression_NullableUInt8_LiteralLabelAdapts_NoDiagnostics()
    {
        var source = Wrap(@"func F(b uint8?) int32 {
        return switch b {
            case 0: 10
            case 1: 20
            default: 30
        }
    }");
        Assert.Empty(Errors(source));
    }

    // ── Non-integer discriminants unaffected ───────────────────────────

    [Fact]
    public void SwitchExpression_String_LiteralLabel_StillWorks()
    {
        var source = Wrap(@"func F(s string) int32 {
        return switch s {
            case ""hi"": 10
            case ""bye"": 20
            default: 30
        }
    }");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void SwitchExpression_Enum_StillWorks()
    {
        var source = @"
package p
enum Color { Red, Green, Blue }
class C {
    func F(c Color) int32 {
        return switch c {
            case Color.Red: 10
            case Color.Green: 20
            default: 30
        }
    }
}
";
        Assert.Empty(Errors(source));
    }

    private static string Wrap(string member)
    {
        return @"
package p
class C {
    " + member + @"
}
";
    }

    private static IReadOnlyList<Diagnostic> Errors(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .ToList();
    }
}
