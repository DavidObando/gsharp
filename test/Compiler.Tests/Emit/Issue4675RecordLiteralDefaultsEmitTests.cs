// <copyright file="Issue4675RecordLiteralDefaultsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4675RecordLiteralDefaultsEmitTests
{
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
