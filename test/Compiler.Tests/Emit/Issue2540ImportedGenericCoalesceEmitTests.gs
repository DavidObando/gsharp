// <copyright file="Issue2540ImportedGenericCoalesceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

class Issue2540ImportedGenericCoalesceEmitTests {
    @Fact
    func ImportedGenericInterface_CoalescesWithConcreteSingleton() {
        let directory = Path.Combine(AppContext.BaseDirectory, "issue2540-artifacts", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let contractsPath = CompileContracts(directory)
            let implementationsPath = CompileFixture(
                directory,
                "Issue2540.Implementations",
                ImplementationsSource,
                contractsPath
            )
            const source = `package Issue2540.App
import System
import Issue2540.Contracts
import Issue2540.Implementations

class Service {
    private let logger ILogger[Category]

    init(logger ILogger[Category]?) {
        var selected = logger ?? NullLogger.Instance
        this.logger = selected
    }

    func Name() string -> logger!!.Name()!!
}

func Main() {
    Console.WriteLine(Service(nil).Name())
}`
            let outputPath = Path.Combine(directory, "Issue2540.App.dll")
            let result = Compile(directory, source, outputPath, contractsPath, implementationsPath)
            Assert.True(result.ExitCode == 0, (`compile failed
` + "${result.Stdout}" + `
` + "${result.Stderr}"))
            IlVerifier.Verify(outputPath, additionalReferences: []string{contractsPath, implementationsPath})
            Assert.Equal("null${Environment.NewLine}", Run(outputPath))
            const invalidSource = `package Issue2540.Invalid
import Issue2540.Contracts

class Other {}

func Bad(logger ILogger[Category]?) ILogger[Category] {
    return logger ?? Other()
}`
            let invalid = Compile(
                directory,
                invalidSource,
                Path.Combine(directory, "Issue2540.Invalid.dll"),
                contractsPath,
                implementationsPath,
                target: "library"
            )
            Assert.NotEqual(0, invalid.ExitCode)
            Assert.Contains("GS0129", invalid.Stdout + invalid.Stderr, StringComparison.Ordinal)
        } finally {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }
    }

    shared {
        private const ContractsSource string = `package Issue2540.Contracts

interface ILogger[out T] {
    func Name() string;
}

class Category {}`

        private const ImplementationsSource string = `package Issue2540.Implementations
import Issue2540.Contracts

class NullLogger : ILogger[Category] {
    shared {
        let Instance NullLogger = NullLogger()
    }

    func Name() string -> "null"
}`

        private func CompileContracts(directory string) string -> CompileFixture(
            directory,
            "Issue2540.Contracts",
            ContractsSource
        )

        private func CompileFixture(
            directory string,
            assemblyName string,
            source string,
            fixtureReferences ...string
        ) string {
            let outputPath = Path.Combine(directory, assemblyName + ".dll")
            let sourcePath = Path.Combine(directory, assemblyName + ".gs")
            File.WriteAllText(sourcePath, source)
            let args = [fixtureReferences.Length + 4]string
            args[0] = "/out:" + outputPath
            args[1] = "/target:library"
            args[2] = "/targetframework:net10.0"
            for var i = 0; i < fixtureReferences.Length; i++ {
                args[i + 3] = "/reference:" + fixtureReferences[i]
            }
            args[^1] = sourcePath
            let result = RunCompiler(args)
            Assert.True(result.ExitCode == 0, (`fixture compile failed
` + "${result.Stdout}" + `
` + "${result.Stderr}"))
            return outputPath
        }

        private func Compile(
            directory string,
            source string,
            outputPath string,
            contractsPath string,
            implementationsPath string,
            target string = "exe"
        )(ExitCode int32, Stdout string, Stderr string) {
            let sourcePath = Path.Combine(directory, Path.GetFileNameWithoutExtension(outputPath) + ".gs")
            File.WriteAllText(sourcePath, source)
            return RunCompiler(
                []string{
                    "/out:" + outputPath,
                    "/target:" + target,
                    "/targetframework:net10.0",
                    "/reference:" + contractsPath,
                    "/reference:" + implementationsPath,
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
