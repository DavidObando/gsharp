// <copyright file="Issue2494EnumLinqExtremaTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2494: imported generic LINQ methods must preserve a symbolic
/// same-compilation enum type. In particular, the enum's temporary
/// <c>int32</c> CLR projection may help imported-member lookup, but it must
/// not make the concrete numeric <c>Min</c>/<c>Max</c> overloads semantically
/// applicable or leak <c>int32</c> into the bound result.
/// </summary>
public sealed class Issue2494EnumLinqExtremaTests
{
    [Fact]
    public void MinMax_SourceEnumReceiverShapes_BindAsSourceEnum()
    {
        const string source = """
            package issue2494bindingreceivers
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
                values.Select((value Choice2494) -> value).Distinct().Max()
            """;

        var compilation = Compile(source);

        AssertGenericSourceEnumCall(FindCall(compilation, "ArrayMin", "Min"), "Choice2494");
        AssertGenericSourceEnumCall(FindCall(compilation, "ArrayMax", "Max"), "Choice2494");
        AssertGenericSourceEnumCall(FindCall(compilation, "EnumerableMin", "Min"), "Choice2494");
        AssertGenericSourceEnumCall(FindCall(compilation, "EnumerableMax", "Max"), "Choice2494");
        AssertGenericSourceEnumCall(
            FindCall(compilation, "NullableEnumerableMin", "Min"),
            "Choice2494");
        AssertGenericSourceEnumCall(FindCall(compilation, "ListMin", "Min"), "Choice2494");
        AssertGenericSourceEnumCall(FindCall(compilation, "ListMax", "Max"), "Choice2494");
        AssertGenericSourceEnumCall(FindCall(compilation, "StaticMin", "Min"), "Choice2494");
        AssertGenericSourceEnumCall(FindCall(compilation, "StaticMax", "Max"), "Choice2494");
        AssertGenericSourceEnumCall(
            FindCall(compilation, "DictionaryValuesMin", "Min"),
            "Choice2494");
        AssertGenericSourceEnumCall(FindCall(compilation, "PipelineMin", "Min"), "Choice2494");
        AssertGenericSourceEnumCall(FindCall(compilation, "PipelineMax", "Max"), "Choice2494");
        AssertNoErrors(compilation);
    }

    [Fact]
    public void MinMax_NullableEnumAndSelectorOverloads_PreserveProjectedEnumType()
    {
        const string source = """
            package issue2494bindingselectors
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
                values.Max((item Item2494) -> item.Optional)
            """;

        var compilation = Compile(source);

        AssertNoErrors(compilation);
        AssertNullableSourceEnum(
            FindCall(compilation, "NullableMin", "Min").Type,
            "Choice2494");
        AssertNullableSourceEnum(
            FindCall(compilation, "NullableMax", "Max").Type,
            "Choice2494");
        AssertSourceEnum(
            FindCall(compilation, "SelectorMin", "Min").Type,
            "Choice2494");
        AssertSourceEnum(
            FindCall(compilation, "SelectorMax", "Max").Type,
            "Choice2494");
        AssertNullableSourceEnum(
            FindCall(compilation, "NullableSelectorMin", "Min").Type,
            "Choice2494");
        AssertNullableSourceEnum(
            FindCall(compilation, "NullableSelectorMax", "Max").Type,
            "Choice2494");
    }

    [Fact]
    public void GenericWrappersAndSiblingGenericReturnLinq_PreserveSourceEnumIdentity()
    {
        const string source = """
            package issue2494bindinggeneric
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
            func ContainsValue(values IList[Choice2494]) bool -> values.Contains(Choice2494.Low)
            """;

        var compilation = Compile(source);

        Assert.IsType<TypeParameterSymbol>(FindCall(compilation, "GenericMin", "Min").Type);
        Assert.IsType<TypeParameterSymbol>(FindCall(compilation, "GenericMax", "Max").Type);
        AssertSourceEnum(FindCall(compilation, "WrappedMin", "GenericMin").Type, "Choice2494");
        AssertSourceEnum(FindCall(compilation, "WrappedMax", "GenericMax").Type, "Choice2494");
        AssertSourceEnum(FindCall(compilation, "FirstValue", "First").Type, "Choice2494");
        AssertSourceEnum(
            FindCall(compilation, "FirstOrDefaultValue", "FirstOrDefault").Type,
            "Choice2494");
        AssertSourceEnum(FindCall(compilation, "SingleValue", "Single").Type, "Choice2494");
        AssertSourceEnum(FindCall(compilation, "ElementAtValue", "ElementAt").Type, "Choice2494");
        AssertSourceEnum(FindCall(compilation, "LastValue", "Last").Type, "Choice2494");
        AssertNoErrors(compilation);
    }

