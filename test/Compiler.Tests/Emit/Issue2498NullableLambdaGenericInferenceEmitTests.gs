// <copyright file="Issue2498NullableLambdaGenericInferenceEmitTests.cs" company="GSharp">
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

/// Runtime, metadata, C# consumer, and ILVerify coverage for issue #2498.
class Issue2498NullableLambdaGenericInferenceEmitTests {
    @Fact
    func OahuIteratorShape_SelectToArray_RunsAndVerifies() {
        const source = `package Issue2498.Iterator
import System
import System.Collections.Generic
import System.Linq

func Build2498[T](source []IEnumerable[T]) []IEnumerator[T]? {
    let values = source
        .Select((enumerable IEnumerable[T]) -> enumerable.GetEnumerator())
        .Select((enumerator IEnumerator[T]) ->
            if enumerator.MoveNext() {
                enumerator
            } else {
                default(IEnumerator[T]?)
            })
        .ToArray()
    values[0] = nil
    return values
}

func Main() {
    let source = []IEnumerable[int32]{
        []int32{1},
        []int32{},
    }
    let values = Build2498[int32](source)
    Console.WriteLine(values[0] == nil)
    Console.WriteLine(values[1] == nil)
}`
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GeneralizedImportedAndSourceGenericShapes_RunAndVerify() {
        const source = `package Issue2498.Runtime
import System
import System.Collections.Generic
import System.Linq

func Maybe2498(value string) string? ->
    if value.Length > 0 { value } else { nil }

func Project2498[A, B](source []A, selector (A) -> B) []B ->
    source.Select(selector).ToArray()

func MaybeComparable2498(value string) IComparable? -> Maybe2498(value)

func MaybeList2498(value string) List[IComparable?] {
    let result = List[IComparable?]()
    result.Add(MaybeComparable2498(value))
    return result
}

func Main() {
    let source = []string{"value", ""}

    let array = source.Select((value string) -> Maybe2498(value)).ToArray()
    array[0] = nil
    Console.WriteLine(array[0] == nil)
    Console.WriteLine(array[1] == nil)

    let list = source.Select(Maybe2498).ToList()
    list[0] = nil
    Console.WriteLine(list[0] == nil)

    let nested = source.Select((value string) -> MaybeList2498(value)).ToArray()
    nested[0][0] = nil
    Console.WriteLine(nested[0][0] == nil)

    let projected = Project2498(source, (value string) -> Maybe2498(value))
    projected[0] = nil
    Console.WriteLine(projected[0] == nil)

    let groups = source.GroupBy((value string) -> Maybe2498(value)).ToArray()
    Console.WriteLine(groups[1].Key == nil)
}`
        Assert.Equal(
            "True${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func EmittedNullability_RoundTripsAndCSharpConsumerAcceptsNullWrites() {
        const source = `package Issue2498.Metadata
import System.Collections.Generic
import System.Linq

func Maybe2498Metadata(value string) string? ->
    if value.Length > 0 { value } else { nil }

class Api2498 {
    shared {
        func Build(source []string) []string? ->
            source.Select((value string) -> Maybe2498Metadata(value)).ToArray()

        func BuildList(source []string) List[string?] ->
            source.Select((value string) -> Maybe2498Metadata(value)).ToList()

        func BuildNested(source []string) []List[string?] ->
            source.Select((value string) -> {
                let result = List[string?]()
                result.Add(Maybe2498Metadata(value))
                return result
            }).ToArray()
    }
}`
        WithCompiledLibrary(
            source,
            (dllPath string, references IReadOnlyList[string]) -> {
                let assembly = EmittedFixture.Load(dllPath)
                let api = assembly.GetType("Issue2498.Metadata.Api2498", throwOnError: true)!!
                let nullability = NullabilityInfoContext()
                let build = nullability.Create(GetMethod(api, "Build").ReturnParameter)
                Assert.Equal(NullabilityState.Nullable, build.ElementType!!.ReadState)
                let buildList = nullability.Create(GetMethod(api, "BuildList").ReturnParameter)
                Assert.Equal(NullabilityState.Nullable, buildList.GenericTypeArguments[0].ReadState)
                let buildNested = nullability.Create(GetMethod(api, "BuildNested").ReturnParameter)
                Assert.Equal(NullabilityState.Nullable, buildNested.ElementType!!.GenericTypeArguments[0].ReadState)
                const consumerSource = `#nullable enable
using Issue2498.Metadata;

public static class Consumer2498
{
    public static void WriteNulls()
    {
        Api2498.Build(["x"])[0] = null;
        Api2498.BuildList(["x"])[0] = null;
        Api2498.BuildNested(["x"])[0][0] = null;
    }
}`
                let compilation = CSharpCompilation.Create(
                    "Issue2498.Consumer",
                    []SyntaxTree{CSharpSyntaxTree.ParseText(consumerSource)},
                    TrustedPlatformAssemblies().Select((path string) -> MetadataReference.CreateFromFile(path)).Append(
                        MetadataReference.CreateFromFile(dllPath)
                    ),
                    CSharpCompilationOptions(
                        OutputKind.DynamicallyLinkedLibrary,
                        nullableContextOptions: NullableContextOptions.Enable,
                        generalDiagnosticOption: ReportDiagnostic.Error
                    )
                )
                using let stream = MemoryStream()
                let result = compilation.Emit(stream)
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            }
        )
    }

    shared {
        private func GetMethod(type Type, name string) MethodInfo -> type.GetMethod(
            name,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        ) ??
            throw InvalidOperationException("Method '$name' was not emitted.")

        private func CompileAndRun(source string) string {
            let directory = Directory.CreateTempSubdirectory("gs_issue2498_run_").FullName
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                let (exitCode, stdout, stderr) = Compile(sourcePath, outputPath, "exe")
                Assert.True(exitCode == 0, (`gsc failed:
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                IlVerifier.Verify(outputPath)
                let runtimeConfig = Path.ChangeExtension(outputPath, ".runtimeconfig.json")
                File.WriteAllText(runtimeConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = directory
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add("--runtimeconfig")
                startInfo.ArgumentList.Add(runtimeConfig)
                startInfo.ArgumentList.Add(outputPath)
                using let process = Process.Start(startInfo) ??
                    throw InvalidOperationException("Failed to start dotnet exec.")
                let runtimeOutput = process.StandardOutput.ReadToEnd()
                let runtimeError = process.StandardError.ReadToEnd()
                Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
                Assert.True(process.ExitCode == 0, (`dotnet exec failed (` + "${process.ExitCode}" + `):
stdout:
` + "$runtimeOutput" + `
stderr:
` + "$runtimeError"))
                return runtimeOutput.ReplaceLineEndings(Environment.NewLine)
            } finally {
                TryDelete(directory)
            }
        }

        private func WithCompiledLibrary(source string, assertion(string, IReadOnlyList[string]) -> void) {
            let directory = Directory.CreateTempSubdirectory("gs_issue2498_lib_").FullName
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                let (exitCode, stdout, stderr) = Compile(sourcePath, outputPath, "library")
                Assert.True(exitCode == 0, (`gsc failed:
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                let references = TrustedPlatformAssemblies().ToArray()
                IlVerifier.Verify(outputPath, additionalReferences: references)
                assertion(outputPath, references)
            } finally {
                TryDelete(directory)
            }
        }

        private func Compile(sourcePath string, outputPath string, target string)(
            ExitCode int32,
            Stdout string,
            Stderr string
        ) {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = Program.Main(
                    []string{"/out:" + outputPath, "/target:" + target, "/targetframework:net10.0", sourcePath}
                )
                return (exitCode, stdout.ToString(), stderr.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let value string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
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
