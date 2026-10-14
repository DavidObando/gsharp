// <copyright file="Issue3093SequenceInterfaceContractTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

class Issue3093SequenceInterfaceContractTests {
    @Fact
    func UserInterface_IteratorAndExplicitSequence_DispatchRunAndIlVerify() {
        const Source = `package Issue3093.User
import System
import System.Collections.Generic

func One(value int32) sequence[int32] {
    yield value
}

interface IDetector {
    func Detect(text string) IEnumerable[int32];
    func DetectExplicit(text string) IEnumerable[int32];
}

class Detector : IDetector {
    func Detect(text string) sequence[int32] {
        yield text.Length
    }

    func DetectExplicit(text string) sequence[int32] {
        return One(text.Length)
    }
}

var detector IDetector = Detector{}
for value in detector.Detect("abc") {
    Console.WriteLine(value)
}
for value in detector.DetectExplicit("abc") {
    Console.WriteLine(value)
}`
        WithDirectory(
            (directory string) -> {
                let assemblyPath = Compile(Source, directory)
                Assert.Equal("3${Environment.NewLine}3${Environment.NewLine}", Run(assemblyPath))
                let assembly = EmittedFixture.Load(assemblyPath)
                let detector Type? = assembly.GetType("Issue3093.User.Detector")
                Assert.NotNull(detector)
                Assert.All(
                    []string{"Detect", "DetectExplicit"},
                    (name string) -> Assert.Equal(
                        typeof(IEnumerable[int32]),
                        detector!!.GetMethod(name, BindingFlags.Public | BindingFlags.Instance)!!.ReturnType
                    )
                )
                let stateMachine = detector!!.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic).Single(
                    (type Type) -> type.Name.StartsWith("<Detect>d__", StringComparison.Ordinal)
                )
                Assert.Contains(typeof(IEnumerable[int32]), stateMachine.GetInterfaces())
                Assert.Contains(typeof(IEnumerator[int32]), stateMachine.GetInterfaces())
            }
        )
    }

    @Fact
    func UserGenericInterface_ValueTypeIterator_DispatchesAndIlVerifies() {
        const Source = `package Issue3093.Generic
import System
import System.Collections.Generic

interface IDetector {
    func Detect[T](value T) IEnumerable[T];
}

struct Detector : IDetector {
    func Detect[T](value T) sequence[T] {
        yield value
    }
}

var detector IDetector = Detector{}
for value in detector.Detect[int32](3) {
    Console.WriteLine(value)
}`
        WithDirectory(
            (directory string) -> {
                let assemblyPath = Compile(Source, directory)
                Assert.Equal("3${Environment.NewLine}", Run(assemblyPath))
            }
        )
    }

    @Fact
    func ImportedGenericInterface_ValueTypeIterator_DispatchesAndIlVerifies() {
        const ContractSource = `#nullable enable
using System.Collections.Generic;

namespace Issue3093.Contracts;

public interface IDetector
{
    IEnumerable<T> Detect<T>(T value);
}`
        const Source = `package Issue3093.Imported
import System
import Issue3093.Contracts

struct Detector : IDetector {
    func Detect[T](value T) sequence[T] {
        yield value
    }
}

var detector IDetector = Detector{}
for value in detector.Detect[int32](3) {
    Console.WriteLine(value)
}`
        WithDirectory(
            (directory string) -> {
                let contractPath = CompileContract(ContractSource, directory)
                let assemblyPath = Compile(Source, directory, []string{contractPath})
                Assert.Equal("3${Environment.NewLine}", Run(assemblyPath))
            }
        )
    }

    @Fact
    func ImportedConstructedGenericInterface_Iterator_DispatchesAndIlVerifies() {
        const ContractSource = `#nullable enable
using System.Collections.Generic;

namespace Issue3093.GenericContracts;

public interface IDetector<T>
{
    IEnumerable<T> Detect(T value);
}`
        const Source = `package Issue3093.ImportedConstructed
import System
import Issue3093.GenericContracts

struct Detector[T] : IDetector[T] {
    func Detect(value T) sequence[T] {
        yield value
    }
}

var detector IDetector[int32] = Detector[int32]{}
for value in detector.Detect(3) {
    Console.WriteLine(value)
}`
        WithDirectory(
            (directory string) -> {
                let contractPath = CompileContract(ContractSource, directory)
                let assemblyPath = Compile(Source, directory, []string{contractPath})
                Assert.Equal("3${Environment.NewLine}", Run(assemblyPath))
            }
        )
    }

    shared {
        private func Compile(
            source string,
            directory string,
            additionalReferences IReadOnlyCollection[string]? = nil
        ) string {
            let sourcePath = Path.Combine(directory, "Program.gs")
            let assemblyPath = Path.Combine(directory, "Issue3093.dll")
            File.WriteAllText(sourcePath, source)
            let arguments = List[string]{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0"}
            if additionalReferences != nil {
                arguments.AddRange(additionalReferences.Select((path string) -> ("/reference:" + path)))
                arguments.AddRange(
                    ReferenceResolver.HostTrustedPlatformAssemblyPaths().Select((path string) -> ("/reference:" + path))
                )
                arguments.Add("/nowarn:GS9100")
            }
            arguments.Add(sourcePath)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(arguments.ToArray())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.True(exitCode == 0, "gsc failed:${Environment.NewLine}$stdout$stderr")
            IlVerifier.Verify(assemblyPath, additionalReferences)
            return assemblyPath
        }

        private func CompileContract(source string, directory string) string {
            let references = ReferenceResolver.HostTrustedPlatformAssemblyPaths().Select(
                (path string) -> MetadataReference.CreateFromFile(path)
            )
            let compilation = CSharpCompilation.Create(
                "GSharp.Issue3093.Contracts",
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable
                )
            )
            let path = Path.Combine(directory, "GSharp.Issue3093.Contracts.dll")
            using let stream = File.Create(path)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return path
        }

        private func Run(assemblyPath string) string {
            using let process Process? = Process.Start(
                ProcessStartInfo("dotnet"){
                    ArgumentList = {
                        "exec",
                        "--runtimeconfig",
                        Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                        assemblyPath
                    },
                    WorkingDirectory = Path.GetDirectoryName(assemblyPath)!!,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
            )
            Assert.NotNull(process)
            let output = process!!.StandardOutput.ReadToEnd()
            let error = process!!.StandardError.ReadToEnd()
            Assert.True(process!!.WaitForExit(30_000), "dotnet exec timed out")
            Assert.True(process!!.ExitCode == 0, "exited ${process!!.ExitCode}:${Environment.NewLine}$error")
            return output.ReplaceLineEndings(Environment.NewLine)
        }

        private func WithDirectory(action(string) -> void) {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue3093SequenceInterfaceContractTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            try {
                action(directory)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }
    }
}
