// <copyright file="Issue3088AsyncNullableTupleInterfaceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Symbols
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

class Issue3088AsyncNullableTupleInterfaceTests {
    @Fact
    func ImportedInterface_AsyncNullableTupleReturn_DispatchesVerifiesAndRuns() {
        const ContractSource = `#nullable enable
using System;
using System.Threading;
using System.Threading.Tasks;

namespace Issue3088.Contract;

public sealed class Item
{
    public Item(int value) => Value = value;

    public int Value { get; }
}

public interface IStore
{
    Task<(Item Item, string? Name)?> GetAsync(
        Guid id,
        CancellationToken ct = default);
}`
        const Source = `package Issue3088

import System
import System.Threading
import System.Threading.Tasks
import Issue3088.Contract

class Store : IStore {
    public async func GetAsync(id Guid, ct CancellationToken = default(CancellationToken)) (Item, string?)? {
        await Task.Yield()
        return id == Guid.Empty ? nil : (Item(42), default(string?))
    }
}

async func Verify(store IStore) {
    let missing = await store.GetAsync(Guid.Empty)
    Console.WriteLine(missing == nil)

    let found = await store.GetAsync(Guid.NewGuid())
    if found == nil {
        Environment.Exit(12)
    }

    let value = found!!
    Console.WriteLine(value.Item1.Value)
    Console.WriteLine(value.Item2 == nil)
}

Verify(Store()).GetAwaiter().GetResult()`
        Assert.Equal(
            "True${Environment.NewLine}42${Environment.NewLine}True${Environment.NewLine}",
            CompileVerifyAndRun(ContractSource, Source)
        )
    }

    shared {
        private func CompileVerifyAndRun(contractSource string, source string) string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue3088AsyncNullableTupleInterfaceTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            try {
                let contractPath = CompileContract(directory, contractSource)
                let sourcePath = Path.Combine(directory, "Program.gs")
                let outputPath = Path.Combine(directory, "Issue3088.dll")
                File.WriteAllText(sourcePath, source)
                let arguments = List[string]{
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    "/reference:" + contractPath
                }
                arguments.AddRange(
                    ReferenceResolver.HostTrustedPlatformAssemblyPaths().Select((path string) -> ("/reference:" + path))
                )
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
                IlVerifier.Verify(outputPath, []string{contractPath})
                using let process Process? = Process.Start(
                    ProcessStartInfo("dotnet"){
                        ArgumentList = {
                            "exec",
                            "--runtimeconfig",
                            Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                            outputPath
                        },
                        WorkingDirectory = directory,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false
                    }
                )
                let output = process!!.StandardOutput.ReadToEnd()
                let error = process!!.StandardError.ReadToEnd()
                Assert.True(process!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(process!!.ExitCode == 0, "exited ${process!!.ExitCode}:${Environment.NewLine}$error")
                return output.ReplaceLineEndings(Environment.NewLine)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func CompileContract(directory string, source string) string {
            let references = ReferenceResolver.HostTrustedPlatformAssemblyPaths().Select(
                (path string) -> MetadataReference.CreateFromFile(path)
            )
            let compilation = CSharpCompilation.Create(
                "GSharp.Issue3088.Contract",
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable
                )
            )
            let path = Path.Combine(directory, "GSharp.Issue3088.Contract.dll")
            using let stream = File.Create(path)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return path
        }
    }
}
