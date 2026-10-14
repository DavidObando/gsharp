// <copyright file="Issue2494EnumLinqExtremaTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #2494: imported generic LINQ methods must preserve a symbolic
/// same-compilation enum type. In particular, the enum's temporary
/// `int32` CLR projection may help imported-member lookup, but it must
/// not make the concrete numeric `Min`/`Max` overloads semantically
/// applicable or leak `int32` into the bound result.
class Issue2494EnumLinqExtremaTests {
    @Fact
    func MinMax_SourceEnumReceiverShapes_BindAsSourceEnum() {
        const source = `package issue2494bindingreceivers
import System.Collections.Generic
import System.Linq

enum Choice2494 { Low, Middle, High }

func ArrayMin(values []Choice2494) Choice2494 -> values.Min()
func ArrayMax(values []Choice2494) Choice2494 -> values.Max()
func EnumerableMin(values IEnumerable[Choice2494]) Choice2494 -> values.Min()
func EnumerableMax(values IEnumerable[Choice2494]) Choice2494 -> values.Max()
func NullableEnumerableMin(values IEnumerable[Choice2494]?) Choice2494 -> values.Min()
func ListMin(values List[Choice2494]) Choice2494 -> values.Min()
func ListMax(values List[Choice2494]) Choice2494 -> values.Max()
func StaticMin(values []Choice2494) Choice2494 -> Enumerable.Min(values)
func StaticMax(values []Choice2494) Choice2494 -> Enumerable.Max(values)
func DictionaryValuesMin(values Dictionary[string, Choice2494]) Choice2494 ->
    values.Values.Min()
func PipelineMin(values []Choice2494) Choice2494 ->
    values.Select((value Choice2494) -> value).Distinct().Min()
func PipelineMax(values []Choice2494) Choice2494 ->
    values.Select((value Choice2494) -> value).Distinct().Max()`
        let compilation = Compile(source)
        AssertGenericSourceEnumCall(FindCall(compilation, "ArrayMin", "Min"), "Choice2494")
        AssertGenericSourceEnumCall(FindCall(compilation, "ArrayMax", "Max"), "Choice2494")
        AssertGenericSourceEnumCall(FindCall(compilation, "EnumerableMin", "Min"), "Choice2494")
        AssertGenericSourceEnumCall(FindCall(compilation, "EnumerableMax", "Max"), "Choice2494")
        AssertGenericSourceEnumCall(FindCall(compilation, "NullableEnumerableMin", "Min"), "Choice2494")
        AssertGenericSourceEnumCall(FindCall(compilation, "ListMin", "Min"), "Choice2494")
        AssertGenericSourceEnumCall(FindCall(compilation, "ListMax", "Max"), "Choice2494")
        AssertGenericSourceEnumCall(FindCall(compilation, "StaticMin", "Min"), "Choice2494")
        AssertGenericSourceEnumCall(FindCall(compilation, "StaticMax", "Max"), "Choice2494")
        AssertGenericSourceEnumCall(FindCall(compilation, "DictionaryValuesMin", "Min"), "Choice2494")
        AssertGenericSourceEnumCall(FindCall(compilation, "PipelineMin", "Min"), "Choice2494")
        AssertGenericSourceEnumCall(FindCall(compilation, "PipelineMax", "Max"), "Choice2494")
        AssertNoErrors(compilation)
    }

    @Fact
    func MinMax_NullableEnumAndSelectorOverloads_PreserveProjectedEnumType() {
        const source = `package issue2494bindingselectors
import System.Linq

enum Choice2494 { Low, Middle, High }
data class Item2494(State Choice2494, Optional Choice2494?) {}

func NullableMin(values []Choice2494?) Choice2494? -> values.Min()
func NullableMax(values []Choice2494?) Choice2494? -> values.Max()
func SelectorMin(values []Item2494) Choice2494 ->
    values.Min((item Item2494) -> item.State)
func SelectorMax(values []Item2494) Choice2494 ->
    values.Max((item Item2494) -> item.State)
func NullableSelectorMin(values []Item2494) Choice2494? ->
    values.Min((item Item2494) -> item.Optional)
func NullableSelectorMax(values []Item2494) Choice2494? ->
    values.Max((item Item2494) -> item.Optional)`
        let compilation = Compile(source)
        AssertNoErrors(compilation)
        AssertNullableSourceEnum(FindCall(compilation, "NullableMin", "Min").Type, "Choice2494")
        AssertNullableSourceEnum(FindCall(compilation, "NullableMax", "Max").Type, "Choice2494")
        AssertSourceEnum(FindCall(compilation, "SelectorMin", "Min").Type, "Choice2494")
        AssertSourceEnum(FindCall(compilation, "SelectorMax", "Max").Type, "Choice2494")
        AssertNullableSourceEnum(FindCall(compilation, "NullableSelectorMin", "Min").Type, "Choice2494")
        AssertNullableSourceEnum(FindCall(compilation, "NullableSelectorMax", "Max").Type, "Choice2494")
    }

