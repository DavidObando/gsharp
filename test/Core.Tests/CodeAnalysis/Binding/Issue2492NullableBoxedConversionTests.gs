// <copyright file="Issue2492NullableBoxedConversionTests.cs" company="GSharp">
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

/// Issue #2492: explicit object/interface unboxing remains available when the
/// source and target carry nullable annotations. The conversion is explicit
/// only and is restricted to interface/value-type pairs that can actually box
/// and unbox through that interface.
class Issue2492NullableBoxedConversionTests {
    @Fact
    func ExplicitNullableBoxedSources_ToNullableValueTypes_Compile() {
        const source = `package issue2492bindingpositive
import System

interface IBox2492 {}
struct Local2492(Value int32) : IBox2492 {}
enum Color2492 { Red, Green }

func Primitive(value object?) uint32? -> uint32?(value)
func Imported(value object?) Guid? -> Guid?(value)
func ValueTypeSource(value ValueType?) Guid? -> Guid?(value)
func EnumBaseSource(value Enum?) DayOfWeek? -> DayOfWeek?(value)
func Local(value object?) Local2492? -> Local2492?(value)
func EnumValue(value object?) Color2492? -> Color2492?(value)
func Generic[T struct](value object?) T? -> T?(value)
func ImportedInterface(value IComparable?) int32? -> int32?(value)
func UserInterface(value IBox2492?) Local2492? -> Local2492?(value)
func NonNullableImportedInterface(value IComparable) int32? -> int32?(value)
func NonNullableUserInterface(value IBox2492) Local2492? -> Local2492?(value)
func NonNullableObjectControl(value object) uint32? -> uint32?(value)
func NonNullableTargetControl(value object?) uint32 -> uint32(value)
func AsControl(value object?) uint32? -> value as uint32?`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func ExplicitCast_AfterInterfacePatternNarrowing_Compiles() {
        const source = `package issue2492bindingpattern
import System

func Convert(value object?) int32? {
    if value is IComparable {
        return int32?(value)
    }

    return nil
}`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func ImplicitNullableObjectToNullableValue_RemainsRejectedAsExplicitOnly() {
        const source = `package issue2492bindingimplicit

func Sink(value int32?) void {}
func Return(value object?) int32? -> value
func Assign(value object?) void {
    let converted int32? = value
    Sink(value)
}`
        let diagnostics = Evaluate(source).Diagnostics
        Assert.Equal(2, diagnostics.Count((d Diagnostic) -> d.Id == "GS0156"))
        Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0154")
    }

    @Fact
    func InvalidReferenceAndInterfaceSources_ReportNoConversion() {
        const source = `package issue2492bindinginvalid
import System

func FromString(value string?) int32? -> int32?(value)
func FromUnrelatedInterface(value IDisposable?) int32? -> int32?(value)
func FromEnumBase(value Enum?) int32? -> int32?(value)`
        let diagnostics = Evaluate(source).Diagnostics
        Assert.Equal(3, diagnostics.Count((d Diagnostic) -> d.Id == "GS0155"))
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate([]string{source}, EmittedOracleOptions{IsLibrary: true})
        }
    }
}
