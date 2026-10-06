// <copyright file="Issue4675RecordLiteralDefaultsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Reflection;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4675RecordLiteralDefaultsEmitTests
{
    [Fact]
    public void EmptyPrimaryList_SeparatesExplicitConstructionFromBareZeroInitialization()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package EmptyPrimaryDefaults
            import System
            class Counter {
                shared {
                    public var Count int32
                    public func Next() int32 {
                        Count += 1
                        return Count
                    }
                }
            }
            data struct Box() {
                private var Items []int32
                public var Marker int32 = Counter.Next()
                public prop Length int32 { get { return Items.Length } }
            }
            func Main() {
                let explicit = Box{}
                Console.WriteLine(explicit.Marker)
                Console.WriteLine(explicit.Length)
                Console.WriteLine(Counter.Count)
                var bare Box
                Console.WriteLine(bare.Marker)
                Console.WriteLine(bare.Length)
                Console.WriteLine(Counter.Count)
            }
            """, "EmptyPrimaryDefaults", true);
        IlVerifier.Verify(dll);
        Assert.Equal("1\n0\n1\n0\n0\n1\n", fixture.Run(dll));
        var assembly = EmittedFixture.Load(dll);
        var box = assembly.GetType("EmptyPrimaryDefaults.Box", throwOnError: true);
        Assert.Single(box.GetConstructors());
        var boxHelper = Assert.Single(box.GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic));
        Assert.True(boxHelper.IsAssembly);
        Assert.Equal(typeof(bool), Assert.Single(boxHelper.GetParameters()).ParameterType);
    }

    [Fact]
    public void ComputedPositionalProperty_UsesPreparedPrimaryArgument()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package ComputedPrimaryDefaults
            import System
            data struct Item(Value int32) {
                private let Storage int32 = Value + 1
                public prop Value int32 -> Storage
            }
            func Main() {
                Console.WriteLine(Item{}.Value)
                Console.WriteLine(Item(8).Value)
            }
            """, "ComputedPrimaryDefaults", true);
        IlVerifier.Verify(dll);
        Assert.Equal("1\n9\n", fixture.Run(dll));
        var type = EmittedFixture.Load(dll).GetType("ComputedPrimaryDefaults.Item", throwOnError: true);
        var constructor = Assert.Single(type.GetConstructors(), constructor => constructor.GetParameters().Length == 1);
        Assert.Equal("Value", Assert.Single(constructor.GetParameters()).Name);
        Assert.Empty(type.GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic));
        var consumer = fixture.CompileCSharp(
            """
            using ComputedPrimaryDefaults;
            public static class NamedConsumer
            {
                public static int Run() => new Item(Value: 8).Value;
            }
            """,
            "ComputedPrimaryDefaultsConsumer",
            dll);
        IlVerifier.Verify(consumer, additionalReferences: new[] { dll });
        var loaded = EmittedFixture.LoadTogether(dll, consumer);
        Assert.Equal(9, loaded[1].GetType("NamedConsumer", throwOnError: true).GetMethod("Run").Invoke(null, null));
    }

    [Fact]
    public void EmptyDataClassPrimaryLiterals_ResolveTheDefaultConstructor()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package EmptyClassPrimary
            import System
            data class Empty()
            data class Generic[T]()
            func Main() {
                Console.WriteLine(Empty{} != nil)
                Console.WriteLine(Generic[int32]{} != nil)
            }
            """, "EmptyClassPrimary", true);
        IlVerifier.Verify(dll);
        Assert.Equal("True\nTrue\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData("data struct", "int64", "box.Value", "int64(9)")]
    [InlineData("data class", "int64", "box.Value", "int64(9)")]
    [InlineData("data struct", "Payload", "box.Value.Number", "Payload{Number: int64(9)}")]
    [InlineData("data class", "Payload", "box.Value.Number", "Payload{Number: int64(9)}")]
    [InlineData("data struct", "ImportedPayload", "box.Value.Number", "ImportedPayload{Number: int64(9)}")]
    [InlineData("data class", "ImportedPayload", "box.Value.Number", "ImportedPayload{Number: int64(9)}")]
    public void OmittedArgument_IsPlanned_ExplicitCopyAndZeroControlsStayCorrect(string kind, string parameterType, string read, string supplied)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var contracts = parameterType == "ImportedPayload"
            ? new[] { fixture.CompileCSharp("namespace DefaultContracts { public struct ImportedPayload { public long Number; } }", "ImportedDefaultContract") }
            : Array.Empty<string>();
        var source = """
            package LiteralDefaults
            import System
            IMPORT
            class Counter {
                shared {
                    public var Count int32
                    public func Next() int32 {
                        Count += 1
                        return Count
                    }
                }
            }
            struct Payload { public var Number int64 }
            KIND Box(Value PARAMETER) {
                public var Marker int32 = Counter.Next()
                public var Items []int32
            }
            func Main() {
                let box = Box{}
                Console.WriteLine(READ)
                Console.WriteLine(box.Marker)
                Console.WriteLine(Counter.Count)
                let constructed = Box{Value: SUPPLIED}
                Console.WriteLine(EXPLICIT_READ)
                Console.WriteLine(constructed.Marker)
                Console.WriteLine(Counter.Count)
                let copied = constructed with {}
                Console.WriteLine(COPY_READ)
                Console.WriteLine(copied.Marker)
                Console.WriteLine(Counter.Count)
                BARE
            }
            """.Replace("KIND", kind, StringComparison.Ordinal)
                .Replace("IMPORT", parameterType == "ImportedPayload" ? "import DefaultContracts" : string.Empty, StringComparison.Ordinal)
                .Replace("PARAMETER", parameterType, StringComparison.Ordinal)
                .Replace("EXPLICIT_READ", read.Replace("box.", "constructed.", StringComparison.Ordinal), StringComparison.Ordinal)
                .Replace("COPY_READ", read.Replace("box.", "copied.", StringComparison.Ordinal), StringComparison.Ordinal)
                .Replace("READ", read, StringComparison.Ordinal)
                .Replace("SUPPLIED", supplied, StringComparison.Ordinal)
                .Replace("BARE", kind == "data struct"
                    ? "var bare Box\nConsole.WriteLine(bare.Marker)\nConsole.WriteLine(bare.Items.Length)\nConsole.WriteLine(Counter.Count)"
                    : string.Empty, StringComparison.Ordinal);
        var dll = fixture.Compile(source, "LiteralDefaults", true, Array.ConvertAll(contracts, path => "/r:" + path));
        IlVerifier.Verify(dll, additionalReferences: contracts);
        Assert.Equal("0\n1\n1\n9\n2\n2\n9\n2\n2\n" + (kind == "data struct" ? "0\n0\n2\n" : string.Empty), fixture.Run(dll));
    }

    [Theory]
    [InlineData("data struct")]
    [InlineData("data class")]
    public void OpenGenericDefaults_ArePlannedForEveryInstantiation(string kind)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package GenericLiteralDefaults
            import System
            struct Payload { public var Number int64 }
            KIND Box[T](Value T)
            func make[T](useDefault bool, supplied T) Box[T] {
                if useDefault { return Box[T]{} }
                return Box[T]{Value: supplied}
            }
            func Main() {
                Console.WriteLine(make[int64](true, int64(9)).Value)
                Console.WriteLine(make[int64](false, int64(9)).Value)
                Console.WriteLine(make[Payload](true, Payload{Number: int64(8)}).Value.Number)
                Console.WriteLine(make[Payload](false, Payload{Number: int64(8)}).Value.Number)
            }
            """.Replace("KIND", kind, StringComparison.Ordinal), "GenericLiteralDefaults", true);
        IlVerifier.Verify(dll);
        Assert.Equal("0\n9\n0\n8\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData("data struct")]
    [InlineData("data class")]
    public void AsyncAndIteratorDefaults_StayInTheRewrittenPlannedBody(string kind)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package LoweredLiteralDefaults
            import System
            import System.Threading.Tasks
            KIND Box(Value int64, Other int32)
            async func make() Box { return Box{Other: await Task.FromResult(7)} }
            func stream() sequence[Box] { yield Box{Other: 9} }
            func Main() {
                let box = make().GetAwaiter().GetResult()
                Console.WriteLine(box.Value)
                Console.WriteLine(box.Other)
                for item in stream() {
                    Console.WriteLine(item.Value)
                    Console.WriteLine(item.Other)
                }
            }
            """.Replace("KIND", kind, StringComparison.Ordinal), "LoweredLiteralDefaults", true);
        IlVerifier.Verify(dll);
        Assert.Equal("0\n7\n0\n9\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData("data struct")]
    [InlineData("data class")]
    public void ExpressionTrees_ConsumeThePreparedDefaultAndExplicitArguments(string kind)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package TreeLiteralDefaults
            import System
            import System.Linq.Expressions
            KIND Box(Value int64, Other int32)
            func Main() {
                let tree Expression[Func[Box]] = () -> Box{Other: 7}
                let box = tree.Compile()()
                Console.WriteLine(box.Value)
                Console.WriteLine(box.Other)
            }
            """.Replace("KIND", kind, StringComparison.Ordinal), "TreeLiteralDefaults", true);
        IlVerifier.Verify(dll);
        Assert.Equal("0\n7\n", fixture.Run(dll));
    }

    [Fact]
    public void ExpressionTree_NestedPositionalDefault_UsesTheZeroHelper()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package TreeNestedZeroDefaults
            import System
            import System.Linq.Expressions
            data struct Inner(Value int32) {
                public var Items []int32
                public prop Length int32 { get { return Items.Length } }
            }
            data class Box(Item Inner)
            func Main() {
                let tree Expression[Func[Box]] = () -> Box{}
                let box = tree.Compile()()
                Console.WriteLine(box.Item.Value)
                Console.WriteLine(box.Item.Length)
            }
            """, "TreeNestedZeroDefaults", true);
        IlVerifier.Verify(dll);
        Assert.Equal("0\n0\n", fixture.Run(dll));
    }

    [Fact]
    public void ExpressionTree_ClosedGenericZero_AssignsRetainedStorageWithoutConstructorLookup()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package TreeClosedGenericZero
            import System
            import System.Linq.Expressions
            struct Payload {
                private var Items []int32
                public prop Length int32 { get { return Items.Length } }
            }
            data struct Inner[T](Value int32) { public var Child T }
            data class Box(Item Inner[Payload])
            func Main() {
                let tree Expression[Func[Box]] = () -> Box{}
                let box = tree.Compile()()
                Console.WriteLine(box.Item.Value)
                Console.WriteLine(box.Item.Child.Length)
            }
            """, "TreeClosedGenericZero", true);
        IlVerifier.Verify(dll);
        Assert.Equal("0\n0\n", fixture.Run(dll));
    }

    [Fact]
    public void ExpressionTree_ZeroHelper_DoesNotReassignFieldsWrittenByTheHelper()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package TreeZeroHelperStores
            import System
            import System.Linq.Expressions
            class Counter {
                shared {
                    public var Count int32
                    public func Next() int32 {
                        Count += 1
                        return Count
                    }
                }
            }
            struct Inner {
                private var Items []int32
                private var Marker int32 = Counter.Next()
                public func Mark() int32 -> Marker
            }
            data struct Outer(Value int32) {
                public var Child Inner
            }
            data class Box(Item Outer)
            func Main() {
                let tree Expression[Func[Box]] = () -> Box{}
                let box = tree.Compile()()
                Console.WriteLine(box.Item.Child.Mark())
                Console.WriteLine(Counter.Count)
            }
            """, "TreeZeroHelperStores", true);
        IlVerifier.Verify(dll);
        Assert.Equal("1\n1\n", fixture.Run(dll));
    }

    [Fact]
    public void ImportedRecordLiteral_KeepsItsExistingBoundDefaultPath()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var contract = fixture.CompileCSharp("namespace DefaultContracts { public readonly record struct ImportedBox(long Value); }", "ImportedRecordDefaultContract");
        var dll = fixture.Compile("""
            import System
            import DefaultContracts
            func Main() {
                Console.WriteLine(ImportedBox{}.Value)
                Console.WriteLine(ImportedBox{Value: int64(7)}.Value)
            }
            """, "ImportedRecordDefaults", true, "/r:" + contract);
        IlVerifier.Verify(dll, additionalReferences: new[] { contract });
        Assert.Equal("0\n7\n", fixture.Run(dll));
    }
}
