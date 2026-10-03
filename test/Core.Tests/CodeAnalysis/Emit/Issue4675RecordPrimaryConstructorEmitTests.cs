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
}
