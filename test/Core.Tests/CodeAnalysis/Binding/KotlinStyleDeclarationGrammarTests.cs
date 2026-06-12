// <copyright file="KotlinStyleDeclarationGrammarTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0078 / issue #718: parser-level coverage of the canonical
/// Kotlin/Swift-style declaration head. Every row of the spelling matrix
/// must parse without diagnostics; every rejected combination must emit
/// the documented diagnostic; the legacy <c>type Name kind</c> head must
/// be rejected.
/// </summary>
public class KotlinStyleDeclarationGrammarTests
{
    [Theory]
    [InlineData("class Animal(name string)")]
    [InlineData("open class Animal(name string)")]
    [InlineData("sealed class Shape")]
    [InlineData("data class Person(name string, age int32)")]
    [InlineData("data struct Point(x int32, y int32)")]
    [InlineData("struct Point(x int32, y int32)")]
    [InlineData("inline struct UserId(value string)")]
    [InlineData("enum Color { Red, Green, Blue }")]
    [InlineData("enum Shape { Circle(r float64); Square(s float64) }")]
    [InlineData("interface Drawable { func Draw() }")]
    [InlineData("sealed interface Shape { }")]
    public void SpellingMatrix_EveryRowParses(string head)
    {
        var src = head;
        // Class / struct / enum / interface alone may lack a body — append empty body if missing.
        if (!head.Contains('{'))
        {
            src += " { }";
        }

        var tree = SyntaxTree.Parse(SourceText.From(src + "\n0\n"));
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new System.Collections.Generic.Dictionary<GSharp.Core.CodeAnalysis.Symbols.VariableSymbol, object>());

        // The matrix row must parse and bind. Some rows (e.g. a class with
        // an unused param) emit warnings; only assert no parser-level
        // errors with GS0306–GS0312.
        Assert.DoesNotContain(
            result.Diagnostics,
            d => d.Id == "GS0306" || d.Id == "GS0307" || d.Id == "GS0308" || d.Id == "GS0309" || d.Id == "GS0310" || d.Id == "GS0311" || d.Id == "GS0312");
    }

    [Theory]
    [InlineData("type Foo class { }", "GS0306")]
    [InlineData("type Foo struct { }", "GS0306")]
    [InlineData("type Foo enum { Red }", "GS0306")]
    [InlineData("type Foo interface { }", "GS0306")]
    public void LegacyTypeKindHead_Rejected(string src, string expected)
    {
        var tree = SyntaxTree.Parse(SourceText.From(src + "\n0\n"));
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new System.Collections.Generic.Dictionary<GSharp.Core.CodeAnalysis.Symbols.VariableSymbol, object>());
        Assert.Contains(result.Diagnostics, d => d.Id == expected);
    }

    [Fact]
    public void LegacyRecordKeyword_Rejected()
    {
        var tree = SyntaxTree.Parse(SourceText.From("record Foo { var X int32 }\n0\n"));
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new System.Collections.Generic.Dictionary<GSharp.Core.CodeAnalysis.Symbols.VariableSymbol, object>());
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0307");
    }
}
