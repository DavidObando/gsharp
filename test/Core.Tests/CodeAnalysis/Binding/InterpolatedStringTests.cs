// <copyright file="InterpolatedStringTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 1.1 / ADR-0055: string interpolation. <c>"$ident"</c> and
/// <c>"${expr,alignment:format}"</c> inside an interpreted string literal bind
/// to a dedicated <see cref="BoundInterpolatedStringExpression"/> (static type
/// <c>string</c>) carrying ordered literal/hole parts. The tree-walk
/// interpreter renders the node directly via composite formatting; the IL
/// emitter lowers it to the <c>DefaultInterpolatedStringHandler</c> pattern.
/// <c>$$</c> escapes to a literal <c>$</c>.
/// </summary>
public class InterpolatedStringTests
{
    [Fact]
    public void Plain_String_Without_Dollar_Stays_StringToken()
    {
        var tokens = SyntaxTree.ParseTokens("\"hello\"").ToArray();
        Assert.Equal(SyntaxKind.StringToken, tokens[0].Kind);
    }

    [Fact]
    public void Dollar_Identifier_Produces_InterpolatedStringToken()
    {
        var tokens = SyntaxTree.ParseTokens("\"hi $name\"").ToArray();
        Assert.Equal(SyntaxKind.InterpolatedStringToken, tokens[0].Kind);
    }

    [Fact]
    public void Dollar_Brace_Produces_InterpolatedStringToken()
    {
        var tokens = SyntaxTree.ParseTokens("\"sum=${1 + 2}\"").ToArray();
        Assert.Equal(SyntaxKind.InterpolatedStringToken, tokens[0].Kind);
    }

    [Fact]
    public void Double_Dollar_Escapes_To_Literal()
    {
        var tokens = SyntaxTree.ParseTokens("\"$$cost\"").ToArray();
        Assert.Equal(SyntaxKind.StringToken, tokens[0].Kind);
        Assert.Equal("$cost", tokens[0].Value);
    }

    [Fact]
    public void Interpolation_Of_String_Variable_Evaluates()
    {
        var source = "let name = \"world\"\nlet msg = \"hello $name\"\n";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        var msg = result.Variables.Single(kv => kv.Key.Name == "msg");
        Assert.Equal("hello world", msg.Value);
    }

    [Fact]
    public void Interpolation_Of_Int_Variable_Uses_ToString()
    {
        var source = "let n = 42\nlet msg = \"answer=$n\"\n";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        var msg = result.Variables.Single(kv => kv.Key.Name == "msg");
        Assert.Equal("answer=42", msg.Value);
    }

    [Fact]
    public void Brace_Interpolation_Of_Arithmetic()
    {
        var source = "let msg = \"sum=${1 + 2}\"\n";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        var msg = result.Variables.Single(kv => kv.Key.Name == "msg");
        Assert.Equal("sum=3", msg.Value);
    }

    [Fact]
    public void Multiple_Interpolations_Concatenate_In_Order()
    {
        var source = "let a = 1\nlet b = 2\nlet msg = \"$a + $b = ${a + b}\"\n";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        var msg = result.Variables.Single(kv => kv.Key.Name == "msg");
        Assert.Equal("1 + 2 = 3", msg.Value);
    }

    [Fact]
    public void Binder_Produces_InterpolatedStringExpression_Node()
    {
        var tree = SyntaxTree.Parse(SourceText.From("let x = 1\nlet msg = \"hi $x\"\n", "test"));
        var compilation = new Compilation(tree);
        var declaration = compilation.GlobalScope.Statements
            .OfType<BoundVariableDeclaration>()
            .Single(d => d.Variable.Name == "msg");
        Assert.IsType<BoundInterpolatedStringExpression>(declaration.Initializer);
        Assert.Equal(TypeSymbol.String, declaration.Initializer.Type);
    }

