// <copyright file="Issue2941FlagsEnumExhaustivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Diagnostics
import System.IO
import System.Reflection
import GSharp.Compiler
import GSharp.Tests
import Xunit
import GSharp.Compiler.Tests

/// Issue #2941: name-complete enum switches run identically regardless of
/// flags annotation, symbol origin, or switch form.
open class Issue2941FlagsEnumExhaustivenessTests {
    @Fact
    func NameCompleteEnumSwitches_LoadAndRunWithExactOutput() {
        let assemblyPath = Compile(Source)
        let assembly = EmittedFixture.Load(assemblyPath)
        Assert.NotEmpty(assembly.GetTypes())
        for var i = 0; i < 3; i++ {
            let result = RunBounded(assemblyPath)
            Assert.True(result.ExitCode == 0, (`emitted program failed:
` + "${result.Error}"))
            Assert.Equal(
                "11${Environment.NewLine}22${Environment.NewLine}31${Environment.NewLine}42${Environment.NewLine}51${Environment.NewLine}62${Environment.NewLine}",
                result.Output
            )
        }
        IlVerifier.Verify(assemblyPath)
    }

    @Fact
    func UnmatchedFlagsValue_FailsLoudly() {
        let assemblyPath = Compile(UnmatchedSource)
        let assembly = EmittedFixture.Load(assemblyPath)
        Assert.NotEmpty(assembly.GetTypes())
        let result = RunBounded(assemblyPath)
        Assert.NotEqual(0, result.ExitCode)
        Assert.Empty(result.Output)
        Assert.Contains("System.InvalidOperationException: Unmatched switch expression value.", result.Error)
        IlVerifier.Verify(assemblyPath)
    }

    shared {
        private const UnmatchedSource string = `package Issue2941.Unmatched
import System

@Flags
enum Access { None = 0, Read = 1, Write = 2 }

func F(x Access) int32 {
    return switch x {
        case Access.None: 0
        case Access.Read: 1
        case Access.Write: 2
    }
}

Console.WriteLine(F(Access.Read | Access.Write))`

        private const Source string = `package Issue2941.Runtime
import System

@Flags
enum Access { None = 0, Read = 1, Write = 2 }

enum Plain { None, Read, Write }

func importedStatement(x StringSplitOptions) int32 {
    switch x {
        case StringSplitOptions.None { return 10 }
        case StringSplitOptions.RemoveEmptyEntries { return 11 }
        case StringSplitOptions.TrimEntries { return 12 }
    }
}

func importedExpression(x StringSplitOptions) int32 {
    return switch x {
        case StringSplitOptions.None: 20
        case StringSplitOptions.RemoveEmptyEntries: 21
        case StringSplitOptions.TrimEntries: 22
    }
}

func userStatement(x Access) int32 {
    switch x {
        case Access.None { return 30 }
        case Access.Read { return 31 }
        case Access.Write { return 32 }
    }
}

func userExpression(x Access) int32 {
    return switch x {
        case Access.None: 40
        case Access.Read: 41
        case Access.Write: 42
    }
}

func plainStatement(x Plain) int32 {
    switch x {
        case Plain.None { return 50 }
        case Plain.Read { return 51 }
        case Plain.Write { return 52 }
    }
}

func plainExpression(x Plain) int32 {
    return switch x {
        case Plain.None: 60
        case Plain.Read: 61
        case Plain.Write: 62
    }
}

Console.WriteLine(importedStatement(StringSplitOptions.RemoveEmptyEntries))
Console.WriteLine(importedExpression(StringSplitOptions.TrimEntries))
Console.WriteLine(userStatement(Access.Read))
Console.WriteLine(userExpression(Access.Write))
Console.WriteLine(plainStatement(Plain.Read))
Console.WriteLine(plainExpression(Plain.Write))`

        private func Compile(source string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2941FlagsEnumExhaustivenessTests")
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let assemblyPath = Path.Combine(directory, "Issue2941FlagsEnumExhaustiveness.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousErr = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(
                    []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousErr)
            }
            Assert.True(exitCode == 0, (`gsc failed:
` + "$stdout" + `
` + "$stderr"))
            return assemblyPath
        }

        private func RunBounded(assemblyPath string)(ExitCode int32, Output string, Error string) {
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
            let outputTask = process!!.StandardOutput.ReadToEndAsync()
            let errorTask = process!!.StandardError.ReadToEndAsync()
            let exited = process!!.WaitForExit(30_000)
            if !exited {
                process!!.Kill(entireProcessTree: true)
                process!!.WaitForExit()
            }
            Assert.True(exited, "emitted program timed out")
            let output = outputTask.GetAwaiter().GetResult()
            let error = errorTask.GetAwaiter().GetResult()
            return (
                process!!.ExitCode,
                output.ReplaceLineEndings(Environment.NewLine),
                error.ReplaceLineEndings(Environment.NewLine)
            )
        }
    }
}
