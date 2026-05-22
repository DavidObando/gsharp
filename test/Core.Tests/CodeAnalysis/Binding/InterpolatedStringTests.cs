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

    private static (ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Diagnostics, System.Collections.Generic.Dictionary<VariableSymbol, object> Variables) Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var vars = new System.Collections.Generic.Dictionary<VariableSymbol, object>();
        var result = compilation.Evaluate(vars);
        return (result.Diagnostics, vars);
    }
}
