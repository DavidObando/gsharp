// <copyright file="VisibilityModifierTests.cs" company="GSharp">
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

/// Phase 2.8: explicit `public` / `internal` / `private`
/// modifiers on top-level `func`, `type`, `var`, `let`,
/// and `const` declarations. Default for top-level is `public`
/// per ADR-0014.
open class VisibilityModifierTests {
    @Fact
    func PublicFunc_Binds_AsPublic() {
        let (diagnostics, scope_) = BindWithScope("public func F() { var x = 1 }\n")
        Assert.Empty(diagnostics)
        Assert.Equal(Accessibility.Public, FindFunction(scope_, "F").Accessibility)
    }

    @Fact
    func InternalFunc_Binds_AsInternal() {
        let (diagnostics, scope_) = BindWithScope("internal func F() { var x = 1 }\n")
        Assert.Empty(diagnostics)
        Assert.Equal(Accessibility.Internal, FindFunction(scope_, "F").Accessibility)
    }

    @Fact
    func PrivateFunc_Binds_AsPrivate() {
        let (diagnostics, scope_) = BindWithScope("private func F() { var x = 1 }\n")
        Assert.Empty(diagnostics)
        Assert.Equal(Accessibility.Private, FindFunction(scope_, "F").Accessibility)
    }

    @Fact
    func Func_WithoutModifier_DefaultsToPublic() {
        let (diagnostics, scope_) = BindWithScope("func F() { var x = 1 }\n")
        Assert.Empty(diagnostics)
        Assert.Equal(Accessibility.Public, FindFunction(scope_, "F").Accessibility)
    }

    @Fact
    func PublicTypeAlias_Binds() {
        let (diagnostics, _) = BindWithScope(`public type UserId = int32
func F() { var x UserId = 1 }
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func InternalGlobalVar_Binds() {
        let (diagnostics, scope_) = BindWithScope("internal var counter = 0\n")
        Assert.Empty(diagnostics)
        let counter = scope_!!.Variables.Single((v VariableSymbol) -> v.Name == "counter")
        Assert.Equal(Accessibility.Internal, (cast[GlobalVariableSymbol](counter)).Accessibility)
    }

    @Fact
    func PrivateGlobalLet_Binds() {
        let (diagnostics, scope_) = BindWithScope("private let secret = 42\n")
        Assert.Empty(diagnostics)
        let secret = scope_!!.Variables.Single((v VariableSymbol) -> v.Name == "secret")
        Assert.Equal(Accessibility.Private, (cast[GlobalVariableSymbol](secret)).Accessibility)
    }

    @Fact
    func ModifierBeforeNonDeclaration_ReportsError() {
        // `public 1 + 1` is not a valid declaration site.
        let diagnostics = Bind(`public
1 + 1
`)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("not allowed", StringComparison.OrdinalIgnoreCase)
        )
    }

    @Fact
    func ModifierInsideFunctionBody_ReportsError() {
        // Local variable declarations don't accept modifiers; treating `public` as a
        // keyword should surface a parse-time diagnostic.
        let diagnostics = Bind("func F() { public var x = 1 }\n")
        Assert.NotEmpty(diagnostics)
    }

    shared {
        private func FindFunction($scope BoundGlobalScope?, name string) FunctionSymbol -> $scope!!.Functions.Single(
            (f FunctionSymbol) -> f.Name == name
        )

        private func BindWithScope(source string)(Diagnostics ImmutableArray[Diagnostic], Scope BoundGlobalScope?) {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            if tree.Diagnostics.Any() {
                return (tree.Diagnostics, nil)
            }
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            if globalScope.Diagnostics.Any() {
                return (globalScope.Diagnostics, globalScope)
            }
            let program = Binder.BindProgram(globalScope)
            return (program.Diagnostics.ToImmutableArray(), globalScope)
        }

        private func Bind(source string) ImmutableArray[Diagnostic] -> BindWithScope(source).Diagnostics
    }
}
