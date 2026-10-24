// <copyright file="Issue5281AnonymousTypeBodyPassTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #5281: the body pass starts from a private copy of the declaration pass's anonymous-type
/// cache, so a second `BindProgram` over one global scope, including an incremental body-only edit,
/// neither keeps types from superseded bodies nor shifts the numbering of the types it creates.
open class Issue5281AnonymousTypeBodyPassTests {
    @Fact
    func RepeatedBindProgramOverOneGlobalScope_NumbersAnonymousTypesIdentically() {
        let tree = Parse("A.gs", `package P
var top = object { let T int32 = 1 }
func F() int32 {
    let a = object { let X int32 = 1 }
    return a.X
}`)
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        let first = AnonymousNames(Binder.BindProgram(scope_, references: nil))
        let second = AnonymousNames(Binder.BindProgram(scope_, references: nil))
        Assert.Equal([]string{"<>AnonymousType0:T", "<>AnonymousType1:X"}, first)
        Assert.Equal(first, second)
    }

    @Fact
    func BodyOnlyEdit_DoesNotRetainAnonymousTypesOfTheSupersededBody() {
        let original = Parse("A.gs", `package P
func F() int32 {
    let a = object { let X int32 = 1 }
    return a.X
}`)
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(original))
        let cache = BoundBodyCache()
        Assert.Equal([]string{"<>AnonymousType0:X"}, AnonymousNames(Binder.BindProgram(scope_, references: nil, cache)))
        let edited = Parse("A.gs", `package P
func F() int32 {
    let a = object { let Y int32 = 1 }
    return a.Y
}`)
        Assert.True(IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(scope_, original, edited))
        let incremental = AnonymousNames(
            Binder.BindProgram(scope_, references: nil, cache, ImmutableHashSet.Create(edited))
        )
        let cleanScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(edited))
        let clean = AnonymousNames(Binder.BindProgram(cleanScope, references: nil))
        Assert.Equal([]string{"<>AnonymousType0:Y"}, clean)
        Assert.Equal(clean, incremental)
    }

    shared {
        private func AnonymousNames(program BoundProgram)[]string -> program
            .Structs
            .Where((s StructSymbol) -> s.Name.StartsWith("<>AnonymousType", System.StringComparison.Ordinal))
            .Select(
            (s StructSymbol) -> s.Name + ":" + string.Join(
                ",",
                s
                    .Properties
                    .Select((p PropertySymbol) -> p.Name)
                    .Concat(s.Fields.Select((f FieldSymbol) -> f.Name))
                    .Where((n string) -> !n.Contains('<'))
            )
        )
            .ToArray()

        private func Parse(fileName string, source string) SyntaxTree -> SyntaxTree.Parse(
            SourceText.From(source, fileName)
        )
    }
}
