// <copyright file="Issue3551DeferredLambdaReifiedReceiverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3551: deferred arrow-lambda parameter inference used the receiver's
/// CACHED (possibly erased) `ClrType`. A symbolic receiver such as
/// `IGrouping[string?, (string, int32?)]` (a nullable-annotated key from
/// a `GroupBy` whose selector returns `string?`) can cache a closed
/// shape whose tuple argument lost its `Nullable` element
/// (`ValueTuple<string, int>`), so the lambda was rebound against the
/// wrong tuple and every extension call on the grouping failed GS0159
/// ("Cannot find function Select"). The inference paths now prefer
/// `ReifyClosedClrType()`, matching the extension-dispatch path.
open class Issue3551DeferredLambdaReifiedReceiverTests {
    @Fact
    func NullableKeyGrouping_TupleElementLambdas_Resolve() {
        let output = CompileAndRun(`package Probe
import System
import System.Collections.Generic
import System.Linq

let two int32? = 2
let none int32? = nil
let xs = List[(string, int32, int32?)]()
xs.Add(("a", 1, two))
xs.Add(("b", 2, none))
xs.Add(("c", 3, two))

let keys = List[string]()
keys.Add("k0")
keys.Add("k1")
keys.Add("k2")

var n = 0
var names = ""
for group in xs.GroupBy((t (string, int32, int32?)) -> if (t.Item3 != nil) { keys[t.Item3!!] } else { default(string?) }) {
    let members = group.Select((t (string, int32, int32?)) -> t.Item1).ToList()
    n = n + members.Count
    for name in members.OrderBy((s string) -> s) {
        names = names + name
    }
}
Console.WriteLine(n)
Console.WriteLine(names)`)
        Assert.Equal(string.Join(Environment.NewLine, "3", "acb") + Environment.NewLine, output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let directory = Directory.CreateTempSubdirectory("gs_issue3551_").FullName
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
