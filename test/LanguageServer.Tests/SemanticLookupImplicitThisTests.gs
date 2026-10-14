// <copyright file="SemanticLookupImplicitThisTests.cs" company="GSharp">
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

/// Coverage for implicit-this member resolution in `SemanticLookup`. The binder treats a
/// bare identifier inside a class/struct method body as `this.<identifier>`; the
/// language-server-side resolver has to mirror that so navigation, hover, find-references,
/// rename, and CodeLens reference counts agree with the binder. PRs #412 and #413 introduced
/// the implicit-this binder behaviour but only patched hover, leaving every other consumer
/// silently dropping these usages.
open class SemanticLookupImplicitThisTests {
    @Fact
    func BareProperty_InsideMethodBody_ResolvesToProperty() {
        let sym Symbol? = ResolveBareName(`class Person {
    public prop Name string
    func Get() string { return Name }
}
`, useOffsetOfNthOccurrence: 2)
        Assert.IsType[PropertySymbol](sym)
        Assert.Equal("Name", sym!!.Name)
    }

    @Fact
    func BareProperty_InsideInterpolationHole_ResolvesToProperty() {
        let sym Symbol? = ResolveBareName(`class Person {
    public prop Name string
    func Greet() string { return "Hi ${Name}" }
}
`, useOffsetOfNthOccurrence: 2)
        Assert.IsType[PropertySymbol](sym)
        Assert.Equal("Name", sym!!.Name)
    }

    @Fact
    func BareField_InsideMethodBody_ResolvesToField() {
        let sym Symbol? = ResolveBareName(`class Counter {
    var Value int32
    func Read() int32 { return Value }
}
`, tokenText: "Value", useOffsetOfNthOccurrence: 2)
        Assert.IsType[FieldSymbol](sym)
        Assert.Equal("Value", sym!!.Name)
    }

    @Fact
    func BareMethod_InsideMethodBody_ResolvesToMethod() {
        let sym Symbol? = ResolveBareName(`class Person {
    func Helper() int32 { return 1 }
    func Use() int32 { return Helper() }
}
`, tokenText: "Helper", useOffsetOfNthOccurrence: 2)
        Assert.IsType[FunctionSymbol](sym)
        Assert.Equal("Helper", sym!!.Name)
    }

    @Fact
    func FindReferences_OnProperty_IncludesImplicitThisUses() {
        const source = `class Person {
    public prop Name string
    func A() string { return Name }
    func B() string { return "v: ${Name}" }
    func C() string { return this.Name }
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        let declarationToken SyntaxToken? = FirstIdentifierAt(tree, "Name", occurrence: 1)
        let property Symbol? = SemanticLookup.ResolveSymbol(compilation, declarationToken)
        Assert.NotNull(property)
        let references = SemanticLookup.FindReferences(compilation, property!!).ToList()
        // Declaration + return Name + ${Name} + this.Name = 4
        Assert.Equal(4, references.Count)
    }

    @Fact
    func BareMemberName_OutsideMethodBody_DoesNotResolveToMember() {
        // The bare `Name` in the field initializer position is not inside a method body,
        // so implicit-this resolution must not kick in there.
        const source = `class Person {
    public prop Name string
}
func main() { var x = Name }
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        let topLevelUse SyntaxToken? = FirstIdentifierAt(tree, "Name", occurrence: 2)
        let sym Symbol? = SemanticLookup.ResolveSymbol(compilation, topLevelUse)
        Assert.False(
            sym is PropertySymbol,
            "Bare Name outside any method body must not resolve to the property as implicit-this."
        )
    }

    shared {
        private func ResolveBareName(body string, useOffsetOfNthOccurrence int32, tokenText string? = "Name") Symbol? {
            const preamble = `package Temp

`
            let source = preamble + body
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let token SyntaxToken? = FirstIdentifierAt(tree, tokenText, occurrence: useOffsetOfNthOccurrence)
            Assert.NotNull(token)
            return SemanticLookup.ResolveSymbol(compilation, token)
        }

        private func FirstIdentifierAt(tree SyntaxTree, text string?, occurrence int32) SyntaxToken? {
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
