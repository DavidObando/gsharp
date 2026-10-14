// <copyright file="Issue1214GenericExplicitInitCtorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1214: a generic class that declares an explicit `init(...)`
/// constructor can be constructed at a closed type (`Box[int32](5, "x")`).
/// Previously the binder reported GS0217 ("generic explicit constructors are not
/// supported") and refused to bind such a construction. The fix closes the
/// generic definition (resolving type arguments explicitly or by inference) and
/// binds against the explicit constructor's type-argument-substituted parameter
/// list. These tests assert the construction binds cleanly, that GS0217 no
/// longer fires, and that the surrounding diagnostics (arity, argument type,
/// constraints) still behave for the generic case.
open class Issue1214GenericExplicitInitCtorTests {
    @Fact
    func GenericClass_ExplicitInitCtor_ConstructsAtClosedType_CompilesCleanly() {
        // The minimal #1214 repro: explicit init on a generic class, constructed
        // through a closed `Mp4Operation[int32]`.
        let source = `package p
open class Mp4Operation[TOutput] {
    init(name string) { }
}
func Make() Mp4Operation[int32] {
    return Mp4Operation[int32]("x")
}`
        let diagnostics = Diagnose(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func NonGenericClass_ExplicitInitCtor_StillCompilesCleanly() {
        // Control: the identical shape with a NON-generic class must keep working.
        let source = `package p
open class Op {
    init(name string) { }
}
func MakeOk() Op {
    return Op("x")
}`
        let diagnostics = Diagnose(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func GenericClass_ExplicitInitCtor_NoLongerReportsGs0217() {
        let source = `package p
class Box[T] {
    let value T
    init(v T) { value = v }
}
func Use() {
    let b = Box[int32](5)
}`
        let diagnostics = Diagnose(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0217")
        Assert.Empty(diagnostics)
    }

    @Fact
    func GenericClass_ExplicitInitCtor_FieldsFromTypeParameterAndString_CompilesCleanly() {
        let source = `package p
class Box[T] {
    let value T
    var label string
    init(v T, l string) {
        value = v
        label = l
    }
    func Get() T { return value }
}
func Use() int32 {
    let b = Box[int32](5, "x")
    return b.Get()
}`
        let diagnostics = Diagnose(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func GenericClass_ExplicitInitCtor_WrongArgumentType_ReportsDiagnostic() {
        // A type argument that closes `T` to int32 means passing a string for the
        // `T` parameter must be a wrong-argument-type error, not GS0217.
        let source = `package p
class Box[T] {
    let value T
    init(v T) { value = v }
}
func Use() {
    let b = Box[int32]("x")
}`
        let diagnostics = Diagnose(source)
        Assert.NotEmpty(diagnostics)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0217")
    }

    @Fact
    func GenericClass_ExplicitInitCtor_WrongArity_ReportsDiagnostic() {
        let source = `package p
class Box[T] {
    let value T
    init(v T) { value = v }
}
func Use() {
    let b = Box[int32](5, 6)
}`
        let diagnostics = Diagnose(source)
        Assert.NotEmpty(diagnostics)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0217")
    }

    @Fact
    func GenericClass_ExplicitInitCtor_WrongTypeArgumentCount_ReportsDiagnostic() {
        let source = `package p
class Box[T] {
    let value T
    init(v T) { value = v }
}
func Use() {
    let b = Box[int32, string](5)
}`
        let diagnostics = Diagnose(source)
        Assert.NotEmpty(diagnostics)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0217")
    }

    @Fact
    func GenericClass_ExplicitInitCtor_InferredTypeArguments_CompilesCleanly() {
        // No explicit `[…]`: the type argument is inferred from the value
        // argument against the constructor's parameter list.
        let source = `package p
class Box[T] {
    let value T
    init(v T) { value = v }
    func Get() T { return value }
}
func Use() int32 {
    let b = Box(5)
    return b.Get()
}`
        let diagnostics = Diagnose(source)
        Assert.Empty(diagnostics)
    }

    shared {
        private func Diagnose(source string) ImmutableArray[Diagnostic] {
            // Bind the full program (function bodies included) so that a
            // construction expression inside a function body is actually bound and
            // any diagnostic surfaces. BindGlobalScope alone only binds signatures
            // and declaration-level constructs (e.g. `: base(...)`), not bodies.
            let result = EmittedOracle.Evaluate(source)
            return result.Diagnostics
        }
    }
}
