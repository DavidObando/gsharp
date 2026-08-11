// <copyright file="Issue3004PointerBoundaryInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3004 residue after the tree-walking evaluator retired (ADR-0156
/// Phase 3c, #3176). The GS0513 unmanaged-pointer boundary (ADR-0153)
/// existed because the evaluator had no real storage locations to point at;
/// emitted execution runs the compiled storage model natively, so the exact
/// programs the boundary refused now execute — and must produce the CORRECT
/// pointer semantics the evaluator could not (true aliasing, address capture
/// at the moment of the address-of). Managed-byref auto-dereference and
/// ref/out address-of, which always worked, stay covered too.
/// </summary>
public class Issue3004PointerBoundaryInterpreterTests
{
    [Fact]
    public void PointerAlias_ObservesLaterWriteThroughDereference()
    {
        const string Source = """
            import System

            unsafe {
                var x int32 = 7
                var p *int32 = &x
                x = 42
                Console.WriteLine(*p)
            }
            """;

        AssertOutput(Source, "42\n");
    }

    [Fact]
    public void DistinctLocals_HaveDistinctAddresses()
    {
        const string Source = """
            import System

            unsafe {
                var a int32 = 5
                var b int32 = 5
                var pa *int32 = &a
                var pb *int32 = &b
                Console.WriteLine(pa == pb)
            }
            """;

        AssertOutput(Source, "False\n");
    }

    [Fact]
    public void IndexedAddress_CapturesElementAtAddressOfTime()
    {
        // The exact program the evaluator refused (it would have re-evaluated
        // the index expression and printed 30); the emitted pointer pins
        // &arr[0] at address-of time and prints 10.
        const string Source = """
            import System

            unsafe {
                var arr = []int32{10, 20, 30}
                var i int32 = 0
                var p *int32 = &arr[i]
                i = 2
                Console.WriteLine(*p)
            }
            """;

        AssertOutput(Source, "10\n");
    }

    [Theory]
    [InlineData("ManagedByRefAutoDereferenceFixture().Property", 40)]
    [InlineData("ManagedByRefAutoDereferenceFixture()[1]", 41)]
    [InlineData("ManagedByRefAutoDereferenceFixture().GetValue(2)", 42)]
    public void ManagedByRefAutoDereference_RemainsSupported(string expression, int expected)
    {
        var source = $"""
            import GSharp.Interpreter.Tests.Issue3004

            {expression}
            """;

        var result = EmittedOracle.Evaluate(source);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(expected, result.Value);
    }

    [Fact]
    public void RefOutAddressInsideUnsafe_RemainsSupported()
    {
        const string Source = """
            func tryProduce(out result int32) bool {
                result = 42
                return true
            }

            var slot = 0
            var ok = false
            unsafe {
                ok = tryProduce(&slot)
            }
            (slot, ok)
            """;

        var result = EmittedOracle.Evaluate(Source);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal((42, true), result.Value);
    }

    private static void AssertOutput(string source, string expected)
    {
        var result = EmittedOracle.Evaluate(source);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(expected, result.Output.ReplaceLineEndings(Environment.NewLine));
    }
}
