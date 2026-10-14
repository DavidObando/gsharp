// <copyright file="Issue3658QualifiedTypeArgumentReceiverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #3658 — a constructed generic type used as a member-access receiver
/// must bind when its type argument is spelled as a <em>dotted</em> name
/// (`ImmutableArray[System.String].Empty`,
/// `ImmutableArray[App.Thing].Empty`). The reshape from index-expression
/// brackets to a type clause previously accepted only a bare identifier, so a
/// dotted argument abandoned the constructed-generic-receiver interpretation and
/// fell back to element access — reporting
/// `GS0125 Variable 'ImmutableArray' doesn't exist` plus a bogus member
/// lookup on the trailing segment. The same spelling in type position always
/// bound, which is why the defect only surfaced on the initializer side.
open class Issue3658QualifiedTypeArgumentReceiverTests {
    @Fact
    func ImportedGenericReceiver_WithQualifiedTypeArgument_Binds() {
        let source = `package App
import System.Collections.Immutable

class Thing {
}

class Holder {
    private var items ImmutableArray[App.Thing] = ImmutableArray[App.Thing].Empty
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func ImportedGenericReceiver_WithFrameworkQualifiedTypeArgument_Binds() {
        let source = `package App
import System.Collections.Immutable

class Holder {
    private var names ImmutableArray[System.String] = ImmutableArray[System.String].Empty
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func ImportedGenericReceiver_WithDeepQualifiedTypeArgument_Binds() {
        // Three or more segments nest to the *right* in expression position
        // (`System.(Text.StringBuilder)`), unlike the two-segment case, so the
        // flattening walk has to handle both leanings.
        let source = `package App
import System.Collections.Immutable

class Holder {
    private var builders ImmutableArray[System.Text.StringBuilder] = ImmutableArray[System.Text.StringBuilder].Empty
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func FullyQualifiedGenericReceiver_WithQualifiedTypeArgument_Binds() {
        let source = `package App

class Thing {
}

class Holder {
    private var items System.Collections.Immutable.ImmutableArray[App.Thing] =
        System.Collections.Immutable.ImmutableArray[App.Thing].Empty
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func UserGenericReceiver_WithNestedTypeArgument_Binds() {
        let source = `package App

class Outer {
    class Inner {
    }
}

class Box[T] {
    shared {
        let Default int32 = 0
    }
}

func F() int32 {
    return Box[Outer.Inner].Default
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func GenuineIndexing_WithQualifiedIndexExpression_StillBindsAsElementAccess() {
        // The dotted-name reshape must not steal genuine indexing: `values` is a
        // value in scope, so `values[Keys.First]` remains element access.
        let source = `package App
import System.Collections.Generic

class Keys {
    shared {
        let First int32 = 0
    }
}

func F() string {
    var values = List[string]()
    values.Add("a")
    return values[Keys.First]
}`
        Assert.Empty(Bind(source))
    }

    shared {
        private func MetadataLoadContextResolver() ReferenceResolver {
            let paths = []string{
                typeof(object).Assembly.Location,
                typeof(System.Collections.Generic.List[_]).Assembly.Location,
                typeof(ImmutableArray[_]).Assembly.Location,
                typeof(Console).Assembly.Location,
                typeof(Enumerable).Assembly.Location
            }
                .Where((p string) -> !string.IsNullOrEmpty(p))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray()
            return ReferenceResolver.WithReferences(paths)
        }

        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(
                previous: nil,
                ImmutableArray.Create(tree),
                MetadataLoadContextResolver()
            )
            let program = Binder.BindProgram(globalScope, MetadataLoadContextResolver())
            return globalScope.Diagnostics.AddRange(program.Diagnostics)
        }
    }
}
