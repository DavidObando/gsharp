// <copyright file="Issue3010EntryPointDriverMatrixTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Compiler
import GSharp.Repl
import System
import System.Collections.Generic
import System.IO
import Xunit

/// Driver-matrix coverage for issues #2984 and #3010; every driver path uses emitted execution.
@Collection("ConsoleIo")
open class Issue3010EntryPointDriverMatrixTests {
    enum Driver {
        BareCompiler,
        CompilerEmission,
        GsiScript
    }

    @Theory
    @MemberData("DriverCases")
    func EntryPointResultMatrixMatchesDriverContract(
        name string,
        source string,
        driver Issue3010EntryPointDriverMatrixTests.Driver,
        expectedExitCode int32,
        expectedOutput string
    ) {
        let result = Run(name, source, driver)
        Assert.Equal(expectedExitCode, result.ExitCode)
        Assert.Equal(expectedOutput.Replace("\n", Environment.NewLine, StringComparison.Ordinal), result.StandardOutput)
        Assert.Equal(string.Empty, result.StandardError)
    }

    shared {
        func DriverCases() sequence[[]object] {
            let cases = [](string, string, int32, string){("explicit-int-3", `import System

func Main() int32 {
    Console.WriteLine("main-int")
    return 3
}`, 3, "main-int\n"), ("explicit-int-0", `import System

func Main() int32 {
    Console.WriteLine("main-zero")
    return 0
}`, 0, "main-zero\n"), ("explicit-void-bare-int", `import System

func Main() {
    Console.WriteLine("void-bare-int")
    5 + 6
}`, 0, "void-bare-int\n"), ("explicit-void-ignored-int-call", `import System

func Compute() int32 {
    return 22
}

func Main() {
    Console.WriteLine("void-call")
    Compute()
}`, 0, "void-call\n"), ("explicit-void-bare-string", `import System

func Main() {
    Console.WriteLine("void-string")
    "leaked"
}`, 0, "void-string\n"), ("explicit-void-print", `import System

func Main() {
    Console.WriteLine("void-print")
}`, 0, "void-print\n"), ("top-level-bare-int", `import System

Console.WriteLine("top-bare")
16 + 17`, 0, "top-bare\n"), ("top-level-return-3", `import System

Console.WriteLine("top-return")
return 3`, 3, "top-return\n")}
            for (name, source, processExitCode, output) in cases {
                for driver in Enum.GetValues[Issue3010EntryPointDriverMatrixTests.Driver]() {
                    let exitCode = if driver == Issue3010EntryPointDriverMatrixTests.Driver.BareCompiler {
                        0
                    } else {
                        processExitCode
                    }
                    let standardOutput = if driver == Issue3010EntryPointDriverMatrixTests.Driver.BareCompiler {
                        output + "Success.\n"
                    } else {
                        output
                    }
                    yield[]object{name, source, driver, exitCode, standardOutput}
                }
            }
        }

        internal func Run(name string, source string, driver Issue3010EntryPointDriverMatrixTests.Driver)(
            ExitCode int32,
            StandardOutput string,
            StandardError string
        ) {
            let root = Path.Combine(Environment.CurrentDirectory, ".issue3010-matrix-${Guid.NewGuid():N}")
            Directory.CreateDirectory(root)
            let sourcePath = Path.Combine(root, name + ".gs")
            File.WriteAllText(sourcePath, source)
            try {
                return switch driver {
                    case Issue3010EntryPointDriverMatrixTests
                        .Driver
                        .BareCompiler: CaptureConsole(() -> GSharp.Compiler.Program.Main([]string{sourcePath}))
                    case Issue3010EntryPointDriverMatrixTests
                        .Driver
                        .CompilerEmission: CompileAndRun(root, name, sourcePath)
                    case Issue3010EntryPointDriverMatrixTests
                        .Driver
                        .GsiScript: CaptureConsole(() -> GSharp.Repl.Program.Main([]string{sourcePath}))
                    default: throw InvalidOperationException("Unexpected driver $driver.")
                }
            } finally {
                Directory.Delete(root, recursive: true)
            }
        }

        private func CompileAndRun(root string, name string, sourcePath string)(
            ExitCode int32,
            StandardOutput string,
            StandardError string
        ) {
            let outputDirectory = Path.Combine(root, "emit")
            Directory.CreateDirectory(outputDirectory)
            let assemblyPath = Path.Combine(outputDirectory, name + ".dll")
            let compile = CaptureConsole(
                () -> GSharp.Compiler.Program.Main([]string{sourcePath, "/out:" + assemblyPath})
            )
            Assert.Equal(0, compile.ExitCode)
            Assert.True(File.Exists(assemblyPath), compile.StandardOutput + compile.StandardError)
            let result = DotnetProcess.Run(outputDirectory, assemblyPath)
            return (
                result.ExitCode,
                result.StandardOutput.ReplaceLineEndings(Environment.NewLine),
                result.StandardError.ReplaceLineEndings(Environment.NewLine)
            )
        }

        private func CaptureConsole(action() -> int32)(ExitCode int32, StandardOutput string, StandardError string) {
            using let output = StringWriter()
            using let error = StringWriter()
            let previousOutput = Console.Out
            let previousError = Console.Error
            Console.SetOut(output)
            Console.SetError(error)
            try {
                return (
                    action(),
                    output.ToString().ReplaceLineEndings(Environment.NewLine),
                    error.ToString().ReplaceLineEndings(Environment.NewLine)
                )
            } finally {
                Console.SetOut(previousOutput)
                Console.SetError(previousError)
            }
        }
    }
}
