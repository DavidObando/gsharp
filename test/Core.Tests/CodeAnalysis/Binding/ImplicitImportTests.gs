// <copyright file="ImplicitImportTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// Phase 1.5: an implicit `import System` is seeded by default so common
/// BCL types (Console, String, ...) resolve without an explicit import. The
/// behaviour is opt-out via the `implicitSystemImport` parameter.
open class ImplicitImportTests {
    @Fact
    func Console_Resolves_Without_Explicit_Import() {
        let diagnostics = Bind(`func F() {
 Console.WriteLine("hi")
 }
`, useImplicit: true)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Console_Does_Not_Resolve_When_Implicit_Disabled() {
        let diagnostics = Bind(`func F() {
 Console.WriteLine("hi")
 }
`, useImplicit: false)
        Assert.NotEmpty(diagnostics)
    }

    @Fact
    func Explicit_Import_Coexists_With_Implicit() {
        // Same import declared explicitly + implicitly must not error.
        let diagnostics = Bind(`import System

func F() {
 Console.WriteLine("hi")
 }
`, useImplicit: true)
        Assert.Empty(diagnostics)
    }

    shared {
        private func Bind(source string, useImplicit bool) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(
                previous: nil,
                ImmutableArray.Create(tree),
                references: nil,
                implicitSystemImport: useImplicit
            )
            if globalScope.Diagnostics.Any() {
                return globalScope.Diagnostics
            }
            let program = Binder.BindProgram(globalScope)
            return program.Diagnostics.ToImmutableArray()
        }
    }
}
