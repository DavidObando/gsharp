// <copyright file="SemanticLookupMemberAccessTests.cs" company="GSharp">
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
/// Coverage for member-access resolution in <c>SemanticLookup</c>:
/// <c>receiver.Member</c> on user-declared structs/classes/enums, and on Go-style
/// receiver-clause methods. The previous resolver routed these tokens through
/// by-name local/global lookups, which silently returned null for instance members
/// (no name-based fallback exists for fields, properties, methods, or events).
/// FindReferences therefore under-counted, and CodeLens showed "0 references" on
/// types whose members were actually used.
/// </summary>
public class SemanticLookupMemberAccessTests
{
    [Fact]
    public void InstanceProperty_AccessedViaLocal_ResolvesAndIsCounted()
    {
        const string source = "type Person class {\n    public prop Name string\n}\nfunc Main() {\n    var p = Person{}\n    p.Name = \"a\"\n    var q = p.Name\n}\n";
        var (compilation, tree) = Compile(source);

        var nameInWrite = IdentifierAt(tree, "Name", occurrence: 2);
        var nameInRead = IdentifierAt(tree, "Name", occurrence: 3);

        Assert.IsType<PropertySymbol>(SemanticLookup.ResolveSymbol(compilation, nameInWrite));
        Assert.IsType<PropertySymbol>(SemanticLookup.ResolveSymbol(compilation, nameInRead));

        var declaration = IdentifierAt(tree, "Name", occurrence: 1);
        var property = SemanticLookup.ResolveSymbol(compilation, declaration);
        var refs = SemanticLookup.FindReferences(compilation, property).ToList();
        Assert.Equal(3, refs.Count); // decl + write + read
    }

    [Fact]
    public void InstanceProperty_AccessedInsideInterpolationHole_Resolves()
    {
        const string source = "type Person class {\n    public prop Name string\n}\nfunc Main() {\n    var p = Person{}\n    var s = \"hi ${p.Name}\"\n}\n";
        var (compilation, tree) = Compile(source);

        var nameInHole = IdentifierAt(tree, "Name", occurrence: 2);
        Assert.IsType<PropertySymbol>(SemanticLookup.ResolveSymbol(compilation, nameInHole));
    }

    [Fact]
    public void ChainedMemberAccess_ResolvesInnerSegment()
    {
        const string source = "type Inner class {\n    public prop Value int32\n}\ntype Outer class {\n    public prop In Inner\n}\nfunc Main() {\n    var o = Outer{}\n    var v = o.In.Value\n}\n";
        var (compilation, tree) = Compile(source);

        // `Value` after the `In.` segment
        var valueAccess = IdentifierAt(tree, "Value", occurrence: 2);
        var resolved = SemanticLookup.ResolveSymbol(compilation, valueAccess);
        Assert.IsType<PropertySymbol>(resolved);
        Assert.Equal("Value", resolved.Name);
    }

    [Fact]
    public void EnumMemberAccess_StillResolvesAfterMemberAccessRewrite()
    {
        // Regression: when ResolveAsMemberAccess was added it short-circuited
        // by-name fallbacks. Enum members live in `globals` by name, so the
        // receiver-typed lookup must also handle EnumSymbol receivers — otherwise
        // existing `Color.Red`-style lenses regressed to "0 references".
        const string source = "type Color enum {\n    Red,\n    Green\n}\nvar a = Color.Red\nvar b = Color.Red\nvar c = Color.Green\n";
        var (compilation, tree) = Compile(source);

        var redUse = IdentifierAt(tree, "Red", occurrence: 2);
        var resolved = SemanticLookup.ResolveSymbol(compilation, redUse);
        Assert.IsType<EnumMemberSymbol>(resolved);
    }

