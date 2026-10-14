// <copyright file="Issue2621ImportedGenericConstructorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

class Issue2621ImportedGenericConstructorEmitTests {
    @Fact
    func ImportedGenericConstructor_Overloads_CompileAndRun() {
        let directory = Path.Combine(AppContext.BaseDirectory, "issue2621-artifacts", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let fixturePath = CompileFixture(directory)
            const source = `package Oahu.Cli.Commands
import System
import System.Collections.Generic
import Issue2621.Fixture

let bucket = Bucket[string](7)
let empty = Bucket[string]()
let rows = List[IReadOnlyDictionary[string, object?]](3)
Console.WriteLine(bucket.Capacity)
Console.WriteLine(empty.Capacity)
Console.WriteLine(rows.Capacity)`
            let outputPath = Path.Combine(directory, "Oahu.Cli.dll")
            let result = Compile(directory, source, outputPath, fixturePath)
            Assert.True(result.ExitCode == 0, (`compile failed
` + "${result.Stdout}" + `
` + "${result.Stderr}"))
            IlVerifier.Verify(outputPath, additionalReferences: []string{fixturePath})
            Assert.Equal("7${Environment.NewLine}0${Environment.NewLine}3${Environment.NewLine}", Run(outputPath))
            const invalidSource = `package Oahu.Cli.Commands
import Issue2621.Fixture

let bucket = Bucket[string]("bad")`
            let invalid = Compile(
                directory,
                invalidSource,
                Path.Combine(directory, "Invalid.dll"),
                fixturePath,
                target: "library"
            )
            let diagnostics = invalid.Stdout + invalid.Stderr
            Assert.NotEqual(0, invalid.ExitCode)
            Assert.Contains("GS0267", diagnostics, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0130", diagnostics, StringComparison.Ordinal)
        } finally {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }
    }

    shared {
        private const FixtureSource string = `package Issue2621.Fixture

class Bucket[T] {
    private var capacity int32

    init() {
        capacity = 0
    }

    init(capacity int32) {
        this.capacity = capacity
    }

    prop Capacity int32 -> capacity
}`

        private func CompileFixture(directory string) string {
            let sourcePath = Path.Combine(directory, "Fixture.gs")
            let outputPath = Path.Combine(directory, "Issue2621.Fixture.dll")
            File.WriteAllText(sourcePath, FixtureSource)
            let result = RunCompiler(
                []string{"/out:" + outputPath, "/target:library", "/targetframework:net10.0", sourcePath}
            )
            Assert.True(result.ExitCode == 0, (`fixture compile failed
` + "${result.Stdout}" + `
` + "${result.Stderr}"))
            return outputPath
        }

        private func Compile(
            directory string,
            source string,
            outputPath string,
            fixturePath string,
            target string = "exe"
        )(ExitCode int32, Stdout string, Stderr string) {
            let sourcePath = Path.Combine(directory, Path.GetFileNameWithoutExtension(outputPath) + ".gs")
            File.WriteAllText(sourcePath, source)
            return RunCompiler(
                []string{
                    "/out:" + outputPath,
                    "/target:" + target,
                    "/targetframework:net10.0",
                    "/reference:" + fixturePath,
                    sourcePath
                }
            )
        }

        private func RunCompiler(args[]string)(ExitCode int32, Stdout string, Stderr string) {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                return (Program.Main(args), stdout.ToString(), stderr.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func Run(assemblyPath string) string {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath)!!
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
            Assert.True(process.ExitCode == 0, (`exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
