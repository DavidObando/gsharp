// <copyright file="Issue3004PointerBoundaryInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import Xunit

/// Issue #3004 residue after the tree-walking evaluator retired (ADR-0156
/// Phase 3c, #3176). The GS0513 unmanaged-pointer boundary (ADR-0153)
/// existed because the evaluator had no real storage locations to point at;
/// emitted execution runs the compiled storage model natively, so the exact
/// programs the boundary refused now execute — and must produce the CORRECT
/// pointer semantics the evaluator could not (true aliasing, address capture
/// at the moment of the address-of). Managed-byref auto-dereference and
/// ref/out address-of, which always worked, stay covered too.
open class Issue3004PointerBoundaryInterpreterTests {
    @Fact
    func PointerAlias_ObservesLaterWriteThroughDereference() {
        const Source = `import System

unsafe {
    var x int32 = 7
    var p *int32 = &x
    x = 42
    Console.WriteLine(*p)
}`
        AssertOutput(Source, "42\n")
    }

    @Fact
    func DistinctLocals_HaveDistinctAddresses() {
        const Source = `import System

unsafe {
    var a int32 = 5
    var b int32 = 5
    var pa *int32 = &a
    var pb *int32 = &b
    Console.WriteLine(pa == pb)
}`
        AssertOutput(Source, "False\n")
    }

    @Fact
    func IndexedAddress_CapturesElementAtAddressOfTime() {
        // The exact program the evaluator refused (it would have re-evaluated
        // the index expression and printed 30); the emitted pointer pins
        // &arr[0] at address-of time and prints 10.
        const Source = `import System

unsafe {
    var arr = []int32{10, 20, 30}
    var i int32 = 0
    var p *int32 = &arr[i]
    i = 2
    Console.WriteLine(*p)
}`
        AssertOutput(Source, "10\n")
    }

    @Theory
    @InlineData("ManagedByRefAutoDereferenceFixture().Property", int32(40))
    @InlineData("ManagedByRefAutoDereferenceFixture()[1]", int32(41))
    @InlineData("ManagedByRefAutoDereferenceFixture().GetValue(2)", int32(42))
    func ManagedByRefAutoDereference_RemainsSupported(expression string, expected int32) {
        let source = (`import GSharp.Interpreter.Tests.Issue3004

` + "$expression")
        let result = EmittedOracle.Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
        Assert.Equal(expected, result.Value)
    }

    @Fact
    func RefOutAddressInsideUnsafe_RemainsSupported() {
        const Source = `func tryProduce(out result int32) bool {
    result = 42
    return true
}

var slot = 0
var ok = false
unsafe {
    ok = tryProduce(&slot)
}
(slot, ok)`
        let result = EmittedOracle.Evaluate(Source)
        Assert.DoesNotContain(result.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
        Assert.Equal((42, true), result.Value)
    }

    shared {
        private func AssertOutput(source string, expected string) {
            let result = EmittedOracle.Evaluate(source)
            Assert.DoesNotContain(result.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
            Assert.Equal(expected, result.Output.ReplaceLineEndings(Environment.NewLine))
        }
    }
}