    [Fact]
    public void Interpolation_Hex_Format_Specifier_Renders()
    {
        // 255 -> "00FF" via the X4 format specifier (culture-independent).
        var source = "let n = 255\nlet msg = \"${n:X4}\"\n";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        var msg = result.Variables.Single(kv => kv.Key.Name == "msg");
        Assert.Equal("00FF", msg.Value);
    }

    [Fact]
    public void Interpolation_Positive_Alignment_Right_Justifies()
    {
        var source = "let s = \"hi\"\nlet msg = \"[${s,5}]\"\n";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        var msg = result.Variables.Single(kv => kv.Key.Name == "msg");
        Assert.Equal("[   hi]", msg.Value);
    }

    [Fact]
    public void Interpolation_Negative_Alignment_Left_Justifies()
    {
        var source = "let s = \"hi\"\nlet msg = \"[${s,-5}]\"\n";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        var msg = result.Variables.Single(kv => kv.Key.Name == "msg");
        Assert.Equal("[hi   ]", msg.Value);
    }

    [Fact]
    public void Interpolation_Alignment_And_Format_Combined()
    {
        var source = "let n = 255\nlet msg = \"[${n,6:X2}]\"\n";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        var msg = result.Variables.Single(kv => kv.Key.Name == "msg");
        Assert.Equal("[    FF]", msg.Value);
    }

    [Fact]
    public void Interpolation_Hole_Containing_Parenthesized_Call_Is_Not_Mis_Split()
    {
        // The delimiter-aware splitter must not treat the `()` or any inner
        // punctuation of `n.GetType()` as an alignment/format delimiter.
        var source = "let n = 1\nlet msg = \"${n.GetType()}\"\n";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        var msg = result.Variables.Single(kv => kv.Key.Name == "msg");
        Assert.Equal("System.Int32", msg.Value);
    }

    [Fact]
    public void Format_Specifier_On_String_Path_Uses_String_Format()
    {
        // ADR-0055 Tier 2: a `:format` clause in a plain (string-typed)
        // interpolation lowers to String.Format with the composite format
        // string, honoring the format specifier.
        var source = "let total = 1234.5\nlet msg = \"amount: ${total:N2}\"\n";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        var msg = result.Variables.Single(kv => kv.Key.Name == "msg");
        Assert.Equal("amount: " + (1234.5).ToString("N2", System.Globalization.CultureInfo.CurrentCulture), msg.Value);
    }

    [Fact]
    public void Alignment_Specifier_On_String_Path_Pads()
    {
        var source = "let name = \"Acme\"\nlet msg = \"[${name,8}][${name,-8}]\"\n";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        var msg = result.Variables.Single(kv => kv.Key.Name == "msg");
        Assert.Equal("[    Acme][Acme    ]", msg.Value);
    }

    [Fact]
    public void FormattableString_Target_Produces_FormattableString()
    {
        // ADR-0055 Tier 4: the contextual target type FormattableString lowers
        // to FormattableStringFactory.Create, producing a real
        // System.FormattableString rather than an eager string.
        var source = "let total = 1234.5\nlet fs FormattableString = \"amount: ${total:N2}\"\n";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        var fs = result.Variables.Single(kv => kv.Key.Name == "fs").Value;
        Assert.IsAssignableFrom<System.FormattableString>(fs);
    }

    [Fact]
    public void FormattableString_Defers_Culture_To_Caller()
    {
        // Deferred ToString(IFormatProvider) honors the caller-supplied culture:
        // the same FormattableString renders differently under invariant vs de-DE.
        var source = "let total = 1234.5\nlet fs FormattableString = \"amount: ${total:N2}\"\n";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        var fs = (System.FormattableString)result.Variables.Single(kv => kv.Key.Name == "fs").Value;

        Assert.Equal("amount: 1,234.50", fs.ToString(System.Globalization.CultureInfo.InvariantCulture));
        Assert.Equal("amount: 1.234,50", fs.ToString(System.Globalization.CultureInfo.GetCultureInfo("de-DE")));
    }

