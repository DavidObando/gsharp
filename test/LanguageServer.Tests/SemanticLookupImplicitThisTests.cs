// <copyright file="SemanticLookupImplicitThisTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// Coverage for implicit-this member resolution in <c>SemanticLookup</c>. The binder treats a
/// bare identifier inside a class/struct method body as <c>this.&lt;identifier&gt;</c>; the
/// language-server-side resolver has to mirror that so navigation, hover, find-references,
/// rename, and CodeLens reference counts agree with the binder. PRs #412 and #413 introduced
/// the implicit-this binder behaviour but only patched hover, leaving every other consumer
/// silently dropping these usages.
/// </summary>
public class SemanticLookupImplicitThisTests
{
    [Fact]
    public void BareProperty_InsideMethodBody_ResolvesToProperty()
    {
        var sym = ResolveBareName(
            "class Person {\n    public prop Name string\n    func Get() string { return Name }\n}\n",
            useOffsetOfNthOccurrence: 2);

        Assert.IsType<PropertySymbol>(sym);
        Assert.Equal("Name", sym.Name);
    }

    [Fact]
    public void BareProperty_InsideInterpolationHole_ResolvesToProperty()
    {
        var sym = ResolveBareName(
            "class Person {\n    public prop Name string\n    func Greet() string { return \"Hi ${Name}\" }\n}\n",
            useOffsetOfNthOccurrence: 2);

        Assert.IsType<PropertySymbol>(sym);
        Assert.Equal("Name", sym.Name);
    }

    [Fact]
    public void BareField_InsideMethodBody_ResolvesToField()
    {
        var sym = ResolveBareName(
            "class Counter {\n    var Value int32\n    func Read() int32 { return Value }\n}\n",
            tokenText: "Value",
            useOffsetOfNthOccurrence: 2);

        Assert.IsType<FieldSymbol>(sym);
        Assert.Equal("Value", sym.Name);
    }

    [Fact]
    public void BareMethod_InsideMethodBody_ResolvesToMethod()
    {
        var sym = ResolveBareName(
            "class Person {\n    func Helper() int32 { return 1 }\n    func Use() int32 { return Helper() }\n}\n",
            tokenText: "Helper",
            useOffsetOfNthOccurrence: 2);

        Assert.IsType<FunctionSymbol>(sym);
        Assert.Equal("Helper", sym.Name);
    }

    [Fact]
    public void FindReferences_OnProperty_IncludesImplicitThisUses()
    {
        const string source = "class Person {\n    public prop Name string\n    func A() string { return Name }\n    func B() string { return \"v: ${Name}\" }\n    func C() string { return this.Name }\n}\n";

        var tree = SyntaxTree.Parse(GSharp.Core.CodeAnalysis.Text.SourceText.From(source));
        var compilation = new Compilation(tree);

        var declarationToken = FirstIdentifierAt(tree, "Name", occurrence: 1);
        var property = SemanticLookup.ResolveSymbol(compilation, declarationToken);
        Assert.NotNull(property);

        var references = SemanticLookup.FindReferences(compilation, property).ToList();

        // Declaration + return Name + ${Name} + this.Name = 4
        Assert.Equal(4, references.Count);
    }

    [Fact]
    public void BareMemberName_OutsideMethodBody_DoesNotResolveToMember()
    {
        // The bare `Name` in the field initializer position is not inside a method body,
        // so implicit-this resolution must not kick in there.
        const string source = "class Person {\n    public prop Name string\n}\nfunc main() { var x = Name }\n";

        var tree = SyntaxTree.Parse(GSharp.Core.CodeAnalysis.Text.SourceText.From(source));
        var compilation = new Compilation(tree);

        var topLevelUse = FirstIdentifierAt(tree, "Name", occurrence: 2);
        var sym = SemanticLookup.ResolveSymbol(compilation, topLevelUse);

        Assert.False(sym is PropertySymbol, "Bare Name outside any method body must not resolve to the property as implicit-this.");
    }

    private static Symbol ResolveBareName(string body, int useOffsetOfNthOccurrence, string tokenText = "Name")
    {
        const string preamble = "package Temp\n\n";
        var source = preamble + body;
        var tree = SyntaxTree.Parse(GSharp.Core.CodeAnalysis.Text.SourceText.From(source));
        var compilation = new Compilation(tree);

        var token = FirstIdentifierAt(tree, tokenText, occurrence: useOffsetOfNthOccurrence);
        Assert.NotNull(token);
        return SemanticLookup.ResolveSymbol(compilation, token);
    }

    private static SyntaxToken FirstIdentifierAt(SyntaxTree tree, string text, int occurrence)
    {
        var seen = 0;
        foreach (var token in EnumerateTokens(tree.Root))
        {
            if (token.Kind == SyntaxKind.IdentifierToken && token.Text == text)
            {
                seen++;
                if (seen == occurrence)
                {
                    return token;
                }
            }
        }

        return null;
    }

    private static IEnumerable<SyntaxToken> EnumerateTokens(SyntaxNode node)
    {
        if (node is SyntaxToken token)
        {
            yield return token;
            yield break;
        }

        foreach (var child in node.GetChildren())
        {
            foreach (var inner in EnumerateTokens(child))
            {
                yield return inner;
            }
        }
    }
}
