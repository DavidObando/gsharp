// <copyright file="Issue3501StructVariantInterfaceBoxingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3501 (Track A6 keystone): a value-type source converting to a
/// VARIANT interface target is C#'s boxing conversion composed with interface
/// variance — `ImmutableArray<IMethodSymbol>` → `IEnumerable<ISymbol>`.
/// The exact implemented interface already boxed; only the variance-composed
/// classification was missing (GS0155), in both the symbolic classifier and
/// the CLR overload-resolution applicability rule.
open class Issue3501StructVariantInterfaceBoxingTests {
    @Fact
    func ImmutableArray_BoxesToCovariantEnumerable() {
        let output = CompileAndRun(`package Probe
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

open class Animal {
    var Name string
}

class Dog : Animal {
}

func count(items IEnumerable[Animal]) int32 {
    var n = 0
    for item in items {
        n = n + 1
    }
    return n
}

let dogs = ImmutableArray.Create(Dog{ Name: "a" }, Dog{ Name: "b" })
let widened IEnumerable[Animal] = dogs
Console.WriteLine(count(widened))
Console.WriteLine(count(dogs))
Console.WriteLine(dogs.Cast[Animal]().Count())`)
        Assert.Equal(string.Join(Environment.NewLine, "2", "2", "2") + Environment.NewLine, output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let directory = Directory.CreateTempSubdirectory("gs_issue3501_boxvar_").FullName
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
