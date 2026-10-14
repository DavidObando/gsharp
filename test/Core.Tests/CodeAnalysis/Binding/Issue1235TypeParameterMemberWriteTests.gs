// <copyright file="Issue1235TypeParameterMemberWriteTests.cs" company="GSharp">
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

/// Issue #1235 (write side, follow-up to
/// (cref:Issue1235TypeParameterClassMemberTests)): a variable whose
/// static type is a type parameter constrained to a class or a non-generic
/// user interface also exposes the constraint's settable field/property
/// surface for ASSIGNMENT (`t.F = v` / `t.P = v`), not only for
/// reads. Previously `ExpressionBinder.BindFieldAssignmentExpression`
/// only modelled a struct-symbol or interface-symbol variable receiver and
/// fell through to GS0158 "Cannot find member" for a type-parameter-typed
/// receiver — this surfaced in real-world generic factory methods such as
/// `where T : class, IFoo, new()` that build and populate a `T`
/// (Oahu migration gap: `BookLibrary.AddPersons<TPerson>`). The
/// companion object-initializer literal `T{Member: value}` (the
/// `where T : new()` counterpart of C#'s `new T { Member = value }`)
/// is covered at the emit layer by
/// `GSharp.Compiler.Tests.Emit.Issue1235TypeParameterObjectInitializerEmitTests`,
/// since constructing a type parameter is compiled-backend-only (issue #988).
open class Issue1235TypeParameterMemberWriteTests {
    @Fact
    func ClassConstraint_PropertyWrite_BindsAndReturnsValue() {
        let source = `
open class Base { prop P int32 { get; set; } }

func WriteP[T Base](t T) int32 {
    t.P = 7
    return t.P
}
WriteP[Base](Base())
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func ClassConstraint_FieldWrite_BindsAndReturnsValue() {
        let source = `
open class Base { var F2 int32 }

func WriteF[T Base](t T) int32 {
    t.F2 = 13
    return t.F2
}
WriteF[Base](Base())
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(13, result.Value)
    }

    @Fact
    func InterfaceConstraint_PropertyWrite_Binds() {
        // Mirrors Issue1068InterfacePropertyAccessTests.GetSetProperty_WriteThroughInterfaceReference_Binds:
        // writing through a non-generic interface reference (whether a plain
        // interface-typed variable or, as here, an interface-constrained type
        // parameter) is binder-verified here. The real setter dispatch is
        // covered through the compiled backend at runtime.
        let source = `
interface IHasName { prop Name int32 { get; set; } }
open class Named : IHasName { prop Name int32 { get; set; } }

func WriteName[T IHasName](t T) int32 {
    t.Name = 55
    return t.Name
}
WriteName[Named](Named())
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func UnknownMemberOnTypeParameter_WriteStillReportsGS0158() {
        let source = `
open class Base { var F2 int32 }

func Bad[T Base](t T) { t.Missing = 1 }
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
    }

    @Fact
    func NewConstraintObjectInitializerLiteral_ClassConstraint_BindsWithoutDiagnostics() {
        // Binder-level coverage for the `T{Member: value}` object-initializer
        // literal (the `where T : new()` counterpart of C#'s
        // `new T { Member = value }`); real construction only runs through the
        // compiled backend (issue #988), so end-to-end execution is covered by
        // GSharp.Compiler.Tests.Emit.Issue1235TypeParameterObjectInitializerEmitTests.
        let source = `
open class Base { prop P int32 { get; set; } }

func Make[T Base init()]() T { return T{P: 42} }
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func NewConstraintObjectInitializerLiteral_InterfaceConstraint_BindsWithoutDiagnostics() {
        let source = `
interface IHasName { prop Name int32 { get; set; } }
open class Named : IHasName { prop Name int32 { get; set; } }

func Make[T IHasName init()]() T { return T{Name: 99} }
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func NewConstraintObjectInitializerLiteral_UnknownMember_ReportsGS0158() {
        let source = `
open class Base { prop P int32 { get; set; } }

func Bad[T Base init()]() T { return T{Missing: 1} }
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0158")
    }

    @Fact
    func NewConstraintObjectInitializerLiteral_WithoutNewConstraint_ReportsGS0389() {
        let source = `
open class Base { prop P int32 { get; set; } }

func Bad[T Base]() T { return T{P: 1} }
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0389")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        private func Bind(source string) IReadOnlyList[Diagnostic] {
            let result = EmittedOracle.Evaluate(source)
            return result.Diagnostics.ToList()
        }
    }
}
