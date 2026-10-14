// <copyright file="Issue988NewConstraintConstructionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #988: binder-level coverage for constructing a type parameter under a
/// `init()` default-constructor constraint (`T()` where `[T init()]`).
/// The construction is reified to `Activator.CreateInstance<T>()` at
/// emit time (see `Issue988TypeParameterConstructionEmitTests`); these
/// tests lock in the binder contract: the construction binds clean when the
/// constraint is present, GS0389 fires when it is absent, and GS0152 fires when
/// a type argument cannot satisfy `init()`.
open class Issue988NewConstraintConstructionTests {
    @Fact
    func NewConstraint_ConstructTypeParameterInGenericClass_BindsWithoutDiagnostics() {
        let source = `
class Factory[T init()] {
    func Make() T { return T() }
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func NewConstraint_ConstructTypeParameterInGenericFunction_BindsWithoutDiagnostics() {
        let source = `
func make[U init()]() U { return U() }
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func ConstructTypeParameterWithoutNewConstraint_ReportsGs0389() {
        let source = `
class Factory[T class] {
    func Make() T { return T() }
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0389")
    }

    @Fact
    func ConstructUnconstrainedTypeParameter_ReportsGs0389() {
        let source = `
func make[U any]() U { return U() }
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0389")
    }

    @Fact
    func NewConstraint_TypeArgumentWithoutParameterlessCtor_ReportsGs0152() {
        let source = `
class NoCtor(Value int32) { }
class Factory[T init()] {
    func Make() T { return T() }
}
let f = Factory[NoCtor]()
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0152")
    }

    @Fact
    func NewConstraint_ValueTypeArgument_SatisfiesConstraint() {
        let source = `
class Factory[T init()] {
    func Make() T { return T() }
}
let f = Factory[int32]()
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0152")
    }

    shared {
        private func Bind(source string) IReadOnlyList[Diagnostic] {
            let result = EmittedOracle.Evaluate(source)
            return result.Diagnostics.ToList()
        }
    }
}
