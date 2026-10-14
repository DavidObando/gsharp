// <copyright file="ManagedReferenceIndexTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import Xunit

class ManagedReferenceIndexTests {
    @Theory
    @InlineData("uint32", "4294967295")
    @InlineData("int64", "4294967296")
    @InlineData("int64", "-1")
    @InlineData("uint64", "18446744073709551615")
    @InlineData("nint", "4294967296")
    @InlineData("nint", "-1")
    @InlineData("nuint", "4294967296")
    func NativeWidthArraySelectionChecksBeforeNarrowing(type string, high string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = (`package ManagedWideIndex
import System
var calls = 0
func Index(value ` + "$type" + `) ` + "$type" + ` {
    calls += 1
    return value
}
func Main() {
    let values = []int32{10, 20}
    let mutable = managed(values[Index(` + "$type" + `(1))])
    let view = readonly managed(values[Index(` + "$type" + `(1))])
    *mutable = 42
    Console.WriteLine(*view)
    try { let bad = managed(values[Index(` + "$type" + `(` + "$high" + `))]) }
    catch (e IndexOutOfRangeException) { Console.WriteLine("writable bounds") }
    try { let bad = readonly managed(values[Index(` + "$type" + `(` + "$high" + `))]) }
    catch (e IndexOutOfRangeException) { Console.WriteLine("readonly bounds") }
    Console.WriteLine(calls)
}
Main()`)
        let dll = fixture.Compile(source, "ManagedWideIndex", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`42
writable bounds
readonly bounds
4
`, fixture.Run(dll))
    }
}
