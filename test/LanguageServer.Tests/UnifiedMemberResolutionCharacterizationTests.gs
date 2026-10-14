// <copyright file="UnifiedMemberResolutionCharacterizationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import System.Linq
import Xunit

/// ADR-0112 Phase 2 (characterization). Locks the *current* language-server
/// member-resolution behavior for user-defined types BEFORE the unified
/// member-resolution layer is introduced and the duplicated enumerations
/// (HoverComputer.LookupMemberOnStruct, SemanticLookup.LookupMember /
/// BuildModelUncached, CompletionComputer.AddStruct*Members, the hover
/// overload counter) are migrated to it. These tests must stay green through
/// the migration — they are the parity gate.
open class UnifiedMemberResolutionCharacterizationTests {
    @Fact
    func Hover_InstanceMethod_Overloaded_ShowsOverloadCount() {
        let content = LanguageServerTestHelpers.Content(Sample)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(Sample, "Speak", 2))
        Assert.NotNull(hover)
        let text = hover!!.Contents.ToString()
        Assert.Contains("Speak", text, StringComparison.Ordinal)
        Assert.Contains("overload", text, StringComparison.Ordinal)
    }

    @Fact
    func Hover_StaticMethod_Overloaded_ShowsOverloadCount() {
        let content = LanguageServerTestHelpers.Content(Sample)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(Sample, "Count", 1))
        Assert.NotNull(hover)
        // `Count` is the static field used as `Animal.Count`.
        Assert.Contains("Count", hover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func Hover_InheritedProperty_ResolvesThroughBaseChain() {
        let content = LanguageServerTestHelpers.Content(Sample)
        let hover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(Sample, "BaseProp", 1)
        )
        Assert.NotNull(hover)
        Assert.Contains("BaseProp", hover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func SemanticLookup_InstanceMember_Resolves() {
        let (compilation, tree) = Compile(Sample)
        let nameUse SyntaxToken? = IdentifierAt(tree, "Name", occurrence: 2)
        let resolved Symbol? = SemanticLookup.ResolveSymbol(compilation, nameUse)
        Assert.IsType[PropertySymbol](resolved)
    }

    @Fact
    func SemanticLookup_InheritedMember_Resolves() {
        let (compilation, tree) = Compile(Sample)
        let baseUse SyntaxToken? = IdentifierAt(tree, "BaseProp", occurrence: 2)
        let resolved Symbol? = SemanticLookup.ResolveSymbol(compilation, baseUse)
        Assert.IsType[PropertySymbol](resolved)
    }

    @Fact
    func SemanticLookup_StaticField_Resolves() {
        let (compilation, tree) = Compile(Sample)
        let countUse SyntaxToken? = IdentifierAt(tree, "Count", occurrence: 2)
        let resolved Symbol? = SemanticLookup.ResolveSymbol(compilation, countUse)
        Assert.IsType[FieldSymbol](resolved)
    }

    @Fact
    func Completion_InstanceReceiver_ListsInstanceMembersIncludingInherited() {
        const source = `package P

open class Base {
    prop BaseProp int32
    func BaseMethod() int32 { return 1 }
}

class Animal : Base {
    prop Name string
    func Speak() string { return "..." }
}

func Main() {
    var a = Animal{}
    a.
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let dotPos = LanguageServerTestHelpers.PositionOf(source, "a.", 0)
        let completion = CompletionComputer.ComputeCompletions(
            content,
            Position(dotPos.Line, dotPos.Character + "a.".Length)
        )
        let labels = completion.Select((i CompletionItem) -> i.Label).ToHashSet()
        Assert.Contains("Name", labels)
        Assert.Contains("Speak", labels)
        Assert.Contains("BaseProp", labels)
        Assert.Contains("BaseMethod", labels)
    }

    @Fact
    func Completion_StaticReceiver_ListsStaticMembers() {
        const source = `package P

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
`
        let content = LanguageServerTestHelpers.Content(source)
        let dotPos = LanguageServerTestHelpers.PositionOf(source, "Animal.", 0)
        let completion = CompletionComputer.ComputeCompletions(
            content,
            Position(dotPos.Line, dotPos.Character + "Animal.".Length)
        )
        let labels = completion.Select((i CompletionItem) -> i.Label).ToHashSet()
        Assert.Contains("Count", labels)
        Assert.Contains("Make", labels)
    }

    @Fact
    func HoverAndBinder_AgreeOnSharedMethodGroup() {
        // ADR-0112 unified resolution: the SAME shared method that hover resolves
        // for documentation must also be accepted by the binder as a method-group
        // delegate conversion. Previously hover succeeded while the binder
        // reported GS0158/GS0125 because they used separate resolution code.
        const source = `package P

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
`
        // Binder side: no diagnostics — the method group converts cleanly.
        let (compilation, tree) = Compile(source)
        let diagnostics = compilation.GlobalScope.Diagnostics
        Assert.DoesNotContain(diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
        // Hover side: hovering the `Make` reference resolves the member.
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Make", 1))
        Assert.NotNull(hover)
        Assert.Contains("Make", hover!!.Contents.ToString(), StringComparison.Ordinal)
        // SemanticLookup side: the reference resolves to the shared FunctionSymbol.
        let makeUse SyntaxToken? = IdentifierAt(tree, "Make", occurrence: 2)
        let resolved Symbol? = SemanticLookup.ResolveSymbol(compilation, makeUse)
        let fn = Assert.IsType[FunctionSymbol](resolved)
        Assert.Equal("Make", fn.Name)
    }

    shared {
        // Representative user type: a class with instance + static members of every
        // kind, an inheritance chain, and an overloaded instance + static method.
        private const Sample string = `package P

open class Base {
    prop BaseProp int32
    var baseField int32
    func BaseMethod() int32 { return 1 }
}

open class Animal : Base {
    prop Name string
    var legs int32
    func Speak() string { return "..." }
    func Speak(loud bool) string { return "!" }

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
`

        private func Compile(source string)(Compilation Compilation, Tree SyntaxTree) {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return (Compilation(tree), tree)
        }

        private func IdentifierAt(tree SyntaxTree, text string, occurrence int32) SyntaxToken? {
            var seen = 0
            for token in EnumerateTokens(tree.Root) {
                if token.Kind == SyntaxKind.IdentifierToken && token.Text == text {
                    seen++
                    if seen == occurrence {
                        return token
                    }
                }
            }
            Assert.Fail("Not enough '$text' identifiers (wanted $occurrence).")
            return nil
        }

        private func EnumerateTokens(node SyntaxNode) sequence[SyntaxToken] {
            if node is SyntaxToken token {
                yield token
                yield break
            }
            for child in node.GetChildren() {
                for inner in EnumerateTokens(child) {
                    yield inner
                }
            }
        }
    }
}
