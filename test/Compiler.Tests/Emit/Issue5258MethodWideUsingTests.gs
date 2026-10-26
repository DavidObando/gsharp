// <copyright file="Issue5258MethodWideUsingTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Core.CodeAnalysis.Compilation
import System
import System.Diagnostics
import System.IO
import System.Text
import System.Text.Json
import Xunit

open class Issue5258MethodWideUsingTests {
    @Fact
    func JsonDocuments_RegionAnalysisWorkIsLinear_AndOutputIsDeterministic() {
        let directory = NewDirectory()
        try {
            for count in[]int32{2, 8, 14, 20} {
                let source = StringBuilder(
                    "package CompilerRepro\nimport System.Text.Json\nimport System.Threading.Tasks\nasync func Main() {\n"
                )
                for var i = 0; i < count; i++ {
                    source.AppendLine("    using let doc$i = JsonDocument.Parse(\"{}\")")
                }
                source.AppendLine("    await Task.CompletedTask\n}")
                let (output, analyses, replays) = Compile(directory, source.ToString())
                Assert.True(analyses >= int64(count), "The compiler must analyze the cleanup regions.")
                Assert.True(
                    analyses <= int64(8 * count + 8),
                    "$count using bindings required $analyses region analyses."
                )
                if count == 20 {
                    Assert.True(replays > int64(0), "Nested fixed-point probes must reuse their region results.")
                    IlVerifier.Verify(output)
                    let first = File.ReadAllBytes(output)
                    let (repeated, _, _) = Compile(directory, source.ToString())
                    Assert.Equal(first, File.ReadAllBytes(repeated))
                    Assert.Equal([]uint8{}, Run(output))
                }
            }
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func IncompleteAwait_KeepsMethodWideResources_AndCleansUpOnceInLifoOrder(fail bool) {
        let source = StringBuilder(`package MethodWideCleanup5258
import System
import System.Threading.Tasks

class Resource : IDisposable {
    let id int32
    init(value int32) {
        id = value
        Console.WriteLine("create:" + id.ToString())
    }
    func Dispose() {
        Console.WriteLine("dispose:" + id.ToString())
    }
}

async func Work(gate Task, fail bool) {
`)
        let expected = StringBuilder()
        for var i = 0; i < 20; i++ {
            source.AppendLine("    using let resource$i = Resource($i)")
            expected.AppendLine("create:$i")
        }
        source.AppendLine(`    Console.WriteLine("waiting")
    await gate
    Console.WriteLine("body")
    if fail { throw InvalidOperationException("body-failure") }
}

func Main() {
    let gate = TaskCompletionSource[bool]()
    let work = Work(gate.Task, ` + (
                if fail {
                    "true"
                } else {
                    "false"
                }
            ) + `)
    Console.WriteLine("completed:" + work.IsCompleted.ToString())
    Console.WriteLine("release")
    gate.SetResult(true)
    try {
        work.GetAwaiter().GetResult()
    } catch (e InvalidOperationException) {
        Console.WriteLine("caught:" + e.Message)
    }
    Console.WriteLine("done")
}`)
        expected.AppendLine("waiting")
        expected.AppendLine("completed:False")
        expected.AppendLine("release")
        expected.AppendLine("body")
        for var i = 19; i >= 0; i-- {
            expected.AppendLine("dispose:$i")
        }
        if fail {
            expected.AppendLine("caught:body-failure")
        }
        expected.AppendLine("done")
        let directory = NewDirectory()
        try {
            let (output, _, _) = Compile(directory, source.ToString())
            IlVerifier.Verify(output)
            Assert.Equal(Encoding.UTF8.GetBytes(expected.ToString()), Run(output))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private func NewDirectory() string {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue5258-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            return directory
        }

        private func Compile(directory string, source string)(string, int64, int64) {
            let input = Path.Combine(directory, "Program.gs")
            let output = Path.Combine(directory, "program.dll")
            File.WriteAllText(input, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            using let measurement = CompilationMeasurements.Start("issue5258-driver")
            let previousOut = Console.Out
            let previousError = Console.Error
            try {
                Console.SetOut(stdout)
                Console.SetError(stderr)
                let result = Program.Main(
                    []string{
                        input,
                        "/out:" + output,
                        "/targetframework:net10.0",
                        "/deterministic+",
                        "/r:" + typeof(JsonDocument).Assembly.Location
                    }
                )
                Assert.True(result == 0, "$stdout\n$stderr")
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            return (
                output,
                measurement.GetCounter("definite-assignment.region-analyses"),
                measurement.GetCounter("definite-assignment.region-replays")
            )
        }

        private func Run(output string)[]uint8 {
            let start = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            start.ArgumentList.Add(output)
            using let process = Process.Start(start) ?? throw InvalidOperationException("Could not start dotnet.")
            using let stdout = MemoryStream()
            let copy = process.StandardOutput.BaseStream.CopyToAsync(stdout)
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(30_000) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                Assert.Fail("The emitted program did not finish.")
            }
            copy.GetAwaiter().GetResult()
            Assert.Equal(0, process.ExitCode)
            Assert.Equal(string.Empty, stderr.GetAwaiter().GetResult())
            return stdout.ToArray()
        }
    }
}
