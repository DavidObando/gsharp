// <copyright file="Issue3010EntryPointExitCodeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis.Execution
import GSharp.Repl
import System
import System.IO
import Xunit

/// Issue #3010: integer script results are process exit codes, not displayed values.
@Collection("ConsoleIo")
open class Issue3010EntryPointExitCodeTests {
    @Fact
    func ExplicitMainIntegerResultBecomesExitCode() {
        const Source = `import System

func Main() int32 {
    Console.WriteLine("main")
    return 7
}`
        let result = RunScript(Source)
        Assert.Equal(7, result.ExitCode)
        Assert.Equal("main${Environment.NewLine}", result.StandardOutput)
        Assert.Equal(string.Empty, result.StandardError)
    }

    @Fact
    func TopLevelIntegerResultBecomesExitCode() {
        const Source = `import System

Console.WriteLine("tls")
return 7`
        let result = RunScript(Source)
        Assert.Equal(7, result.ExitCode)
        Assert.Equal("tls${Environment.NewLine}", result.StandardOutput)
        Assert.Equal(string.Empty, result.StandardError)
    }

    @Fact
    func ExplicitMainIntegerZeroReturnsZero() {
        const Source = `import System

func Main() int32 {
    Console.WriteLine("zero")
    return 0
}`
        let result = RunScript(Source)
        Assert.Equal(0, result.ExitCode)
        Assert.Equal("zero${Environment.NewLine}", result.StandardOutput)
        Assert.Equal(string.Empty, result.StandardError)
    }

    @Fact
    func ExplicitMainUnsignedIntegerResultBecomesExitCode() {
        const Source = `import System

func Main() uint32 {
    Console.WriteLine("unsigned")
    return 7
}`
        let result = RunScript(Source)
        Assert.Equal(7, result.ExitCode)
        Assert.Equal("unsigned${Environment.NewLine}", result.StandardOutput)
        Assert.Equal(string.Empty, result.StandardError)
    }

    @Fact
    func ExplicitMainIntegerFalloffIsRejected() {
        const Source = `import System

func Main() int32 {
    Console.WriteLine("must-not-run")
}`
        let result = RunScript(Source)
        Assert.Equal(1, result.ExitCode)
        Assert.Equal(string.Empty, result.StandardOutput)
        Assert.Contains("error GS0100: Not all code paths return a value.", result.StandardError)
    }

    @Fact
    func ExplicitVoidMainDiscardsBareIntegerExpression() {
        const Source = `import System

func Main() {
    Console.WriteLine("void-int")
    40 + 2
}`
        let result = RunScript(Source)
        Assert.Equal(0, result.ExitCode)
        Assert.Equal("void-int${Environment.NewLine}", result.StandardOutput)
        Assert.Equal(string.Empty, result.StandardError)
    }

    @Fact
    func ExplicitVoidMainDiscardsBareStringExpression() {
        const Source = `import System

func Main() {
    Console.WriteLine("void-string")
    "leaked"
}`
        let result = RunScript(Source)
        Assert.Equal(0, result.ExitCode)
        Assert.Equal("void-string${Environment.NewLine}", result.StandardOutput)
        Assert.Equal(string.Empty, result.StandardError)
    }

    @Fact
    func ExplicitVoidMainDiscardsIgnoredIntegerCall() {
        const Source = `import System

func Compute() int32 {
    return 11
}

func Main() {
    Console.WriteLine("void-call-int")
    Compute()
}`
        let result = RunScript(Source)
        Assert.Equal(0, result.ExitCode)
        Assert.Equal("void-call-int${Environment.NewLine}", result.StandardOutput)
        Assert.Equal(string.Empty, result.StandardError)
    }

    @Fact
    func ExplicitVoidMainDiscardsIgnoredGSharpValueCall() {
        const Source = `import System

struct Marker {
    var N int32
}

func Make() Marker {
    return Marker{N: 33}
}

func Main() {
    Console.WriteLine("void-call-type")
    Make()
}`
        let result = RunScript(Source)
        Assert.Equal(0, result.ExitCode)
        Assert.Equal("void-call-type${Environment.NewLine}", result.StandardOutput)
        Assert.Equal(string.Empty, result.StandardError)
    }

