// <copyright file="Issue2523NullableImportedGenericBaseConversionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import GSharp.Compiler
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Compiler.Tests

/// Runtime, reflection, C# consumer, and ILVerify coverage for issue #2523.
class Issue2523NullableImportedGenericBaseConversionEmitTests {
    @Fact
    func ImportedGenericReturnBaseConversionsRunAndPreserveMetadata() {
        let directory = NewDirectory()
        try {
            let fixturePath = Path.Combine(directory, "Issue2523.Metadata.dll")
            EmitFixture(fixturePath)
            const source = `package Issue2523.Emit
import System
import Issue2523.Metadata

class Api2523 {
    shared {
        func Build(
            source IQuery2523[MetadataEntity2523])
            IQuery2523[MetadataEntity2523] ->
            QueryExtensions2523.Include2523(
                source,
                    (entity MetadataEntity2523) -> entity.Child)
                .Include2523(
                    (entity MetadataEntity2523) -> entity.Other)

        func BuildChain(
            source IQuery2523[MetadataEntity2523])
            IChain2523[
                MetadataEntity2523,
                MetadataChild2523?,
                string,
                string] ->
            QueryExtensions2523.Include2523(
                source,
                (entity MetadataEntity2523) -> entity.Child)
    }
}

func Main() {
    let source = Query2523[MetadataEntity2523](1)
    Console.WriteLine(Api2523.Build(source).Count)
    Console.WriteLine(Api2523.BuildChain(source).Count)
}`
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, "Issue2523.Emit.dll")
            File.WriteAllText(sourcePath, source)
            let (exitCode, output) = Compile(sourcePath, outputPath, fixturePath)
            Assert.True(exitCode == 0, output)
            let references = TrustedPlatformAssemblies().Append(fixturePath).ToArray()
            IlVerifier.Verify(outputPath, additionalReferences: references)
            Assert.Equal("3${Environment.NewLine}2${Environment.NewLine}", Run(outputPath))
            // One context for the reference fixture and the emitted
            // assembly that imports it, so the nullability assertions
            // below see one identity for the fixture's types.
            let loaded2523 = EmittedFixture.LoadTogether(fixturePath, outputPath)
            let fixture = loaded2523[0]
            let emitted = loaded2523[1]
            let api = emitted.GetType("Issue2523.Emit.Api2523", throwOnError: true)!!
            let buildChain = api.GetMethod(
                "BuildChain",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )!!
            let nullability = NullabilityInfoContext().Create(buildChain.ReturnParameter)
            Assert.Equal(NullabilityState.Nullable, nullability.GenericTypeArguments[1].ReadState)
            const consumerSource = `#nullable enable
using Issue2523.Emit;
using Issue2523.Metadata;

public static class Consumer2523
{
    public static IQuery2523<MetadataEntity2523> Build()
    {
        var source = new Query2523<MetadataEntity2523>(1);
        IChain2523<
            MetadataEntity2523,
            MetadataChild2523?,
            string,
            string> chain = Api2523.BuildChain(source);
        return chain;
    }
}`
            let consumer = CSharpCompilation.Create(
                "Issue2523.Consumer",
                []SyntaxTree{CSharpSyntaxTree.ParseText(consumerSource)},
                TrustedPlatformAssemblies()
                    .Select((path string) -> MetadataReference.CreateFromFile(path))
                    .Append(MetadataReference.CreateFromFile(fixturePath))
                    .Append(MetadataReference.CreateFromFile(outputPath)),
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable,
                    generalDiagnosticOption: ReportDiagnostic.Error
                )
            )
            using let consumerPe = MemoryStream()
            let consumerResult = consumer.Emit(consumerPe)
            Assert.True(consumerResult.Success, string.Join(Environment.NewLine, consumerResult.Diagnostics))
            GC.KeepAlive(fixture)
        } finally {
            TryDelete(directory)
        }
    }

    shared {
        private func EmitFixture(outputPath string) {
            const fixtureSource = `#nullable enable
using System;
using System.Linq.Expressions;

namespace Issue2523.Metadata;

public interface IQuery2523<out TEntity>
{
    int Count { get; }
}

public interface IChain2523<out TEntity, out TProperty, in TInput, TInvariant>
    : IQuery2523<TEntity>
{
}

public sealed class Query2523<TEntity> : IQuery2523<TEntity>
{
    public Query2523(int count) => Count = count;
    public int Count { get; }
}

public sealed class Chain2523<TEntity, TProperty, TInput, TInvariant>
    : IChain2523<TEntity, TProperty, TInput, TInvariant>
{
    public Chain2523(int count) => Count = count;
    public int Count { get; }
}

public sealed class MetadataEntity2523
{
    public MetadataChild2523? Child { get; set; }
    public MetadataOther2523? Other { get; set; }
}

public sealed class MetadataChild2523 { }
public sealed class MetadataOther2523 { }

public static class QueryExtensions2523
{
    public static IChain2523<TEntity, TProperty, string, string>
        Include2523<TEntity, TProperty>(
            this IQuery2523<TEntity> source,
            Expression<Func<TEntity, TProperty>> selector)
        => new Chain2523<TEntity, TProperty, string, string>(
            source.Count + 1);
}`
            let compilation = CSharpCompilation.Create(
                "Issue2523.Metadata",
                []SyntaxTree{CSharpSyntaxTree.ParseText(fixtureSource)},
                TrustedPlatformAssemblies().Select((path string) -> MetadataReference.CreateFromFile(path)),
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable
                )
            )
            using let pe = File.Create(outputPath)
            let result = compilation.Emit(pe)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }

        private func Compile(sourcePath string, outputPath string, fixturePath string)(ExitCode int32, Output string) {
            let args = List[string]{
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/reference:" + fixturePath
            }
            args.AddRange(TrustedPlatformAssemblies().Select((path string) -> ("/reference:" + path)))
            args.Add(sourcePath)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                return (Program.Main(args.ToArray()), stdout.ToString() + stderr.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func Run(outputPath string) string {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(outputPath)!!
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"))
            startInfo.ArgumentList.Add(outputPath)
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to start issue #2523 executable.")
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(30_000), "Issue #2523 executable timed out.")
            Assert.True(process.ExitCode == 0, (`dotnet exec failed (` + "${process.ExitCode}" + `):
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }

        private func NewDirectory() string {
            let root = Path.Combine(Environment.CurrentDirectory, "TestArtifacts", "Issue2523")
            let directory = Path.Combine(root, Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            return directory
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let value = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            return if string.IsNullOrWhiteSpace(value) {
                cast[IEnumerable[string]](Array.Empty[string]())
            } else {
                value!!.Split(Path.PathSeparator).Where(File.Exists)
            }
        }

        private func TryDelete(directory string) {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }
    }
}
