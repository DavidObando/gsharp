// <copyright file="Issue1056ClassConstraintTests.cs" company="GSharp">
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
import Xunit

/// Issue #1056: a base CLASS (non-interface) may be used as a generic
/// type-parameter constraint, mirroring C#'s `where T : BaseClass`. The
/// constraint class's accessible instance members bind on values of `T`,
/// a type argument that does not derive from the constraint is rejected
/// (GS0152), and a value type used as a base constraint is still rejected
/// (GS0153). The single legacy constraint slot structurally enforces C#'s
/// at-most-one-class rule.
open class Issue1056ClassConstraintTests {
    @Fact
    func BaseClassConstraint_Binds_NoDiagnostics() {
        let source = `
class Animal { func Speak() string { return "..." } }

func Describe[T Animal](x T) string { return "ok" }
Describe(Animal{})
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func BaseClassConstraint_MemberDispatchOnT_BindsAndDispatchesOverride() {
        // An instance member declared on the constraint class binds on values of
        // T, and virtual dispatch resolves the most-derived override.
        let source = `
open class Animal { open func Speak() string { return "..." } }
open class Dog : Animal { override func Speak() string { return "woof" } }

func Describe[T Animal](x T) string { return x.Speak() }
Describe[Dog](Dog())
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("woof", result.Value)
    }

    @Fact
    func NonDerivingTypeArgument_ReportsGS0152() {
        let source = `
open class Animal { open func Speak() string { return "..." } }

func Describe[T Animal](x T) string { return "ok" }
Describe[int32](0)
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0152")
    }

    @Fact
    func ValueTypeConstraint_StillReportsGS0153() {
        // C# forbids `where T : SomeStruct`; a value type is not a legal base
        // constraint even after issue #1056 permits class constraints.
        let source = `
struct Val { var X int32 }

func F[T Val](x T) int32 { return 0 }
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0153")
    }

    @Fact
    func SelfReferentialBaseClassConstraint_Binds() {
        // CRTP `class Box[T Box]` / `class Box[T Box[T]]`: the declaring class
        // names itself in its own type-parameter constraint.
        let source = `
open class Box[T Box] {}
open class Box2[T Box2[T]] {}
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0153")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0113")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