    [Fact]
    public void FormattableString_Preserves_Composite_Format()
    {
        // The synthesized composite format string keeps positional indices,
        // alignment, and the format specifier intact.
        var source = "let total = 1234.5\nlet qty = 7\nlet fs FormattableString = \"a ${total:N2} b ${qty,4} c\"\n";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        var fs = (System.FormattableString)result.Variables.Single(kv => kv.Key.Name == "fs").Value;

        Assert.Equal("a {0:N2} b {1,4} c", fs.Format);
        Assert.Equal(2, fs.ArgumentCount);
        Assert.Equal("a 1,234.50 b    7 c", fs.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    [Fact]
    public void IFormattable_Target_Produces_Formattable_Value()
    {
        var source = "let n = 42\nlet f IFormattable = \"n=${n:D3}\"\n";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        var f = result.Variables.Single(kv => kv.Key.Name == "f").Value;
        Assert.IsAssignableFrom<System.IFormattable>(f);
        Assert.Equal("n=042", ((System.IFormattable)f).ToString(null, System.Globalization.CultureInfo.InvariantCulture));
    }

    [Fact]
    public void Argument_To_FormattableString_Parameter_Lowers_To_Formattable()
    {
        // ADR-0055 Tier 4 (#369): an interpolated string passed directly as a
        // call argument whose parameter type is FormattableString is re-lowered
        // to FormattableStringFactory.Create, so the callee receives a real
        // FormattableString and can defer the culture choice.
        var source =
            "import System.Globalization\n" +
            "func render(fs FormattableString) string {\n" +
            "    return fs.ToString(CultureInfo.GetCultureInfo(\"de-DE\"))\n" +
            "}\n" +
            "let total = 1234.5\n" +
            "let msg = render(\"amount: ${total:N2}\")\n";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        var msg = result.Variables.Single(kv => kv.Key.Name == "msg").Value;
        Assert.Equal("amount: 1.234,50", msg);
    }

    [Fact]
    public void Argument_To_IFormattable_Parameter_Lowers_To_Formattable()
    {
        // The same relaxation applies when the parameter type is IFormattable.
        // The function simply returns the value so the lowering can be inspected
        // from the host without relying on in-language interface dispatch.
        var source =
            "func render(f IFormattable) IFormattable {\n" +
            "    return f\n" +
            "}\n" +
            "let n = 42\n" +
            "let msg = render(\"n=${n:D3}\")\n";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        var msg = result.Variables.Single(kv => kv.Key.Name == "msg").Value;
        Assert.IsAssignableFrom<System.IFormattable>(msg);
        Assert.Equal("n=042", ((System.IFormattable)msg).ToString(null, System.Globalization.CultureInfo.InvariantCulture));
    }

    [Fact]
    public void Argument_To_String_Parameter_Stays_String()
    {
        // A plain `string` parameter must continue to receive an eager string —
        // the Tier 4 relaxation only fires for IFormattable/FormattableString
        // targets, never displacing the interpolation's natural `string` type.
        var source =
            "func echo(s string) string {\n" +
            "    return s\n" +
            "}\n" +
            "let total = 1234.5\n" +
            "let msg = echo(\"amount: ${total:N2}\")\n";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        var msg = result.Variables.Single(kv => kv.Key.Name == "msg").Value;
        Assert.IsType<string>(msg);
        Assert.Equal("amount: " + (1234.5).ToString("N2", System.Globalization.CultureInfo.CurrentCulture), msg);
    }

    [Fact]
    public void Overload_Prefers_String_Parameter_Over_FormattableString()
    {
        // When a method exposes both a string and a FormattableString overload,
        // an interpolated-string argument binds to the string overload (the
        // identity conversion of its natural type), mirroring C#. Here
        // string.Format(string, object) is chosen over any FormattableString
        // path, producing an eager string.
        var source =
            "let total = 1234.5\n" +
            "let msg = render(\"x\")\n" +
            "func render(s string) string {\n" +
            "    return s\n" +
            "}\n";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        var msg = result.Variables.Single(kv => kv.Key.Name == "msg").Value;
        Assert.IsType<string>(msg);
        Assert.Equal("x", msg);
    }

    [Fact]
    public void Imported_Static_Call_FormattableString_Argument_Lowers()
    {
        // ADR-0055 Tier 4 (#369): overload resolution against an imported static
        // method accepts an interpolated string for a FormattableString
        // parameter. FormattableString.Invariant(FormattableString) formats with
        // the invariant culture regardless of the ambient culture.
        var source =
            "import System\n" +
            "let total = 1234.5\n" +
            "let msg = FormattableString.Invariant(\"amount: ${total:N2}\")\n";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        var msg = result.Variables.Single(kv => kv.Key.Name == "msg").Value;
        Assert.Equal("amount: 1,234.50", msg);
    }

    [Fact]
    public void Nested_String_In_Hole_Lexes_As_Single_Interpolated_Token()
    {
        // ADR-0055 §A: the delimiter-aware lexer scanner must not terminate the
        // hole at the nested string's quote.
        var tokens = SyntaxTree.ParseTokens("\"x=${\"inner\"}\"").ToArray();
        Assert.Equal(SyntaxKind.InterpolatedStringToken, tokens[0].Kind);
    }

    [Fact]
    public void Nested_String_Literal_In_Hole_Evaluates()
    {
        var source = "let msg = \"x=${\"inner\"}\"\n";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        var msg = result.Variables.Single(kv => kv.Key.Name == "msg");
        Assert.Equal("x=inner", msg.Value);
    }

    [Fact]
    public void Comma_And_Colon_Inside_Nested_String_Are_Not_Clause_Delimiters()
    {
        // The `,` and `:` live inside a nested string literal, so they must not
        // be mistaken for the alignment/format clauses of the hole.
        var source = "let msg = \"${\"a,b:c\".Length}\"\n";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        var msg = result.Variables.Single(kv => kv.Key.Name == "msg");
        Assert.Equal("5", msg.Value);
    }

    [Fact]
    public void Multiline_Hole_Is_Allowed()
    {
        // ADR-0055 §A: a `${ … }` hole may span newlines (C# 11 parity).
        var source = "let msg = \"sum=${1 +\n2}\"\n";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        var msg = result.Variables.Single(kv => kv.Key.Name == "msg");
        Assert.Equal("sum=3", msg.Value);
    }

    [Fact]
    public void Empty_Hole_Reports_GS0223()
    {
        var diagnostics = GetDiagnostics("let msg = \"x=${}\"\n");
        Assert.Contains(diagnostics, d => d.Id == "GS0223");
    }

    [Fact]
    public void Empty_Format_Specifier_Reports_GS0224()
    {
        var diagnostics = GetDiagnostics("let n = 1\nlet msg = \"x=${n:}\"\n");
        Assert.Contains(diagnostics, d => d.Id == "GS0224");
    }

    [Fact]
    public void Unterminated_Hole_Reports_GS0222()
    {
        var diagnostics = GetDiagnostics("let msg = \"x=${1 + 2\"\n");
        Assert.Contains(diagnostics, d => d.Id == "GS0222");
    }

    [Fact]
    public void Newline_In_Literal_Portion_Reports_GS0225()
    {
        // The newline is in the literal text *after* a hole, so the lexer knows
        // it is in an interpolated string and reports the specific code.
        var diagnostics = GetDiagnostics("let x = 1\nlet msg = \"a${x}b\nc\"\n");
        Assert.Contains(diagnostics, d => d.Id == "GS0225");
    }

    private static ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return tree.Diagnostics;
    }

    [Fact]
    public void Hole_Diagnostic_Span_Maps_To_True_Source_Location()
    {
        // ADR-0055 §C: a diagnostic raised on an expression inside a hole must
        // point at the expression's true offset in the outer file, not at the
        // whole string token (or offset 0).
        var source = "let x = 1\nlet msg = \"val=${undefinedThing}\"\n";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var vars = new System.Collections.Generic.Dictionary<VariableSymbol, object>();
        var result = compilation.Evaluate(vars);

        var expectedStart = source.IndexOf("undefinedThing", System.StringComparison.Ordinal);
        var diagnostic = Assert.Single(result.Diagnostics, d => d.Location.Span.Start == expectedStart);
        Assert.Equal("undefinedThing".Length, diagnostic.Location.Span.Length);
    }

    [Fact]
    public void Hole_Diagnostic_On_Later_Line_Reports_True_Line_Number()
    {
        // Issue #1605: the hole is now re-lexed directly out of the outer text
        // (no padded-copy re-parse), so the line/column must still come out
        // right for a hole many lines into the file.
        var source = string.Concat(System.Linq.Enumerable.Repeat("let a = 1\n", 20))
            + "let msg = \"val=${undefinedThing}\"\n";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var vars = new System.Collections.Generic.Dictionary<VariableSymbol, object>();
        var result = compilation.Evaluate(vars);

        var expectedStart = source.IndexOf("undefinedThing", System.StringComparison.Ordinal);
        var diagnostic = Assert.Single(result.Diagnostics, d => d.Location.Span.Start == expectedStart);
        Assert.Equal(20, diagnostic.Location.StartLine);
    }

    [Fact]
    public void Many_Interpolation_Holes_Parse_Near_Linear_Time()
    {
        // Issue #1605: each hole used to re-lex/re-parse a padded copy of the
        // whole file prefix seen so far (O(fileSize) per hole => O(n^2)
        // total). Doubling the hole count should now roughly double the
        // parse time, not quadruple it.
        static string BuildSource(int holeCount)
        {
            var sb = new System.Text.StringBuilder();
            for (var i = 0; i < holeCount; i++)
            {
                sb.Append("let v").Append(i).Append(" = \"prefix ${").Append(i).Append("} suffix\"\n");
            }

            return sb.ToString();
        }

        static long TimeParse(string source)
        {
            // Warm up JIT once before timing.
            SyntaxTree.Parse(SourceText.From(source));

            // Take the best (minimum) of several runs. Minimum is the least
            // noisy statistic for wall-clock microbenchmarks: it excludes GC
            // pauses and scheduler preemption spikes that otherwise make a
            // single-shot ratio flaky on shared CI hardware.
            var best = long.MaxValue;
            for (var i = 0; i < 7; i++)
            {
                var sw = System.Diagnostics.Stopwatch.StartNew();
                SyntaxTree.Parse(SourceText.From(source));
                sw.Stop();
                if (sw.ElapsedTicks < best)
                {
                    best = sw.ElapsedTicks;
                }
            }

            // Floor the denominator so an anomalously fast small sample can't
            // blow up the ratio.
            return System.Math.Max(best, 1);
        }

        var small = TimeParse(BuildSource(500));
        var large = TimeParse(BuildSource(4000)); // 8x the holes/text

        // Quadratic behavior would show ~64x growth; near-linear should stay
        // well under that. Generous bound to avoid flakiness on shared CI
        // hardware while still catching a regression back to O(n^2).
        Assert.True(large < small * 30, $"expected near-linear scaling, got small={small} large={large} ratio={(double)large / small}");
    }

    private static (ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Diagnostics, System.Collections.Generic.Dictionary<VariableSymbol, object> Variables) Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var vars = new System.Collections.Generic.Dictionary<VariableSymbol, object>();
        var result = compilation.Evaluate(vars);
        return (result.Diagnostics, vars);
    }
}
