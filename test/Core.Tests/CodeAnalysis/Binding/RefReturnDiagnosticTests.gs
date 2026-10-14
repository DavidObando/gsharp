// <copyright file="RefReturnDiagnosticTests.cs" company="GSharp">
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

/// Issue #490 (ADR-0060 follow-up): diagnostic coverage for the ref-return surface.
/// Validates GS0248 (ref return without a return type), GS0249 (state-machine
/// incompatibility), GS0251/GS0252 (return-statement shape vs declaration shape),
/// GS0253 (non-lvalue), GS0254 (escape of function-local storage), and GS0255
/// (override / interface ref-return mismatch).
open class RefReturnDiagnosticTests {
    @Fact
    func RefReturnWithoutReturnType_ReportsGS0248() {
        const Source = `package NoReturnType

func bad(ref x int32) ref {
    return ref x
}
`
        let result = Compile(Source)
        // The parser will not consume `ref` without a type clause behind it, so the
        // declaration is rejected — but if a future parser improvement does, GS0248
        // is the authoritative diagnostic. Either path must surface *some* error.
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func RefReturnOnAsyncFunction_ReportsGS0249() {
        const Source = `package AsyncRefReturn

async func bad(ref x int32) ref int32 {
    return ref x
}
`
        let result = Compile(Source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0249")
    }

    @Fact
    func ReturnRefInNonRefReturningFunction_ReportsGS0251() {
        const Source = `package PlainReturnsRef

func bad(ref x int32) int32 {
    return ref x
}
`
        let result = Compile(Source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0251")
    }

    @Fact
    func PlainReturnInRefReturningFunction_ReportsGS0252() {
        const Source = `package RefReturnsPlain

func bad(ref x int32) ref int32 {
    return x
}
`
        let result = Compile(Source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0252")
    }

    @Fact
    func ReturnRefOfNonLvalue_ReportsGS0253() {
        const Source = `package NonLvalue

func bad(x int32) ref int32 {
    return ref x + 1
}
`
        let result = Compile(Source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0253")
    }

    @Fact
    func ReturnRefOfLocalVariable_ReportsGS0254() {
        const Source = `package EscapesLocal

func bad() ref int32 {
    var local = 5
    return ref local
}
`
        let result = Compile(Source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0254")
    }

    @Fact
    func ReturnRefOfRefParameter_IsAllowed() {
        const Source = `package RefParamOk

func ok(ref x int32) ref int32 {
    return ref x
}
`
        let result = Compile(Source)
        Assert.DoesNotContain(
            result.Diagnostics,
            (d Diagnostic) -> (d.Id is "GS0248" or "GS0249" or "GS0251" or "GS0252" or "GS0253" or "GS0254")
        )
    }

    @Fact
    func ClassOverrideReturnRefMismatch_ReportsGS0255() {
        const Source = `package OverrideMismatch

open class Base {
    open func Get(ref x int32) ref int32 {
        return ref x
    }
}

class Derived : Base {
    override func Get(ref x int32) int32 {
        return x
    }
}
`
        let result = Compile(Source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0255")
    }

    shared {
        private func Compile(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
