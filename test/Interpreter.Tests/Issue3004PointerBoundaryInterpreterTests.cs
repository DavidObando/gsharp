// <copyright file="Issue3004PointerBoundaryInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3004: unmanaged pointer evaluation must fail loudly without breaking
/// managed-byref auto-dereference used by ordinary CLR members.
/// </summary>
public class Issue3004PointerBoundaryInterpreterTests
{
    public static TheoryData<string> UnsupportedPointerCases => new()
    {
        """
        import System

        unsafe {
            var x int32 = 7
            var p *int32 = &x
            x = 42
            Console.WriteLine(*p)
        }
        """,
        """
        import System

        unsafe {
            var p *int32 = nil
            Console.WriteLine(*p)
        }
        """,
    };

    public static TheoryData<string, int> ManagedByRefCases => new()
    {
        { "RefReturnProbe().Property", 40 },
        { "RefReturnProbe()[1]", 41 },
        { "RefReturnProbe().GetValue(2)", 42 },
    };

    [Theory]
    [InlineData("""
        import System

        unsafe {
            var a int32 = 5
            var b int32 = 5
            var pa *int32 = &a
            var pb *int32 = &b
            Console.WriteLine(pa == pb)
        }
        """)]
    [MemberData(nameof(UnsupportedPointerCases))]
    public void UnmanagedPointerOperation_ReportsGs0513(string source)
    {
        AssertPointerOperationIsRefused(source);
    }

    [Fact]
    public void IndexedAddress_CorrectValue10_IsRefusedRatherThanReevaluatedTo30()
    {
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

        AssertPointerOperationIsRefused(Source);
    }

    [Theory]
    [MemberData(nameof(ManagedByRefCases))]
    public void ManagedByRefAutoDereference_RemainsSupported(string expression, int expected)
    {
        var source = $"""
            import GSharp.Interpreter.Tests.ProbeRef

            {expression}
            """;

        var cell = new SessionEngine().Evaluate(source);

        Assert.False(cell.HasError, string.Join("\n", cell.Diagnostics));
        Assert.Equal(expected, cell.Value);
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

        var cell = new SessionEngine().Evaluate(Source);

        Assert.False(cell.HasError, string.Join("\n", cell.Diagnostics));
        Assert.Equal((42, true), cell.Value);
    }

    private static void AssertPointerOperationIsRefused(string source)
    {
        var cell = new SessionEngine().Evaluate(source);

        var diagnostic = Assert.Single(cell.Diagnostics);
        Assert.True(cell.HasError);
        Assert.Equal("GS0513", diagnostic.Id);
        Assert.Contains("compile this program with 'gsc' instead", diagnostic.Message);
    }
}
