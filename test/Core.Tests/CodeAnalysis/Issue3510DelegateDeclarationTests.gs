// <copyright file="Issue3510DelegateDeclarationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #3510: named delegates use the standalone
/// `delegate Name[TParams]?(params) ReturnType? ;` declaration. The
/// required trailing semicolon terminates the optional return-type clause
/// (matching extern natives and interface bodiless members), fixing the
/// retired `type Name = delegate func(...)` form's greediness — a void
/// delegate used to consume whatever declaration followed it. `type`
/// itself left the reserved keyword set: erased aliases parse contextually
/// and `type` is an ordinary identifier everywhere else.
open class Issue3510DelegateDeclarationTests {
    @Fact
    func VoidDelegate_FollowedByDeclaration_NoLongerConsumesIt() {
        let source = `
delegate Bump(ref n int32);

func Run() int32 {
    let bump Bump = func(ref n int32) {
        n = n + 1
    }
    var x = 41
    bump(ref x)
    return x
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ReturningDelegate_WithOutParameter_RoundTrips() {
        let source = `
delegate TryShape(out v int32) bool;

func Run() int32 {
    let tryGet TryShape = func(out v int32) bool {
        v = 7
        return true
    }
    if tryGet(out var got) {
        return got
    }
    return 0
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(7, result.Value)
    }

    @Fact
    func GenericPublicDelegate_Declares() {
        let source = `
public delegate Mapper[T any](value T) T;

func Run() int32 {
    let twice Mapper[int32] = func(value int32) int32 {
        return value * 2
    }
    return twice(21)
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, result.Value)
    }

    @Fact
    func MissingSemicolon_Reports() {
        let source = `
delegate Bump(ref n int32)

func Run() int32 {
    return 1
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.IsError && d.Id == "GS0005")
    }

    @Fact
    func RetiredTypeDelegateSpelling_ReportsGS0535WithRecovery() {
        let source = `
type Greeter = delegate func(name string)

func Run() int32 {
    return 1
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        let errors = result.Diagnostics.Where((d Diagnostic) -> d.IsError).ToList()
        let single = Assert.Single(errors)
        Assert.Equal("GS0535", single.Id)
    }

    @Fact
    func TypeIsAnOrdinaryIdentifierNow() {
        let source = `
func Run() string {
    var type = "works"
    return type
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("works", result.Value)
    }

    @Fact
    func ErasedTypeAlias_StillParsesContextually() {
        let source = `
type Count = int32

func Run() Count {
    var v Count = 42
    return v
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, result.Value)
    }
}
