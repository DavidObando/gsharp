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

    private static (ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Diagnostics, System.Collections.Generic.Dictionary<VariableSymbol, object> Variables) Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var vars = new System.Collections.Generic.Dictionary<VariableSymbol, object>();
        var result = compilation.Evaluate(vars);
        return (result.Diagnostics, vars);
    }
}
