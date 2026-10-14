// <copyright file="NamedDelegateBindingTests.cs" company="GSharp">
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

/// ADR-0059 / issue #255: binder tests for named delegate type declarations.
open class NamedDelegateBindingTests {
    @Fact
    func DeclareAndUse_NamedDelegate_Binds_Without_Diagnostics() {
        let source = `
package P
import System

delegate Combine(a int32, b int32) int32;

var sum Combine = func(a int32, b int32) int32 {
    return a + b
}

Console.WriteLine(sum.Invoke(2, 40))
`
        let diagnostics = Bind(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func GenericDelegate_Binds_Without_Diagnostics() {
        // Issue #1503: a generic named delegate declaration now binds without
        // diagnostics (GS0234 retired). Single and multi type-parameter shapes,
        // and a type parameter used in a composite return type, all bind.
        let source = `
package P

delegate Box[T any](value T) T;
delegate Converter[TIn any, TOut any](x TIn) TOut;
delegate Mapper[T any](items []T) []T;
`
        let diagnostics = Bind(source)
        Assert.Empty(diagnostics)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0234")
    }

    @Fact
    func GenericDelegate_Construct_And_Use_Binds_Without_Diagnostics() {
        // Issue #1503: a generic delegate constructed over a concrete type
        // argument binds as a parameter/local type and is assignable from a
        // matching func literal.
        let source = `
package P
import System

delegate Predicate1503[T any](value T) bool;

var isPositive Predicate1503[int32] = func(value int32) bool {
    return value > 0
}

Console.WriteLine(isPositive.Invoke(7))
`
        let diagnostics = Bind(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func DelegateDeclaration_Without_Func_Reports_GS0233() {
        let source = `
package P

type Bad = delegate int32
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0233")
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            if tree.Diagnostics.Any() {
                return tree.Diagnostics
            }
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            if globalScope.Diagnostics.Any() {
                return globalScope.Diagnostics
            }
            let program = Binder.BindProgram(globalScope)
            return program.Diagnostics.ToImmutableArray()
        }
    }
}
