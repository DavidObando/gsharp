// <copyright file="Issue4675RecordPrimaryConstructorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

public class Issue4675RecordPrimaryConstructorEmitTests
{
    [Fact]
    public void PositionalLiteral_EvaluatesArgumentsInWrittenOrder()
    {
        var result = EmittedOracle.Evaluate("""
            class Counter {
                shared {
                    public var Count int32
                    public func Next() int32 {
                        Count += 1
                        return Count
                    }
                }
            }
            data struct Pair(A int32, B int32) {
                private let Marker int32 = A * 10 + B
                public func Read() int32 -> Marker
            }
            Pair{B: Counter.Next(), A: Counter.Next()}.Read()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(21, result.Value);
    }

    [Fact]
    public void PositionalDataProjection_RunsInitializerWithProjectedArgument()
    {
        var result = EmittedOracle.Evaluate("""
            struct Source { public var Value int32 }
            data struct Box[T](Value T) {
                private let Storage T = Value
                public func Read() T { return Storage }
            }
            let source = Source{Value: 7}
            let box Box[int32] = source
            box.Read()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void NativeCopy_ClonesBeforeAwaitedUpdates()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Threading.Tasks
            open data class Item {
                public var Value int32 = 1
                public var Extra int32
            }
            async func Mutate(item Item) int32 {
                item.Value = 9
                return await Task.FromResult(2)
            }
            async func Run() int32 {
                let original = Item{}
                let copy = original with { Extra = await Mutate(original) }
                return copy.Value * 10 + copy.Extra
            }
            Run().GetAwaiter().GetResult()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(12, result.Value);
    }

    [Theory]
    [InlineData("data struct")]
    [InlineData("data class")]
    [InlineData("open data class")]
    public void NativeCopy_PreservesInitializedGetOnlyAndPrivateState(string kind)
    {
        var result = EmittedOracle.Evaluate("""
            class Counter {
                shared {
                    public var Count int32
                    public func Next() int32 {
                        Count += 1
                        return Count
                    }
                }
            }
            KIND Item[T](Value T) {
                private let Storage T = Value
                public prop Saved T -> Storage
                private let Marker int32 = Counter.Next()
                public var Extra int32
                public func ReadMarker() int32 { return Marker }
            }
            func Get(item Item[int32]) Item[int32] {
                Counter.Count += 100
                return item
            }
            let original = Item[int32](7)
            let copy = Get(original) with { Extra = 2 }
            Counter.Count * 1000 + copy.ReadMarker() * 100 + copy.Saved * 10 + copy.Extra
            """.Replace("KIND", kind, StringComparison.Ordinal));
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(101172, result.Value);
    }

    [Fact]
    public void MissingPrimaryConstructorStorage_FailsFast()
    {
        var compilation = new Compilation(SyntaxTree.Parse("data struct Item(Value int32)"));
        Assert.Empty(EmittedOracle.CompileDiagnostics(compilation));
        StructSymbol type = Assert.Single(compilation.GlobalScope.Structs);
        type.SetProperties(ImmutableArray<PropertySymbol>.Empty);

        var exception = Assert.Throws<InvalidOperationException>(
            () => ReflectionMetadataEmitter.TryGetPrimaryCtorTargetField(type, "Value", out _));
        Assert.Contains("Value", exception.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("data struct")]
    [InlineData("data class")]
    [InlineData("open data class")]
    public void ComputedPositionalProperty_DoesNotRequireAStore(string kind)
    {
        var result = EmittedOracle.Evaluate("""
            KIND Item(Value int32) {
                private let Storage int32 = Value + 1
                public prop Value int32 -> Storage
            }
            Item(41).Value
            """.Replace("KIND", kind, StringComparison.Ordinal));
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void PlannedPrimaryConstructor_StoresParametersBeforeInitializers()
    {
        var result = EmittedOracle.Evaluate("""
            data struct Item[T](Value T) {
                private let Storage T = Value
                private let Reference readonly managed[T] = readonly managed(Value)
                public func Read() T { return *Reference }
                public func ReadStorage() T { return Storage }
            }
            let item = Item[int32](41)
            item.Value + item.Read() + item.ReadStorage()
            """, new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(123, result.Value);
    }

    [Fact]
    public void DuplicatePositionalProperty_RetainsDuplicateDiagnostic()
    {
        var compilation = new Compilation(SyntaxTree.Parse("""
            data struct Item(Value int32) {
                public prop Value int32 { get; }
                public prop Value int32 { get; }
            }
            """));
        var diagnostics = EmittedOracle.CompileDiagnostics(compilation);
        var duplicate = Assert.Single(diagnostics, diagnostic => diagnostic.Id == "GS0102");
        Assert.Equal(3, duplicate.Location.StartLine + 1);
    }

    [Fact]
    public void EquatableOfDifferentGenericInstantiation_StillRequiresImplementation()
    {
        var compilation = new Compilation(SyntaxTree.Parse("""
            data struct Item[T](Value T) : IEquatable[Item[int32]]
            """));
        var diagnostics = EmittedOracle.CompileDiagnostics(compilation);
        var missing = Assert.Single(diagnostics, diagnostic => diagnostic.Id == "GS0187");
        Assert.Equal(0, missing.Location.StartLine);
    }

    [Theory]
    [InlineData("", false)]
    [InlineData("T", false)]
    [InlineData("int32", true)]
    public void NestedRecordEquatableContract_PreservesEnclosingTypeArguments(string argument, bool requiresImplementation)
    {
        var compilation = new Compilation(SyntaxTree.Parse("""
            open class Outer[T] {
                public data class Item(Value int32) : IEquatable[SELF]
            }
            """.Replace("SELF", argument.Length == 0 ? "Item" : $"Outer[{argument}].Item", StringComparison.Ordinal)));
        var diagnostics = EmittedOracle.CompileDiagnostics(compilation);
        if (requiresImplementation)
        {
            var missing = Assert.Single(diagnostics, diagnostic => diagnostic.Id == "GS0187");
            Assert.Equal(1, missing.Location.StartLine);
        }
        else
        {
            Assert.Empty(diagnostics);
        }
    }

    [Theory]
    [InlineData("data struct")]
    [InlineData("data class")]
    [InlineData("open data class")]
    public void PositionalPropertyWithDifferentType_IsRejected(string kind)
    {
        var compilation = new Compilation(SyntaxTree.Parse("""
            KIND Item(Value int32) {
                public prop Value string { get; }
            }
            """.Replace("KIND", kind, StringComparison.Ordinal)));
        var diagnostics = EmittedOracle.CompileDiagnostics(compilation);
        var mismatch = Assert.Single(diagnostics, diagnostic => diagnostic.Id == "GS0155");
        Assert.Equal(1, mismatch.Location.StartLine);
    }

    [Fact]
    public void ClosedHierarchyCopyConstructor_AllowsDerivedCloning()
    {
        var result = EmittedOracle.Evaluate("""
            sealed data class Base {
                public var Value int32 = 41
            }
            data class Derived : Base {
                public var Extra int32 = 1
            }
            let original = Derived{}
            let copy = original with { Extra = 2 }
            copy
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.NotNull(result.Value);
        Type derivedType = result.Value.GetType();
        Type baseType = derivedType.BaseType;
        Assert.NotNull(baseType);
        Assert.False(baseType.IsSealed);
        ConstructorInfo baseCopy = Assert.Single(
            baseType.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic),
            constructor => constructor.GetParameters() is [{ ParameterType: var parameterType }] && parameterType == baseType);
        Assert.True(baseCopy.IsFamily);
        object clone = derivedType.GetMethod("<Clone>$").Invoke(result.Value, null);
        Assert.Equal(41, derivedType.GetField("Value").GetValue(clone));
        Assert.Equal(2, derivedType.GetField("Extra").GetValue(clone));
    }

    [Fact]
    public void GetOnlyPositionalProperty_ReceivesConstructorArgument()
    {
        var result = EmittedOracle.Evaluate("""
            data struct Item(Value int32) {
                public prop Value int32 { get; }
            }
            Item(42).Value
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void GetOnlyVariadicPositionalProperty_ReceivesPackedArguments()
    {
        var result = EmittedOracle.Evaluate("""
            data struct Item(Values ...int32) {
                public prop Values []int32 { get; }
            }
            let item = Item(20, 22)
            item.Values[0] + item.Values[1]
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ComputedPositionalArgument_IsEvaluated(bool variadic)
    {
        var result = EmittedOracle.Evaluate("""
            DECLARATION
            class Counter {
                public var Count int32
                public func Next() int32 {
                    Count = Count + 1
                    return Count
                }
            }
            let counter = Counter{}
            let item = Item(ARGUMENTS)
            counter.Count
            """.Replace("DECLARATION", variadic
                ? "data struct Item(Values ...int32) { public prop Values []int32 -> []int32{42} }"
                : "data struct Item(Value int32) { public prop Value int32 -> 42 }", StringComparison.Ordinal)
                .Replace("ARGUMENTS", variadic ? "counter.Next(), counter.Next()" : "counter.Next()", StringComparison.Ordinal));
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(variadic ? 2 : 1, result.Value);
    }

    [Fact]
    public void EarlierInitializer_CallsLaterDataPrimaryConstructor()
    {
        var result = EmittedOracle.Evaluate("""
            class Holder {
                public var Current Item = Item(41)
            }
            data struct Item(Value int32) {
                private let Storage int32 = Value + 1
                public func Read() int32 -> Storage
            }
            Holder{}.Current.Read()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void OrdinaryPositionalStruct_RetainsPrivateInitializers()
    {
        var result = EmittedOracle.Evaluate("""
            struct Box(Value int32) {
                private var Marker int32 = 11
                public func ReadMarker() int32 -> Marker
            }
            Box(7).ReadMarker()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(11, result.Value);
    }

    [Theory]
    [InlineData("data struct", "11")]
    [InlineData("data struct", "Value + 4")]
    [InlineData("data class", "Value + 4")]
    public void PositionalDataLiteral_RunsInitializersInParameterScope(string kind, string initializer)
    {
        var result = EmittedOracle.Evaluate("""
            KIND Box(Value int32) {
                private var Marker int32 = INITIALIZER
                public func ReadMarker() int32 -> Marker
            }
            Box{Value: 7}.ReadMarker()
            """.Replace("INITIALIZER", initializer, StringComparison.Ordinal).Replace("KIND", kind, StringComparison.Ordinal));
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(11, result.Value);
    }

    [Theory]
    [InlineData("data struct")]
    [InlineData("data class")]
    public void GenericComputedPositionalProperty_RetainsDeconstruction(string kind)
    {
        var result = EmittedOracle.Evaluate("""
            KIND Item[T](Value T) {
                private let Storage T = Value
                public prop Value T -> Storage
            }
            Item[int32](41)
            """.Replace("KIND", kind, StringComparison.Ordinal));
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.NotNull(result.Value);
        MethodInfo deconstruct = result.Value.GetType().GetMethod("Deconstruct");
        Assert.NotNull(deconstruct);
        object[] arguments = { null };
        deconstruct.Invoke(result.Value, arguments);
        Assert.Equal(41, arguments[0]);
    }

    [Theory]
    [InlineData("get;", 41)]
    [InlineData("-> Storage", 42)]
    public void ReplacementPositionalProperty_RetainsDeconstruction(string getter, int expected)
    {
        string property = getter == "get;" ? "{ get; }" : getter;
        var result = EmittedOracle.Evaluate("""
            data struct Item(Value int32) {
                private var Storage int32 = Value + 1
                public prop Value int32 GETTER
            }
            Item(41)
            """.Replace("GETTER", property, StringComparison.Ordinal));
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.NotNull(result.Value);
        MethodInfo deconstruct = result.Value.GetType().GetMethod("Deconstruct");
        Assert.NotNull(deconstruct);
        ParameterInfo parameter = Assert.Single(deconstruct.GetParameters());
        Assert.True(parameter.IsOut);
        Assert.Equal(typeof(int).MakeByRefType(), parameter.ParameterType);
        object[] arguments = { null };
        deconstruct.Invoke(result.Value, arguments);
        Assert.Equal(expected, arguments[0]);
    }
}
