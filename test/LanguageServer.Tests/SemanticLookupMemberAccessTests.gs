// <copyright file="SemanticLookupMemberAccessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.LanguageServer
import System.Collections.Generic
import System.Linq
import Xunit

/// Coverage for member-access resolution in `SemanticLookup`:
/// `receiver.Member` on user-declared structs/classes/enums, and on Go-style
/// receiver-clause methods. The previous resolver routed these tokens through
/// by-name local/global lookups, which silently returned null for instance members
/// (no name-based fallback exists for fields, properties, methods, or events).
/// FindReferences therefore under-counted, and CodeLens showed "0 references" on
/// types whose members were actually used.
open class SemanticLookupMemberAccessTests {
    @Fact
    func InstanceProperty_AccessedViaLocal_ResolvesAndIsCounted() {
        const source = `class Person {
    public prop Name string
}
func Main() {
    var p = Person{}
    p.Name = "a"
    var q = p.Name
}
`
        let (compilation, tree) = Compile(source)
        let nameInWrite SyntaxToken? = IdentifierAt(tree, "Name", occurrence: 2)
        let nameInRead SyntaxToken? = IdentifierAt(tree, "Name", occurrence: 3)
        Assert.IsType[PropertySymbol](SemanticLookup.ResolveSymbol(compilation, nameInWrite))
        Assert.IsType[PropertySymbol](SemanticLookup.ResolveSymbol(compilation, nameInRead))
        let declaration SyntaxToken? = IdentifierAt(tree, "Name", occurrence: 1)
        let property Symbol? = SemanticLookup.ResolveSymbol(compilation, declaration)
        let refs = SemanticLookup.FindReferences(compilation, property!!).ToList()
        Assert.Equal(3, refs.Count) // decl + write + read

    }

    @Fact
    func InstanceProperty_AccessedInsideInterpolationHole_Resolves() {
        const source = `class Person {
    public prop Name string
}
func Main() {
    var p = Person{}
    var s = "hi ${p.Name}"
}
`
        let (compilation, tree) = Compile(source)
        let nameInHole SyntaxToken? = IdentifierAt(tree, "Name", occurrence: 2)
        Assert.IsType[PropertySymbol](SemanticLookup.ResolveSymbol(compilation, nameInHole))
    }

    @Fact
    func ChainedMemberAccess_ResolvesInnerSegment() {
        const source = `class Inner {
    public prop Value int32
}
class Outer {
    public prop In Inner
}
func Main() {
    var o = Outer{}
    var v = o.In.Value
}
`
        let (compilation, tree) = Compile(source)
        // `Value` after the `In.` segment
        let valueAccess SyntaxToken? = IdentifierAt(tree, "Value", occurrence: 2)
        let resolved Symbol? = SemanticLookup.ResolveSymbol(compilation, valueAccess)
        Assert.IsType[PropertySymbol](resolved)
        Assert.Equal("Value", resolved!!.Name)
    }

    @Fact
    func EnumMemberAccess_StillResolvesAfterMemberAccessRewrite() {
        // Regression: when ResolveAsMemberAccess was added it short-circuited
        // by-name fallbacks. Enum members live in `globals` by name, so the
        // receiver-typed lookup must also handle EnumSymbol receivers — otherwise
        // existing `Color.Red`-style lenses regressed to "0 references".
        const source = `enum Color {
    Red,
    Green
}
var a = Color.Red
var b = Color.Red
var c = Color.Green
`
        let (compilation, tree) = Compile(source)
        let redUse SyntaxToken? = IdentifierAt(tree, "Red", occurrence: 2)
        let resolved Symbol? = SemanticLookup.ResolveSymbol(compilation, redUse)
        Assert.IsType[EnumMemberSymbol](resolved)
    }

    @Fact
    func GoStyleReceiver_ExplicitMemberAccess_Resolves() {
        const source = `class Person {
    public prop Name string
}
func (r Person) Greet() string { return r.Name }
func Main() {
    var x = Person{}
    x.Name = "a"
}
`
        let (compilation, tree) = Compile(source)
        // r.Name inside the Go-style receiver method
        let nameInBody SyntaxToken? = IdentifierAt(tree, "Name", occurrence: 2)
        Assert.IsType[PropertySymbol](SemanticLookup.ResolveSymbol(compilation, nameInBody))
        let declaration SyntaxToken? = IdentifierAt(tree, "Name", occurrence: 1)
        let property Symbol? = SemanticLookup.ResolveSymbol(compilation, declaration)
        let refs = SemanticLookup.FindReferences(compilation, property!!).ToList()
        Assert.Equal(3, refs.Count) // decl + r.Name + x.Name

    }

    @Fact
    func GoStyleReceiver_ReceiverParameter_ResolvesToParameter() {
        const source = `class Person {
    public prop Name string
}
func (r Person) Use() string { return r.Name }
`
        let (compilation, tree) = Compile(source)
        // The `r` in `r.Name`
        let receiverUse SyntaxToken? = IdentifierAt(tree, "r", occurrence: 2)
        let resolved Symbol? = SemanticLookup.ResolveSymbol(compilation, receiverUse)
        Assert.IsType[ParameterSymbol](resolved)
        Assert.Equal("r", resolved!!.Name)
    }

    @Fact
    func GoStyleReceiver_DoesNotTriggerImplicitThis() {
        // Inside a Go-style receiver method, a bare member name must NOT resolve
        // to a receiver member (the language requires an explicit `r.Member`).
        // Otherwise IDE features would offer fake references the binder doesn't agree with.
        const source = `class Person {
    public prop Name string
}
func (r Person) Bad() string { return Name }
`
        let (compilation, tree) = Compile(source)
        let bareNameUse SyntaxToken? = IdentifierAt(tree, "Name", occurrence: 2)
        let resolved Symbol? = SemanticLookup.ResolveSymbol(compilation, bareNameUse)
        Assert.False(
            resolved is PropertySymbol,
            "Bare member name inside a Go-style receiver method must not implicit-this-resolve to a receiver member."
        )
    }

    @Fact
    func FieldAssignment_FieldIdentifier_Resolves() {
        const source = `class Counter {
    var Value int32
}
func Main() {
    var c = Counter{}
    c.Value = 1
}
`
        let (compilation, tree) = Compile(source)
        let valueInAssignment SyntaxToken? = IdentifierAt(tree, "Value", occurrence: 2)
        let resolved Symbol? = SemanticLookup.ResolveSymbol(compilation, valueInAssignment)
        Assert.IsType[FieldSymbol](resolved)
        Assert.Equal("Value", resolved!!.Name)
    }

    @Fact
    func MemberName_NotShadowedByGlobalOfSameName() {
        // A top-level `Name` global must not be the resolution of `p.Name`.
        const source = `class Person {
    public prop Name string
}
var Name = "global"
func Main() {
    var p = Person{}
    var q = p.Name
}
`
        let (compilation, tree) = Compile(source)
        let memberAccess SyntaxToken? = IdentifierAt(
            tree,
            "Name",
            occurrence: 2
        ) // declaration is 1, top-level var is also "Name"... use occurrence 3 to be safe
        // The third `Name` token is the `p.Name` access (after the property decl and the global var decl).
        let pName SyntaxToken? = IdentifierAt(tree, "Name", occurrence: 3)
        let resolved Symbol? = SemanticLookup.ResolveSymbol(compilation, pName)
        Assert.IsType[PropertySymbol](resolved)
    }

    shared {
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
