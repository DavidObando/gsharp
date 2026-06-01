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
/// Phase 1.1: string interpolation. <c>"$ident"</c> and <c>"${expr}"</c>
/// inside an interpreted string literal are lowered by the binder to a
/// chain of <c>+</c> concatenations over string-typed sub-expressions.
/// Non-string expressions are wrapped in <c>.ToString()</c>. <c>$$</c>
/// escapes to a literal <c>$</c>.
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

    private static (ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Diagnostics, System.Collections.Generic.Dictionary<VariableSymbol, object> Variables) Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var vars = new System.Collections.Generic.Dictionary<VariableSymbol, object>();
        var result = compilation.Evaluate(vars);
        return (result.Diagnostics, vars);
    }
}
