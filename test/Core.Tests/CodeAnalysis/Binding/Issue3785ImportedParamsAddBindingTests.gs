// <copyright file="Issue3785ImportedParamsAddBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests.Fixtures
import System.Collections.Immutable
import System.Linq
import Xunit

/// ADR-0180 / issue #3785 reviewer finding: the content-spread capability
/// probe (`HasUnaryCollectionAdd`'s raw-reflection
/// `ParameterInfo[]` view) counted a TRAILING `params` parameter as
/// required, so an imported CLR type whose only `Add` overload is
/// `Add(item, params rest[])` was rejected with GS0369 before overload
/// resolution ever ran, even though the overload is callable with exactly one
/// argument. Mirrors (cref:Issue3096CollectionSpreadBindingTests)'s
/// diagnostics-only `Bind` style, with
/// (cref:ImportedParamsAddCollection) (a plain, non-aggregate imported
/// type) forcing the raw-reflection probe rather than the semantic-aggregate
/// one.
class Issue3785ImportedParamsAddBindingTests {
    @Theory
    @InlineData("ImportedParamsAddCollection")
    @InlineData("ImportedOptionalParamsAddCollection")
    func ContentSpread_ImportedTypeWithTrailingParamsAdd_BindsLikeOrdinaryCall(target string) {
        Assert.Empty(Bind((`import GSharp.Core.Tests.Fixtures
let bag = ` + "$target" + `()
bag.Add("a")`)))
        let diagnostics = Bind((`import System.Collections.Generic
import GSharp.Core.Tests.Fixtures

let rows = List[string]{ "a", "b" }
let bag = ` + "$target" + `(){ .Tag: 7, ...rows }`))
        Assert.Empty(diagnostics)
    }

    shared {
        private func FixtureResolver() ReferenceResolver -> ReferenceResolver.WithReferences(
            []string{typeof(ImportedParamsAddCollection).Assembly.Location}
        )

        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            if tree.Diagnostics.Any() {
                return tree.Diagnostics
            }
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree), FixtureResolver())
            if globalScope.Diagnostics.Any() {
                return globalScope.Diagnostics
            }
            return Binder.BindProgram(globalScope, FixtureResolver()).Diagnostics.ToImmutableArray()
        }
    }
}