    [Fact]
    public void ImportedEnumAndPrimitiveNumericControls_KeepTheirEstablishedTypes()
    {
        const string source = """
            package issue2494bindingcontrols
            import System
            import System.Linq

            func ImportedMin(values []DayOfWeek) DayOfWeek -> values.Min()
            func ImportedMax(values []DayOfWeek) DayOfWeek -> values.Max()
            func IntMin(values []int32) int32 -> values.Min()
            func LongMax(values []int64) int64 -> values.Max()
            """;

        var compilation = Compile(source);

        AssertNoErrors(compilation);
        var importedMin = Assert.IsType<ImportedTypeSymbol>(
            FindCall(compilation, "ImportedMin", "Min").Type);
        var importedMax = Assert.IsType<ImportedTypeSymbol>(
            FindCall(compilation, "ImportedMax", "Max").Type);
        Assert.Equal(typeof(System.DayOfWeek), importedMin.ClrType);
        Assert.Equal(typeof(System.DayOfWeek), importedMax.ClrType);

        Assert.Equal(TypeSymbol.Int32, FindCall(compilation, "IntMin", "Min").Type);
        Assert.Equal(TypeSymbol.Int64, FindCall(compilation, "LongMax", "Max").Type);
    }

    private static Compilation Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return new Compilation(tree) { IsLibrary = true };
    }

    private static BoundExpression FindCall(
        Compilation compilation,
        string functionName,
        string methodName)
    {
        var function = compilation.BoundProgram.Functions.Keys.Single(f => f.Name == functionName);
        var collector = new CallCollector(methodName);
        collector.Visit(compilation.BoundProgram.Functions[function]);
        return Assert.Single(collector.Calls);
    }

    private static void AssertSourceEnum(TypeSymbol type, string expectedName)
    {
        var enumType = Assert.IsType<EnumSymbol>(type);
        Assert.Equal(expectedName, enumType.Name);
        Assert.NotEqual(TypeSymbol.Int32, enumType);
    }

    private static void AssertGenericSourceEnumCall(BoundExpression expression, string expectedName)
    {
        AssertSourceEnum(expression.Type, expectedName);
        var call = Assert.IsType<BoundImportedCallExpression>(expression);
        Assert.True(call.Function.Method.IsGenericMethod);
        Assert.Contains(
            call.TypeArgumentSymbols,
            argument => argument is EnumSymbol enumType && enumType.Name == expectedName);
    }

    private static void AssertNullableSourceEnum(TypeSymbol type, string expectedName)
    {
        var nullable = Assert.IsType<NullableTypeSymbol>(type);
        AssertSourceEnum(nullable.UnderlyingType, expectedName);
    }

    private static void AssertNoErrors(Compilation compilation)
    {
        Assert.DoesNotContain(compilation.GlobalScope.Diagnostics, d => d.IsError);
        Assert.DoesNotContain(compilation.BoundProgram.Diagnostics, d => d.IsError);
    }

    private sealed class CallCollector : BoundTreeWalker
    {
        private readonly string methodName;

        public CallCollector(string methodName)
        {
            this.methodName = methodName;
        }

        public List<BoundExpression> Calls { get; } = new();

        public override void VisitExpression(BoundExpression node)
        {
            switch (node)
            {
                case BoundCallExpression call when call.Function.Name == this.methodName:
                    Calls.Add(call);
                    break;
                case BoundImportedInstanceCallExpression call when call.Method.Name == this.methodName:
                    Calls.Add(call);
                    break;
                case BoundImportedCallExpression call when call.Function.Name == this.methodName:
                    Calls.Add(call);
                    break;
                case BoundClrStaticCallExpression call when call.Method.Name == this.methodName:
                    Calls.Add(call);
                    break;
            }

            base.VisitExpression(node);
        }
    }
}
