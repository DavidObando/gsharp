// <copyright file="ManagedReferenceIndexTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Xunit;

namespace GSharp.Compiler.Tests;

public sealed class ManagedReferenceIndexTests
{
    [Theory]
    [InlineData("uint32", "4294967295")]
    [InlineData("int64", "4294967296")]
    [InlineData("int64", "-1")]
    [InlineData("uint64", "18446744073709551615")]
    [InlineData("nint", "4294967296")]
    [InlineData("nint", "-1")]
    [InlineData("nuint", "4294967296")]
    public void NativeWidthArraySelectionChecksBeforeNarrowing(string type, string high)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var source = $$"""
            package ManagedWideIndex
            import System
            var calls = 0
            func Index(value {{type}}) {{type}} {
                calls += 1
                return value
            }
            func Main() {
                let values = []int32{10, 20}
                let mutable = managed(values[Index({{type}}(1))])
                let view = readonly managed(values[Index({{type}}(1))])
                *mutable = 42
                Console.WriteLine(*view)
                try { let bad = managed(values[Index({{type}}({{high}}))]) }
                catch (e IndexOutOfRangeException) { Console.WriteLine("writable bounds") }
                try { let bad = readonly managed(values[Index({{type}}({{high}}))]) }
                catch (e IndexOutOfRangeException) { Console.WriteLine("readonly bounds") }
                Console.WriteLine(calls)
            }
            Main()
            """;
        var dll = fixture.Compile(source, "ManagedWideIndex", true);
        IlVerifier.Verify(dll);
        Assert.Equal("42\nwritable bounds\nreadonly bounds\n4\n", fixture.Run(dll));
    }
}
