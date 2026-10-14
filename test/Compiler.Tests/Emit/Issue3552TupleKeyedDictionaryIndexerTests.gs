// <copyright file="Issue3552TupleKeyedDictionaryIndexerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3552: a tuple-keyed `Dictionary` rejected its own key —
/// `IsTupleClrEquivalent` compared the two closed `ValueTuple<…>`
/// shapes by REFERENCE equality, but they can live in different reflection
/// contexts (the live-runtime `MakeGenericType` product on the
/// `TupleTypeSymbol` vs a MetadataLoadContext signature type recovered
/// from the indexer parameter), so `cache[("k", 1)]` failed GS0155
/// "'(string, int32)' to 'System.ValueTuple[string, int32]'".
open class Issue3552TupleKeyedDictionaryIndexerTests {
    @Fact
    func TupleKeyedDictionary_IndexerAcceptsTupleKeys() {
        let output = CompileAndRun(`package Probe
import System
import System.Collections.Generic

let cache = Dictionary[(string, int32), bool]()
cache[("k", 1)] = true
let key = ("k", 1)
cache[key] = cache[("k", 1)]
Console.WriteLine(cache[key])
Console.WriteLine(cache.Count)`)
        Assert.Equal(string.Join(Environment.NewLine, "True", "1") + Environment.NewLine, output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let directory = Directory.CreateTempSubdirectory("gs_issue3552_").FullName
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                let exitCode = RunCompiler(
                    []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath},
                    out var diagnostics
                )
                Assert.True(exitCode == 0, diagnostics)
                IlVerifier.Verify(outputPath)
                return RunAssembly(directory, outputPath)
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch { }
            }
        }

        private func RunCompiler(arguments[]string, out diagnostics string) int32 {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = Program.Main(arguments)
                diagnostics = (`stdout:
` + "$stdout" + `
stderr:
` + "$stderr")
                return exitCode
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func RunAssembly(workingDirectory string, assemblyPath string) string {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workingDirectory
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"))
            startInfo.ArgumentList.Add(assemblyPath)
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to start dotnet exec.")
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
            Assert.True(process.ExitCode == 0, (`dotnet exec exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