    @Fact
    func ExplicitStringMainIsRejectedBeforeExecution() {
        const Source = `import System

func Main() string {
    Console.WriteLine("must-not-run")
    return "invalid"
}`
        let result = RunScript(Source)
        // ADR-0156 Phase 1: the emitted driver mirrors the CLR host, which
        // rejects an invalid entry-point signature with MethodAccessException
        // before running a single statement.
        Assert.Equal(EmittedProgramHost.UnhandledExceptionExitCode, result.ExitCode)
        Assert.Equal(string.Empty, result.StandardOutput)
        Assert.Contains(
            "Unhandled exception. System.MethodAccessException: Entry point must have a return type of void, integer, or unsigned integer.",
            result.StandardError
        )
    }

    @Fact
    func ExplicitGSharpValueMainIsRejectedBeforeExecution() {
        const Source = `import System

struct Marker {
    var N int32
}

func Main() Marker {
    Console.WriteLine("must-not-run")
    return Marker{N: 33}
}`
        let result = RunScript(Source)
        // ADR-0156 Phase 1: same CLR-host rejection shape as the string case.
        Assert.Equal(EmittedProgramHost.UnhandledExceptionExitCode, result.ExitCode)
        Assert.Equal(string.Empty, result.StandardOutput)
        Assert.Contains(
            "Unhandled exception. System.MethodAccessException: Entry point must have a return type of void, integer, or unsigned integer.",
            result.StandardError
        )
    }

    @Fact
    func TopLevelVoidEntryPointDiscardsBareIntegerExpression() {
        const Source = `import System

Console.WriteLine("top-int")
40 + 2`
        let result = RunScript(Source)
        Assert.Equal(0, result.ExitCode)
        Assert.Equal("top-int${Environment.NewLine}", result.StandardOutput)
        Assert.Equal(string.Empty, result.StandardError)
    }

    @Fact
    func TopLevelVoidEntryPointDiscardsBareStringExpression() {
        const Source = `import System

Console.WriteLine("top-string")
"leaked"`
        let result = RunScript(Source)
        Assert.Equal(0, result.ExitCode)
        Assert.Equal("top-string${Environment.NewLine}", result.StandardOutput)
        Assert.Equal(string.Empty, result.StandardError)
    }

    @Fact
    func TopLevelVoidEntryPointDiscardsIgnoredIntegerCall() {
        const Source = `import System

func Compute() int32 {
    return 22
}

Console.WriteLine("top-call-int")
Compute()`
        let result = RunScript(Source)
        Assert.Equal(0, result.ExitCode)
        Assert.Equal("top-call-int${Environment.NewLine}", result.StandardOutput)
        Assert.Equal(string.Empty, result.StandardError)
    }

    @Fact
    func TopLevelNoResultReturnsZero() {
        const Source = `import System

Console.WriteLine("top-no-result")`
        let result = RunScript(Source)
        Assert.Equal(0, result.ExitCode)
        Assert.Equal("top-no-result${Environment.NewLine}", result.StandardOutput)
        Assert.Equal(string.Empty, result.StandardError)
    }

    @Fact
    func DeclarationOnlyScriptReturnsZeroWithoutOutput() {
        let result = RunScript("func Helper() { }")
        Assert.Equal(0, result.ExitCode)
        Assert.Equal(string.Empty, result.StandardOutput)
        Assert.Equal(string.Empty, result.StandardError)
    }

    shared {
        private func RunScript(source string)(ExitCode int32, StandardOutput string, StandardError string) {
            let path = Path.Combine(Environment.CurrentDirectory, ".issue3010-${Guid.NewGuid():N}.gs")
            File.WriteAllText(path, source)
            using let output = StringWriter()
            using let error = StringWriter()
            let previousOutput = Console.Out
            let previousError = Console.Error
            Console.SetOut(output)
            Console.SetError(error)
            try {
                let exitCode = GSharp.Repl.Program.Main([]string{path})
                return (
                    exitCode,
                    output.ToString().ReplaceLineEndings(Environment.NewLine),
                    error.ToString().ReplaceLineEndings(Environment.NewLine)
                )
            } finally {
                Console.SetOut(previousOutput)
                Console.SetError(previousError)
                File.Delete(path)
            }
        }
    }
}
