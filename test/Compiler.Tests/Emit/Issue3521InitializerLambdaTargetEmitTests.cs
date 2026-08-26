// <copyright file="Issue3521InitializerLambdaTargetEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue3521InitializerLambdaTargetEmitTests
{
    [Fact]
    public void DestinationMemberTypes_TargetUntypedLambdas_RunAndVerify()
    {
        const string source = """
            package Issue3521Positive
            import System.Collections.Generic

            class NullableHolder3521 { var Callback ((int32) -> void)? }
            class ClassHolder3521 { var Callback (int32) -> void }
            data class DataClassHolder3521 { var Callback (int32) -> void }
            struct StructHolder3521 { var Callback (int32) -> void }
            data struct DataStructHolder3521 { var Callback (int32) -> void }
            class PropertyHolder3521 {
                prop Callback (int32) -> void { get; init; }
                init() {}
            }
            class SuffixHolder3521 {
                var Callback (int32) -> void
                init() {}
            }
            data class CopyHolder3521 { var Callback (int32) -> void }
            class MixedHolder3521 {
                var Callback (int32) -> void
                prop Items IList[int32] { get; init; }
                init() { Items = List[int32]() }
            }
            class NestedHolder3521 {
                var Factory (int32) -> ((int32) -> int32)
            }

            func Main() int32 {
                var seen int32 = 0

                let nullable = NullableHolder3521{
                    Callback: (value) -> { seen = seen + value }
                }
                nullable.Callback?(1)

                let plain = ClassHolder3521{
                    Callback: (value) -> { seen = seen + value }
                }
                plain.Callback(2)

                let dataClass = DataClassHolder3521{
                    Callback: (value) -> { seen = seen + value }
                }
                dataClass.Callback(3)

                let structure = StructHolder3521{
                    Callback: (value) -> { seen = seen + value }
                }
                structure.Callback(4)

                let dataStructure = DataStructHolder3521{
                    Callback: (value) -> { seen = seen + value }
                }
                dataStructure.Callback(5)

                let projected = DataStructHolder3521{
                    ...dataStructure,
                    Callback: (value) -> { seen = seen + value }
                }
                projected.Callback(6)

                let mixed = MixedHolder3521{
                    Callback: (value) -> { seen = seen + value },
                    Items: { 1 }
                }
                mixed.Callback(7)

                let suffix = SuffixHolder3521(){
                    Callback = (value) -> { seen = seen + value }
                }
                suffix.Callback(8)

                let original = CopyHolder3521{
                    Callback: (value int32) -> { seen = seen + value }
                }
                let copied = original with {
                    Callback = (value) -> { seen = seen + value }
                }
                copied.Callback(9)

                let anonymous = object {
                    let Callback (int32) -> void =
                        (value) -> { seen = seen + value }
                }
                anonymous.Callback(10)

                let array = []((int32) -> void){
                    (value) -> { seen = seen + value }
                }
                array[0](11)

                let list = List[(int32) -> void]{
                    (value) -> { seen = seen + value }
                }
                list[0](12)

                let indexed = Dictionary[int32, (int32) -> void]{
                    [1] = (value) -> { seen = seen + value }
                }
                indexed[1](13)

                let mapped = map[int32, (int32) -> void]{
                    1: (value) -> { seen = seen + value }
                }
                mapped[1](14)

                let property = PropertyHolder3521{
                    Callback: (value) -> { seen = seen + value }
                }
                property.Callback(15)

                let nested = NestedHolder3521{
                    Factory: (left) -> {
                        return (right) -> left + right
                    }
                }
                seen = seen + nested.Factory(8)(8)

                return seen == 136 ? 0 : 1
            }
            """;

        var directory = NewDirectory("positive");
        try
        {
            var outputPath = Path.Combine(directory, "Issue3521Positive.dll");
            Emit(source, outputPath);
            IlVerifier.Verify(outputPath);
            Assert.Equal(0, Run(outputPath));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void InferredGenericComposites_DeferConcreteLambdaMembers_RunAndVerify()
    {
        const string source = """
            package Issue3521Generic

            class GenericClass3521[T] {
                var Value T
                var Callback (int32) -> void
            }

            data struct GenericDataStruct3521[T] {
                var Value T
                var Callback (int32) -> void
            }

            class GenericCallback3521[T] {
                var Callback (T) -> void
            }

            func Main() int32 {
                var seen int32 = 0

                let classBox = GenericClass3521{
                    Value: 40,
                    Callback: (value) -> { seen = seen + value }
                }
                seen = seen + classBox.Value
                classBox.Callback(1)

                let dataBox = GenericDataStruct3521{
                    Callback: (value) -> { seen = seen + value },
                    Value: "ok"
                }
                dataBox.Callback(dataBox.Value.Length)

                let callbackBox = GenericCallback3521{
                    Callback: (value int32) -> { seen = seen + value }
                }
                callbackBox.Callback(1)

                return seen == 44 ? 0 : 1
            }
            """;

        var directory = NewDirectory("generic");
        try
        {
            var outputPath = Path.Combine(directory, "Issue3521Generic.dll");
            Emit(source, outputPath);
            IlVerifier.Verify(outputPath);
            Assert.Equal(0, Run(outputPath));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void WrongLambdaArity_ReportsArgumentCountDiagnostic()
    {
        var diagnostics = CompileErrors("""
            package Issue3521WrongArity

            class Holder3521WrongArity {
                var Callback (int32) -> void
            }

            func Build() Holder3521WrongArity ->
                Holder3521WrongArity{ Callback: (left, right) -> {} }
            """);

        Assert.Contains(diagnostics, diagnostic => diagnostic.Id == "GS0144");
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Id == "GS9998");
    }

    [Fact]
    public void IncompatibleExplicitParameterType_ReportsConversionDiagnostic()
    {
        var diagnostics = CompileErrors("""
            package Issue3521WrongType

            class Holder3521WrongType[T] {
                var Value T
                var Callback (int32) -> void
            }

            func Build() Holder3521WrongType[int32] ->
                Holder3521WrongType{
                    Value: 1,
                    Callback: (value string) -> {}
                }
            """);

        Assert.Contains(diagnostics, diagnostic => diagnostic.Id == "GS0155");
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Id == "GS9998");
    }

    private static void Emit(string source, string outputPath)
    {
        using var resolver = ReferenceResolver.Default();
        var compilation = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(source)));
        using var stream = File.Create(outputPath);
        var result = compilation.Emit(
            stream,
            pdbStream: null,
            refStream: null,
            assemblyName: Path.GetFileNameWithoutExtension(outputPath));
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static Diagnostic[] CompileErrors(string source)
    {
        using var resolver = ReferenceResolver.Default();
        var compilation = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(source)));
        using var stream = new MemoryStream();
        var result = compilation.Emit(
            stream,
            pdbStream: null,
            refStream: null,
            assemblyName: "Issue3521Negative" + Guid.NewGuid().ToString("N"));
        Assert.False(result.Success);
        return result.Diagnostics.ToArray();
    }

    private static int Run(string assemblyPath)
    {
        var context = new AssemblyLoadContext(
            "Issue3521-" + Guid.NewGuid().ToString("N"),
            isCollectible: true);
        try
        {
            var assembly = context.LoadFromAssemblyPath(Path.GetFullPath(assemblyPath));
            var entryPoint = assembly.EntryPoint;
            Assert.NotNull(entryPoint);
            var arguments = entryPoint.GetParameters().Length == 0
                ? null
                : new object[] { Array.Empty<string>() };
            return Convert.ToInt32(entryPoint.Invoke(null, arguments));
        }
        finally
        {
            context.Unload();
        }
    }

    private static string NewDirectory(string name)
    {
        var directory = Path.Combine(
            Environment.CurrentDirectory,
            "TestArtifacts",
            "Issue3521",
            name + "-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }
}
