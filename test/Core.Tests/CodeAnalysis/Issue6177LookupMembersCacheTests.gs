// <copyright file="Issue6177LookupMembersCacheTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Linq
import Xunit

/// Issue #6177 (item 3): a semantic model caches the extension members of a receiver type. The cache must
/// answer what a query without it answers: in every position of the model, and not across compilations.
open class Issue6177LookupMembersCacheTests {
    @Fact
    func RepeatedQueries_AnswerTheSameMembersAsAFreshModel() {
        const source = "package P\n\nimport System.Linq\n\nfunc (s string) Shout() string -> s\n\nclass Box {\n    func Use(s string) int32 {\n        return s.Length\n    }\n}\n\nfunc Main() {\n    let s = \"a\"\n    let n = s.Length\n}\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "cache.gs"))
        let compilation = Compilation(tree)
        let model = compilation.GetSemanticModel(tree)
        let positions = []int32{
            source.IndexOf("return s.Length", StringComparison.Ordinal),
            source.IndexOf("let n = s.Length", StringComparison.Ordinal)
        }
        for position in positions {
            let first = Describe(model.LookupMembers(position, TypeSymbol.String))
            let second = Describe(model.LookupMembers(position, TypeSymbol.String))
            Assert.Equal(first, second)
            Assert.Contains("Shout", first)
            Assert.Contains("Select", first)
            // A model of another compilation over the same text answers the same.
            let fresh = Compilation(SyntaxTree.Parse(SourceText.From(source, "cache.gs")))
            let freshTree = fresh.SyntaxTrees[0]
            Assert.Equal(first, Describe(fresh.GetSemanticModel(freshTree).LookupMembers(position, TypeSymbol.String)))
            // A query of one name answers the members of that name only.
            Assert.Equal(
                []string{"Shout"},
                model.LookupMembers(position, TypeSymbol.String, "Shout").Select((m Symbol) -> m.Name).ToArray()
            )
        }
    }

    @Fact
    func SuccessorWithOtherImports_DoesNotReuseTheCache() {
        const source = "package P\n\nfunc Main() {\n    let s = \"a\"\n    let n = s.Length\n}\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "cache.gs"))
        let compilation = Compilation(tree)
        let position = source.IndexOf("s.Length", StringComparison.Ordinal)
        Assert.DoesNotContain(
            "Select",
            Describe(compilation.GetSemanticModel(tree).LookupMembers(position, TypeSymbol.String))
        )
        let withLinq = "package P\n\nimport System.Linq\n" + source.Substring("package P\n".Length)
        let next = SyntaxTree.Parse(SourceText.From(withLinq, "cache.gs"))
        let successor = compilation.ReplaceSyntaxTree(tree, next)
        let shifted = withLinq.IndexOf("s.Length", StringComparison.Ordinal)
        Assert.Contains("Select", Describe(successor.GetSemanticModel(next).LookupMembers(shifted, TypeSymbol.String)))
    }

    @Fact
    func RetainedModelAfterAnAssemblyRename_AnswersAsAFreshModel() {
        // A rename starts a new binding generation, and the cache key holds it, so the retained model does not
        // answer the symbols of the old bind from its cache.
        const source = "package P\n\nimport System.Linq\n\nfunc (s string) Shout() string -> s\n\nfunc Main() {\n    let s = \"a\"\n    let n = s.Length\n}\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "cache.gs"))
        let compilation = Compilation(tree)
        compilation.AssemblyName = "First"
        let model = compilation.GetSemanticModel(tree)
        let position = source.IndexOf("s.Length", StringComparison.Ordinal)
        let before = model.LookupMembers(position, TypeSymbol.String, "Shout").Single()
        compilation.AssemblyName = "Second"
        // The retained model, not a new one.
        let retained = model.LookupMembers(position, TypeSymbol.String, "Shout").Single()
        let fresh = compilation.GetSemanticModel(tree).LookupMembers(position, TypeSymbol.String, "Shout").Single()
        Assert.NotSame(before, retained)
        Assert.Same(fresh, retained)
        Assert.Equal(
            Describe(compilation.GetSemanticModel(tree).LookupMembers(position, TypeSymbol.String)),
            Describe(model.LookupMembers(position, TypeSymbol.String))
        )
    }

    shared {
        private func Describe(members System.Collections.Immutable.ImmutableArray[Symbol])[]string -> members.Select(
            (m Symbol) -> m.Name
        )
            .ToArray()
    }
}
