// <copyright file="Issue2203PackageNameTypeCollisionTests.cs" company="GSharp">
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

/// Issue #2203: a type whose simple name equals the last segment of its own
/// containing package (e.g. `class Tokens` in `package
/// Oahu.Cli.Tui.Tokens`) failed member resolution with GS0158 when
/// referenced from a sibling package as `Tokens.Tokens.Member`. This
/// double-qualified form arises from cs2gs translating C# source that relies
/// on the sibling-namespace-visibility rule (a nested namespace is visible
/// unqualified from a sibling namespace under a shared ancestor) — the
/// leading "Tokens" plays the namespace's role there, but G# has no namespace
/// concept and instead resolves the type by simple name from its flat,
/// cross-package type scope, so the leading qualifier is redundant and must
/// be peeled off.
open class Issue2203PackageNameTypeCollisionTests {
    @Fact
    func TypeNameEqualsPackageTail_DoubleQualifiedStaticMethodCall_Resolves() {
        let tree1 = SyntaxTree.Parse(SourceText.From(`package Oahu.Cli.Tui.Tokens
open class Tokens {
    shared {
        func Hello() string { return "hi" }
    }
}`))
        let tree2 = SyntaxTree.Parse(
            SourceText.From("package Oahu.Cli.Tui.Widgets\nConsole.WriteLine(Tokens.Tokens.Hello())")
        )
        Assert.Empty(BindDiagnostics(tree1, tree2))
    }

    @Fact
    func TypeNameEqualsPackageTail_DoubleQualifiedStaticFieldAccess_Resolves() {
        let tree1 = SyntaxTree.Parse(SourceText.From(`package Oahu.Cli.Tui.Tokens
open class Tokens {
    shared {
        var TextPrimary string = "primary"
    }
}`))
        let tree2 = SyntaxTree.Parse(
            SourceText.From("package Oahu.Cli.Tui.Widgets\nConsole.WriteLine(Tokens.Tokens.TextPrimary)")
        )
        Assert.Empty(BindDiagnostics(tree1, tree2))
    }

    @Fact
    func TypeNameDoesNotEqualPackageTail_DoubleQualifiedCall_StillReportsUnresolvedMember() {
        // Regression guard: the fix must not blanket-accept every "X.X.Member"
        // shape — it only peels the qualifier when the type's own package tail
        // actually matches the qualifier. Here "Widgets" (the package tail) does
        // not match "Tokens" (the leading qualifier), so the erroneous double
        // qualification should still surface as an unresolved-member error.
        let tree1 = SyntaxTree.Parse(SourceText.From(`package Oahu.Cli.Tui.Widgets
open class Tokens {
    shared {
        func Hello() string { return "hi" }
    }
}`))
        let tree2 = SyntaxTree.Parse(
            SourceText.From("package Oahu.Cli.Tui.Other\nConsole.WriteLine(Tokens.Tokens.Hello())")
        )
        Assert.Contains(BindDiagnostics(tree1, tree2), (d Diagnostic) -> d.Id == "GS0158")
    }

    shared {
        private func BindDiagnostics(trees ...SyntaxTree) ImmutableArray[Diagnostic] {
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(trees))
            let program = Binder.BindProgram(globalScope)
            return globalScope.Diagnostics.Concat(program.Diagnostics).ToImmutableArray()
        }
    }
}
