// <copyright file="Issue2945StaticVirtualNullableErasureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests
import Xunit.Sdk

/// Issue #2945: static-virtual interface properties use the same declared-type
/// nullable erasure as instance interface properties. Tests load every emitted
/// type, then execute get/set dispatch through constrained generic calls in a
/// child process; IL verification is additional evidence, not the runtime gate.
open class Issue2945StaticVirtualNullableErasureTests {
    @Fact
    func NullableErasureMatrix_LoadsAndDispatchesThroughClrSlots() {
        const source = `package Issue2945Matrix

sealed interface IGet[T] {
    shared { prop Value T? { get; } }
}

struct IntImplicit : IGet[int32] {
    shared { prop Value int32 -> 11 }
}

struct IntExplicit : IGet[int32] {
    shared {
        private prop (IGet[int32]) Value int32 -> 12
    }
}

class TextImplicit : IGet[string] {
    shared { prop Value string -> "text" }
}

struct OpenImplicit[T] : IGet[T] {
    shared { prop Value T -> default(T) }
}

open class Animal { }
class Cat : Animal { }

sealed interface IClassGet[T Animal] {
    shared { prop Value T? { get; } }
}

class CatImplicit : IClassGet[Cat] {
    shared { prop Value Cat -> Cat() }
}

sealed interface ISet[T] {
    shared { prop Value T? { get; set; } }
}

class TextSet : ISet[string] {
    shared {
        var Stored string? = "before"
        prop Value string? {
            get { return TextSet.Stored }
            set { TextSet.Stored = value }
        }
    }
}

class ExplicitTextSet : ISet[string] {
    shared {
        var Stored string? = "explicit-before"
        private prop (ISet[string]) Value string? {
            get { return ExplicitTextSet.Stored }
            set { ExplicitTextSet.Stored = value }
        }
    }
}

sealed interface IStructSet[T struct] {
    shared { prop Value T? { get; set; } }
}

struct StructSet : IStructSet[int32] {
    shared {
        var Stored int32? = 7
        prop Value int32? {
            get { return StructSet.Stored }
            set { StructSet.Stored = value }
        }
    }
}

sealed interface ISliceGet[T] { shared { prop Value []T? { get; } } }
struct SliceGet : ISliceGet[int32] { shared { prop Value []int32 -> []int32{1} } }

sealed interface IArrayGet[T] { shared { prop Value [3]T? { get; } } }
struct ArrayGet : IArrayGet[int32] { shared { prop Value [3]int32 -> [3]int32{1, 2, 3} } }

sealed interface IMapGet[T] { shared { prop Value map[string,T?] { get; } } }
struct MapGet : IMapGet[int32] { shared { prop Value map[string,int32] -> map[string,int32]{"one": 1} } }

sealed interface IFuncArgumentGet[T] { shared { prop Value func(T?) int32 { get; } } }
struct FuncArgumentGet : IFuncArgumentGet[int32] { shared { prop Value func(int32) int32 -> func(value int32) int32 { return value + 1 } } }

sealed interface IFuncReturnGet[T] { shared { prop Value func(int32) T? { get; } } }
struct FuncReturnGet : IFuncReturnGet[int32] { shared { prop Value func(int32) int32 -> func(value int32) int32 { return value + 2 } } }`
        const consumer = `using System;
using Issue2945Matrix;

Console.WriteLine(Read<IntImplicit, int>());
Console.WriteLine(Read<IntExplicit, int>());
Console.WriteLine(Read<TextImplicit, string>());
Console.WriteLine(Read<OpenImplicit<int>, int>());
Console.WriteLine(ReadClass<CatImplicit, Cat>() is not null);
Console.WriteLine(ReadSet<TextSet, string>());
ClearSet<TextSet, string>();
Console.WriteLine(ReadSet<TextSet, string>() ?? "nil");
Console.WriteLine(ReadSet<ExplicitTextSet, string>());
Set<ExplicitTextSet, string>("explicit-after");
Console.WriteLine(ReadSet<ExplicitTextSet, string>());
Console.WriteLine(ReadStructSet<StructSet, int>());
SetStruct<StructSet, int>(9);
Console.WriteLine(ReadStructSet<StructSet, int>());

static T? Read<TImpl, T>()
    where T : notnull
    where TImpl : IGet<T>
{
    return TImpl.Value;
}

static T? ReadClass<TImpl, T>()
    where T : Animal
    where TImpl : IClassGet<T>
{
    return TImpl.Value;
}

static T? ReadSet<TImpl, T>()
    where T : class
    where TImpl : ISet<T>
{
    return TImpl.Value;
}

static void ClearSet<TImpl, T>()
    where T : class
    where TImpl : ISet<T>
{
    TImpl.Value = null;
}

static void Set<TImpl, T>(T value)
    where T : class
    where TImpl : ISet<T>
{
    TImpl.Value = value;
}

static T? ReadStructSet<TImpl, T>()
    where T : struct
    where TImpl : IStructSet<T>
{
    return TImpl.Value;
}

static void SetStruct<TImpl, T>(T? value)
    where T : struct
    where TImpl : IStructSet<T>
{
    TImpl.Value = value;
}`
        const expected = `11
12
text
0
True
before
nil
explicit-before
explicit-after
7
9`
        let directory = CreateWorkDirectory()
        try {
            let libraryPath = CompileGSharp(source, directory, "Issue2945Matrix.dll", target: "library")
            let _ = EmittedFixture.Load(libraryPath).GetTypes()
            let consumerPath = CompileCSharpConsumer(consumer, libraryPath, directory)
            Assert.Equal(expected + Environment.NewLine, RunChild(consumerPath, directory))
            IlVerifier.Verify(libraryPath)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func GSharpConstrainedRead_UsesErasedSlotTypeAndRuns() {
        const source = `package Issue2945GSharp
import System

sealed interface I[T] {
    shared { prop Value T? { get; } }
}

struct C : I[int32] {
    shared { prop Value int32 -> 1 }
}

func Touch[T I[int32]](witness T) {
    var value = T.Value
}

func Main() {
    Touch(C{})
    Console.WriteLine("ok")
}`
        let directory = CreateWorkDirectory()
        try {
            let outputPath = CompileGSharp(source, directory, "Issue2945GSharp.dll", target: "exe")
            let _ = EmittedFixture.Load(outputPath).GetTypes()
            Assert.Equal("ok${Environment.NewLine}", RunChild(outputPath, directory))
            IlVerifier.Verify(
                outputPath,
                ignoredErrorCodes: IlVerifier.KnownIssues.StaticVirtualInterface,
                ignoredErrorScope: "<Program>\\.Touch$$"
            )
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func ValueNullableAndInvariantStaticSlots_RemainRejected() {
        const source = `package Issue2945Rejected
import System.Collections.Generic

sealed interface IConcrete {
    shared { prop Value int32? { get; } }
}
struct ConcreteValueCovariance : IConcrete {
    shared { prop Value int32 -> 1 }
}

sealed interface IStruct[T struct] {
    shared { prop Value T? { get; } }
}
struct StructConstrained[T struct] : IStruct[T] {
    shared { prop Value T -> default(T) }
}

sealed interface ISetter[T] {
    shared { prop Value T? { get; set; } }
}
class SetterNullabilityMismatch : ISetter[string] {
    shared { prop Value string { get; set; } }
}

sealed interface INonNullable[T] {
    shared { prop Value T { get; } }
}
class NullableImplementation : INonNullable[string] {
    shared { prop Value string? -> nil }
}

sealed interface IWrongType {
    shared { prop Value int32 { get; } }
}
class WrongType : IWrongType {
    shared { prop Value string -> "wrong" }
}

interface INestedList[T] {
    prop Value List[T?] { get; }
}
class NestedListMismatch : INestedList[int32] {
    prop Value List[int32] { get; }
}`
        let directory = CreateWorkDirectory()
        try {
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, "Issue2945Rejected.dll")
            File.WriteAllText(sourcePath, source)
            let (exitCode, output) = Compile(
                "/out:" + outputPath,
                "/target:library",
                "/targetframework:net10.0",
                sourcePath
            )
            Assert.NotEqual(0, exitCode)
            Assert.False(File.Exists(outputPath))
            Assert.Equal(5, CountOccurrences(output, "error GS0397:"))
            Assert.Equal(1, CountOccurrences(output, "error GS0187:"))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private func CompileGSharp(source string, directory string, outputName string, target string) string {
            let sourcePath = Path.Combine(directory, Path.GetFileNameWithoutExtension(outputName) + ".gs")
            let outputPath = Path.Combine(directory, outputName)
            File.WriteAllText(sourcePath, source)
            let (exitCode, output) = Compile(
                "/out:" + outputPath,
                "/target:" + target,
                "/targetframework:net10.0",
                sourcePath
            )
            Assert.True(exitCode == 0, "gsc failed:\n" + output)
            return outputPath
        }

        private func Compile(arguments ...string)(ExitCode int32, Output string) {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = Program.Main(arguments)
                return (exitCode, stdout.ToString() + stderr.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func CompileCSharpConsumer(source string, libraryPath string, directory string) string {
            let outputPath = Path.Combine(directory, "Issue2945Consumer.dll")
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")))
                .Split(Path.PathSeparator)
                .Select((path string) -> MetadataReference.CreateFromFile(path))
                .Append(MetadataReference.CreateFromFile(libraryPath))
            let compilation = CSharpCompilation.Create(
                "Issue2945Consumer",
                []SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(
                    OutputKind.ConsoleApplication,
                    nullableContextOptions: NullableContextOptions.Enable
                )
            )
            using let stream = File.Create(outputPath)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            WriteRuntimeConfig(outputPath)
            return outputPath
        }

        private func RunChild(assemblyPath string, workingDirectory string) string {
            WriteRuntimeConfig(assemblyPath)
            let runtimeConfig = Path.ChangeExtension(assemblyPath, ".runtimeconfig.json")
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = workingDirectory
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(runtimeConfig)
            startInfo.ArgumentList.Add(assemblyPath)
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to start dotnet child process.")
            let stdoutTask = process.StandardOutput.ReadToEndAsync()
            let stderrTask = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(30_000) {
                process.Kill(entireProcessTree: true)
                throw XunitException("dotnet child process timed out.")
            }
            let stdout = stdoutTask.GetAwaiter().GetResult()
            let stderr = stderrTask.GetAwaiter().GetResult()
            Assert.True(process.ExitCode == 0, (`dotnet child exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }

        private func WriteRuntimeConfig(assemblyPath string) {
            File.WriteAllText(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"), `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": {
      "name": "Microsoft.NETCore.App",
      "version": "10.0.0"
    }
  }
}`)
        }

        private func CreateWorkDirectory() string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2945-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            return directory
        }

        private func CountOccurrences(text string, value string) int32 -> text.Split(value, StringSplitOptions.None)
            .Length - 1
    }
}
