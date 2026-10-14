// <copyright file="Issue1085BaseInitializerOrderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1085: constructing a class that declares an explicit `init(...)`
/// inside a base-initializer (`: base(...)`) must bind correctly regardless
/// of the order in which the source files are processed. The base-initializer
/// argument expressions are bound in a deferred pass that runs after every
/// declared type's explicit constructors are populated, so a constructed type
/// declared in a file processed AFTER the caller no longer resolves against an
/// empty constructor shell (which previously produced a spurious GS0144).
open class Issue1085BaseInitializerOrderTests {
    @Fact
    func BaseInitializerArgument_ConstructsTypeFromLaterFile_CompilesCleanly() {
        // Caller file FIRST — the constructed type `H` is declared in a file
        // processed afterwards. This is the failing order from #1085.
        let scope_ = BindSources(CallerFile, DefinitionFile)
        Assert.Empty(scope_.Diagnostics)
    }

    @Fact
    func BaseInitializerArgument_DefinitionFileFirst_StillCompilesCleanly() {
        // The already-working order must keep working.
        let scope_ = BindSources(DefinitionFile, CallerFile)
        Assert.Empty(scope_.Diagnostics)
    }

    @Fact
    func BaseInitializerArgument_ConstructedTypeHasMultipleOverloads_CompilesCleanly() {
        let definitionWithOverloads = `package p
class H {
    init(v int32) { }
    init(v int32, w int32) { }
}`
        let scope_ = BindSources(CallerFile, definitionWithOverloads)
        Assert.Empty(scope_.Diagnostics)
    }

    @Fact
    func BaseInitializerArgument_AcrossPackages_CallerFirst_CompilesCleanly() {
        let caller = `package p
import q
open class Base(h H, x int32) { }
class Derived : Base {
    init() : base(H(1), 0) { }
}`
        let definition = `package q
class H {
    init(v int32) { }
}`
        let scope_ = BindSources(caller, definition)
        Assert.Empty(scope_.Diagnostics)
    }

    shared {
        private const CallerFile string = `package p
open class Base(h H, x int32) { }
class Derived : Base {
    init() : base(H(1), 0) { }
}`

        private const DefinitionFile string = `package p
class H {
    init(v int32) { }
}`

        private func BindSources(sources ...string) BoundGlobalScope {
            let trees = ImmutableArray.CreateRange(
                Enumerable.Select(sources, (s string) -> SyntaxTree.Parse(SourceText.From(s)))
            )
            return Binder.BindGlobalScope(previous: nil, trees)
        }
    }
}