    @Fact
    func GenericWrappersAndSiblingGenericReturnLinq_PreserveSourceEnumIdentity() {
        const source = `package issue2494bindinggeneric
import System.Collections.Generic
import System.Linq

enum Choice2494 { Low, Middle, High }

func GenericMin[T](values IEnumerable[T]) T -> values.Min()
func GenericMax[T](values IEnumerable[T]) T -> values.Max()

func WrappedMin(values []Choice2494) Choice2494 ->
    GenericMin[Choice2494](values)
func WrappedMax(values []Choice2494) Choice2494 ->
    GenericMax[Choice2494](values)
func FirstValue(values []Choice2494) Choice2494 -> values.First()
func FirstOrDefaultValue(values []Choice2494) Choice2494 -> values.FirstOrDefault()
func SingleValue(values []Choice2494) Choice2494 -> values.Single()
func ElementAtValue(values []Choice2494) Choice2494 -> values.ElementAt(0)
func LastValue(values []Choice2494) Choice2494 -> values.Last()
func ContainsValue(values IList[Choice2494]) bool -> values.Contains(Choice2494.Low)`
        let compilation = Compile(source)
        Assert.IsType[TypeParameterSymbol](FindCall(compilation, "GenericMin", "Min").Type)
        Assert.IsType[TypeParameterSymbol](FindCall(compilation, "GenericMax", "Max").Type)
        AssertSourceEnum(FindCall(compilation, "WrappedMin", "GenericMin").Type, "Choice2494")
        AssertSourceEnum(FindCall(compilation, "WrappedMax", "GenericMax").Type, "Choice2494")
        AssertSourceEnum(FindCall(compilation, "FirstValue", "First").Type, "Choice2494")
        AssertSourceEnum(FindCall(compilation, "FirstOrDefaultValue", "FirstOrDefault").Type, "Choice2494")
        AssertSourceEnum(FindCall(compilation, "SingleValue", "Single").Type, "Choice2494")
        AssertSourceEnum(FindCall(compilation, "ElementAtValue", "ElementAt").Type, "Choice2494")
        AssertSourceEnum(FindCall(compilation, "LastValue", "Last").Type, "Choice2494")
        AssertNoErrors(compilation)
    }

    @Fact
    func ImportedEnumAndPrimitiveNumericControls_KeepTheirEstablishedTypes() {
        const source = `package issue2494bindingcontrols
import System
import System.Linq

func ImportedMin(values []DayOfWeek) DayOfWeek -> values.Min()
func ImportedMax(values []DayOfWeek) DayOfWeek -> values.Max()
func IntMin(values []int32) int32 -> values.Min()
func LongMax(values []int64) int64 -> values.Max()`
        let compilation = Compile(source)
        AssertNoErrors(compilation)
        let importedMin = Assert.IsType[ImportedTypeSymbol](FindCall(compilation, "ImportedMin", "Min").Type)
        let importedMax = Assert.IsType[ImportedTypeSymbol](FindCall(compilation, "ImportedMax", "Max").Type)
        Assert.Equal(typeof(DayOfWeek), importedMin.ClrType)
        Assert.Equal(typeof(DayOfWeek), importedMax.ClrType)
        Assert.Equal(TypeSymbol.Int32, FindCall(compilation, "IntMin", "Min").Type)
        Assert.Equal(TypeSymbol.Int64, FindCall(compilation, "LongMax", "Max").Type)
    }

    private class CallCollector : BoundTreeWalker {
        private let methodName string

        init(methodName string) {
            Calls = List[BoundExpression]()
            this.methodName = methodName
        }

        prop Calls List[BoundExpression] {
            get;
        }

        override func VisitExpression(node BoundExpression) {
            switch node {
                case call is BoundCallExpression when call.Function.Name == this.methodName {
                    Calls.Add(call)
                }
                case call is BoundImportedInstanceCallExpression when call.Method.Name == this.methodName {
                    Calls.Add(call)
                }
                case call is BoundImportedCallExpression when call.Function.Name == this.methodName {
                    Calls.Add(call)
                }
                case call is BoundClrStaticCallExpression when call.Method.Name == this.methodName {
                    Calls.Add(call)
                }
            }
            base.VisitExpression(node)
        }
    }

    shared {
        private func Compile(source string) Compilation {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Compilation(tree){IsLibrary = true}
        }

        private func FindCall(compilation Compilation, functionName string, methodName string) BoundExpression {
            let function = compilation.BoundProgram.Functions.Keys.Single((f FunctionSymbol) -> f.Name == functionName)
            let collector = Issue2494EnumLinqExtremaTests.CallCollector(methodName)
            collector.Visit(compilation.BoundProgram.Functions[function])
            return Assert.Single(collector.Calls)
        }

        private func AssertSourceEnum(type TypeSymbol?, expectedName string) {
            let enumType = Assert.IsType[EnumSymbol](type)
            Assert.Equal(expectedName, enumType.Name)
            Assert.NotEqual(TypeSymbol.Int32, enumType)
        }

        private func AssertGenericSourceEnumCall(expression BoundExpression, expectedName string) {
            AssertSourceEnum(expression.Type, expectedName)
            let call = Assert.IsType[BoundImportedCallExpression](expression)
            Assert.True(call.Function.Method.IsGenericMethod)
            Assert.Contains(
                call.TypeArgumentSymbols,
                (argument TypeSymbol) -> argument is EnumSymbol enumType && enumType.Name == expectedName
            )
        }

        private func AssertNullableSourceEnum(type TypeSymbol?, expectedName string) {
            let nullable = Assert.IsType[NullableTypeSymbol](type)
            AssertSourceEnum(nullable.UnderlyingType, expectedName)
        }

        private func AssertNoErrors(compilation Compilation) {
            Assert.DoesNotContain(compilation.GlobalScope.Diagnostics, (d Diagnostic) -> d.IsError)
            Assert.DoesNotContain(compilation.BoundProgram.Diagnostics, (d Diagnostic) -> d.IsError)
        }
    }
}
