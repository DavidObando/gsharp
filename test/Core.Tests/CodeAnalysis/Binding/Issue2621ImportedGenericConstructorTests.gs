// <copyright file="Issue2621ImportedGenericConstructorTests.cs" company="GSharp">
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
import System.Collections.Immutable
import Xunit

class Issue2621ImportedGenericConstructorTests {
    @Fact
    func OahuCli_ListOfNestedGeneric_WithCapacity_Binds() {
        const source = `package Oahu.Cli.Commands
import System.Collections.Generic

func BuildRows(capacity int32) List[IReadOnlyDictionary[string, object?]] {
    return List[IReadOnlyDictionary[string, object?]](capacity)
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func ImportedGenericConstructor_MismatchedOverload_IsNotMissingFunction() {
        const source = `package Oahu.Cli.Commands
import System.Collections.Generic

func BuildRows() {
    let rows = List[IReadOnlyDictionary[string, object?]]("bad")
}`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0267")
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0130")
    }

    @Fact
    func ImportedGenericConstructor_ArgumentError_DoesNotCascadeToMissingFunction() {
        const source = `package Oahu.Cli.Commands
import System.Collections.Generic

func BuildRows() {
    let rows = List[IReadOnlyDictionary[string, object?]](missing.Count)
}`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0157")
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0130" or "GS0267"))
    }

    @Fact
    func ImportedGenericValueType_ConversionCallFromObject_Unboxes() {
        // Issue #3684 (family F8): `ImmutableArray[int32](o)` is the G#
        // spelling of a C# `(ImmutableArray<int>)o` CAST, not a construction —
        // there is no single-`object` `.ctor`. The constructor-overload
        // fallback offered a checked REFERENCE conversion only, which a value
        // type can never satisfy, so the whole shape reported GS0267.
        const source = `package Demo
import System.Collections.Immutable

func Take(o object) ImmutableArray[int32] {
    return ImmutableArray[int32](o)
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func ImportedGenericValueType_ConversionCallFromUnrelatedValue_StillReportsNoOverload() {
        // The unboxing fallback must not swallow a genuinely impossible
        // conversion: an `int32` source is not a box, so there is nothing to
        // unbox and GS0267 still stands.
        const source = `package Demo
import System.Collections.Immutable

func Take(n int32) {
    let taken = ImmutableArray[int32](n)
}`
        Assert.Contains(Bind(source), (diagnostic Diagnostic) -> diagnostic.Id == "GS0267")
    }

    @Fact
    func ImportedGenericDelegate_ConversionCallFromLambda_Binds() {
        // Issue #3684 (family F8), third shape: `Func[int32, int32](lambda)` is
        // the G# form of a C# `(Func<int, int>)(e => …)` cast. The CLR delegate
        // `.ctor` takes `(object, IntPtr)`, so the one-argument call never
        // resolved and the cast reported GS0267.
        const source = `package Demo
import System

func Wrap() Func[int32, int32] {
    return Func[int32, int32](((e int32) -> e + 1))
}`
        Assert.Empty(Bind(source))
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            return EmittedOracle.Evaluate(source).Diagnostics
        }
    }
}