    [Fact]
    public void GoStyleReceiver_ExplicitMemberAccess_Resolves()
    {
        const string source = "type Person class {\n    public prop Name string\n}\nfunc (r Person) Greet() string { return r.Name }\nfunc Main() {\n    var x = Person{}\n    x.Name = \"a\"\n}\n";
        var (compilation, tree) = Compile(source);

        // r.Name inside the Go-style receiver method
        var nameInBody = IdentifierAt(tree, "Name", occurrence: 2);
        Assert.IsType<PropertySymbol>(SemanticLookup.ResolveSymbol(compilation, nameInBody));

        var declaration = IdentifierAt(tree, "Name", occurrence: 1);
        var property = SemanticLookup.ResolveSymbol(compilation, declaration);
        var refs = SemanticLookup.FindReferences(compilation, property).ToList();
        Assert.Equal(3, refs.Count); // decl + r.Name + x.Name
    }

    [Fact]
    public void GoStyleReceiver_ReceiverParameter_ResolvesToParameter()
    {
        const string source = "type Person class {\n    public prop Name string\n}\nfunc (r Person) Use() string { return r.Name }\n";
        var (compilation, tree) = Compile(source);

        // The `r` in `r.Name`
        var receiverUse = IdentifierAt(tree, "r", occurrence: 2);
        var resolved = SemanticLookup.ResolveSymbol(compilation, receiverUse);
        Assert.IsType<ParameterSymbol>(resolved);
        Assert.Equal("r", resolved.Name);
    }

    [Fact]
    public void GoStyleReceiver_DoesNotTriggerImplicitThis()
    {
        // Inside a Go-style receiver method, a bare member name must NOT resolve
        // to a receiver member (the language requires an explicit `r.Member`).
        // Otherwise IDE features would offer fake references the binder doesn't agree with.
        const string source = "type Person class {\n    public prop Name string\n}\nfunc (r Person) Bad() string { return Name }\n";
        var (compilation, tree) = Compile(source);

        var bareNameUse = IdentifierAt(tree, "Name", occurrence: 2);
        var resolved = SemanticLookup.ResolveSymbol(compilation, bareNameUse);
        Assert.False(
            resolved is PropertySymbol,
            "Bare member name inside a Go-style receiver method must not implicit-this-resolve to a receiver member.");
    }

    [Fact]
    public void FieldAssignment_FieldIdentifier_Resolves()
    {
        const string source = "type Counter class {\n    Value int32\n}\nfunc Main() {\n    var c = Counter{}\n    c.Value = 1\n}\n";
        var (compilation, tree) = Compile(source);

        var valueInAssignment = IdentifierAt(tree, "Value", occurrence: 2);
        var resolved = SemanticLookup.ResolveSymbol(compilation, valueInAssignment);
        Assert.IsType<FieldSymbol>(resolved);
        Assert.Equal("Value", resolved.Name);
    }

    [Fact]
    public void MemberName_NotShadowedByGlobalOfSameName()
    {
        // A top-level `Name` global must not be the resolution of `p.Name`.
        const string source = "type Person class {\n    public prop Name string\n}\nvar Name = \"global\"\nfunc Main() {\n    var p = Person{}\n    var q = p.Name\n}\n";
        var (compilation, tree) = Compile(source);

        var memberAccess = IdentifierAt(tree, "Name", occurrence: 2); // declaration is 1, top-level var is also "Name"... use occurrence 3 to be safe
        // The third `Name` token is the `p.Name` access (after the property decl and the global var decl).
        var pName = IdentifierAt(tree, "Name", occurrence: 3);
        var resolved = SemanticLookup.ResolveSymbol(compilation, pName);

        Assert.IsType<PropertySymbol>(resolved);
    }

    private static (Compilation Compilation, SyntaxTree Tree) Compile(string source)
    {
        var tree = SyntaxTree.Parse(GSharp.Core.CodeAnalysis.Text.SourceText.From(source));
        return (new Compilation(tree), tree);
    }

    private static SyntaxToken IdentifierAt(SyntaxTree tree, string text, int occurrence)
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
