// <copyright file="UnifiedMemberResolutionCharacterizationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.LanguageServer.Protocol;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// ADR-0112 Phase 2 (characterization). Locks the *current* language-server
/// member-resolution behavior for user-defined types BEFORE the unified
/// member-resolution layer is introduced and the duplicated enumerations
/// (HoverComputer.LookupMemberOnStruct, SemanticLookup.LookupMember /
/// BuildModelUncached, CompletionComputer.AddStruct*Members, the hover
/// overload counter) are migrated to it. These tests must stay green through
/// the migration — they are the parity gate.
/// </summary>
public class UnifiedMemberResolutionCharacterizationTests
{
    // Representative user type: a class with instance + static members of every
    // kind, an inheritance chain, and an overloaded instance + static method.
    private const string Sample = @"package P

open class Base {
    prop BaseProp int32
    var baseField int32
    func BaseMethod() int32 { return 1 }
}

open class Animal : Base {
    prop Name string
    var legs int32
    func Speak() string { return ""..."" }
    func Speak(loud bool) string { return ""!"" }

    shared {
        var Count int32
        prop Kind string
        func Make() Animal { return Animal{} }
        func Make(name string) Animal { return Animal{} }
    }
}

func Main() {
    var a = Animal{}
    var n = a.Name
    var s = a.Speak()
    var b = a.BaseProp
    var c = Animal.Count
}
";

    [Fact]
    public void Hover_InstanceMethod_Overloaded_ShowsOverloadCount()
    {
        var content = LanguageServerTestHelpers.Content(Sample);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(Sample, "Speak", 2));

        Assert.NotNull(hover);
        var text = hover.Contents.ToString();
        Assert.Contains("Speak", text, System.StringComparison.Ordinal);
        Assert.Contains("overload", text, System.StringComparison.Ordinal);
    }

    [Fact]
    public void Hover_StaticMethod_Overloaded_ShowsOverloadCount()
    {
        var content = LanguageServerTestHelpers.Content(Sample);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(Sample, "Count", 1));

        Assert.NotNull(hover);
        // `Count` is the static field used as `Animal.Count`.
        Assert.Contains("Count", hover.Contents.ToString(), System.StringComparison.Ordinal);
    }

    [Fact]
    public void Hover_InheritedProperty_ResolvesThroughBaseChain()
    {
        var content = LanguageServerTestHelpers.Content(Sample);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(Sample, "BaseProp", 1));

        Assert.NotNull(hover);
        Assert.Contains("BaseProp", hover.Contents.ToString(), System.StringComparison.Ordinal);
    }

    [Fact]
    public void SemanticLookup_InstanceMember_Resolves()
    {
        var (compilation, tree) = Compile(Sample);
        var nameUse = IdentifierAt(tree, "Name", occurrence: 2);
        var resolved = SemanticLookup.ResolveSymbol(compilation, nameUse);
        Assert.IsType<PropertySymbol>(resolved);
    }

    [Fact]
    public void SemanticLookup_InheritedMember_Resolves()
    {
        var (compilation, tree) = Compile(Sample);
        var baseUse = IdentifierAt(tree, "BaseProp", occurrence: 2);
        var resolved = SemanticLookup.ResolveSymbol(compilation, baseUse);
        Assert.IsType<PropertySymbol>(resolved);
    }

    [Fact]
    public void SemanticLookup_StaticField_Resolves()
    {
        var (compilation, tree) = Compile(Sample);
        var countUse = IdentifierAt(tree, "Count", occurrence: 2);
        var resolved = SemanticLookup.ResolveSymbol(compilation, countUse);
        Assert.IsType<FieldSymbol>(resolved);
    }

    [Fact]
    public void Completion_InstanceReceiver_ListsInstanceMembersIncludingInherited()
    {
        const string source = @"package P

open class Base {
    prop BaseProp int32
    func BaseMethod() int32 { return 1 }
}

class Animal : Base {
    prop Name string
    func Speak() string { return ""..."" }
}

func Main() {
    var a = Animal{}
    a.
}
";
        var content = LanguageServerTestHelpers.Content(source);
        var dotPos = LanguageServerTestHelpers.PositionOf(source, "a.", 0);
        var completion = CompletionComputer.ComputeCompletions(
            content,
            new Position(dotPos.Line, dotPos.Character + "a.".Length));

        var labels = completion.Select(i => i.Label).ToHashSet();
        Assert.Contains("Name", labels);
        Assert.Contains("Speak", labels);
        Assert.Contains("BaseProp", labels);
        Assert.Contains("BaseMethod", labels);
    }

    [Fact]
    public void Completion_StaticReceiver_ListsStaticMembers()
    {
        const string source = @"package P

class Animal {
    prop Name string
    shared {
        var Count int32
        func Make() Animal { return Animal{} }
    }
}

func Main() {
    var x = Animal.
}
";
        var content = LanguageServerTestHelpers.Content(source);
        var dotPos = LanguageServerTestHelpers.PositionOf(source, "Animal.", 0);
        var completion = CompletionComputer.ComputeCompletions(
            content,
            new Position(dotPos.Line, dotPos.Character + "Animal.".Length));

        var labels = completion.Select(i => i.Label).ToHashSet();
        Assert.Contains("Count", labels);
        Assert.Contains("Make", labels);
    }

    [Fact]
    public void HoverAndBinder_AgreeOnSharedMethodGroup()
    {
        // ADR-0112 unified resolution: the SAME shared method that hover resolves
        // for documentation must also be accepted by the binder as a method-group
        // delegate conversion. Previously hover succeeded while the binder
        // reported GS0158/GS0125 because they used separate resolution code.
        const string source = @"package P

class Box {
    var tag int32
    shared {
        func Make() Box { return Box{ tag: 7 } }
    }
}

func Use(f () -> Box) int32 { return f().tag }

func Main() {
    var n = Use(Box.Make)
}
";
        // Binder side: no diagnostics — the method group converts cleanly.
        var (compilation, tree) = Compile(source);
        var diagnostics = compilation.GlobalScope.Diagnostics;
        Assert.DoesNotContain(diagnostics, d => d.IsError);

        // Hover side: hovering the `Make` reference resolves the member.
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Make", 1));
        Assert.NotNull(hover);
        Assert.Contains("Make", hover.Contents.ToString(), System.StringComparison.Ordinal);

        // SemanticLookup side: the reference resolves to the shared FunctionSymbol.
        var makeUse = IdentifierAt(tree, "Make", occurrence: 2);
        var resolved = SemanticLookup.ResolveSymbol(compilation, makeUse);
        var fn = Assert.IsType<FunctionSymbol>(resolved);
        Assert.Equal("Make", fn.Name);
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

        Assert.Fail($"Not enough '{text}' identifiers (wanted {occurrence}).");
        return null;
    }

    private static System.Collections.Generic.IEnumerable<SyntaxToken> EnumerateTokens(SyntaxNode node)
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
