// <copyright file="Issue2953FixedReturnFallthroughGuardTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #2953: compiler-generated return epilogues must not turn unmatched
/// exhaustive-switch fallthrough into a default return value.
open class Issue2953FixedReturnFallthroughGuardTests {
    @Theory
    @MemberData("FallthroughCases")
    func UnmatchedExhaustiveSwitch_LoadsAndThrowsInChildProcess(name string, source string) {
        let execution = CompileLoadAndRun(name, source)
        Assert.NotEqual(0, execution.ExitCode)
        Assert.Equal(string.Empty, execution.StandardOutput)
        Assert.Contains("System.InvalidOperationException: $GuardMessage", execution.StandardError)
    }

    @Fact
    func FixedReturnPath_BypassesGuardAndReturnsValue() {
        const Source = `package Issue2953.ValidFixedReturn
import System
func F(x DateTimeKind, values []int32) int32 {
    switch x {
        case DateTimeKind.Unspecified {
            unsafe {
                fixed p *int32 = values {
                    return *p
                }
            }
        }
        case DateTimeKind.Utc { return 2 }
        case DateTimeKind.Local { return 3 }
    }
}
Console.WriteLine(F(DateTimeKind.Unspecified, []int32{7}))`
        let execution = CompileLoadAndRun("ValidFixedReturn", Source)
        Assert.Equal(0, execution.ExitCode)
        Assert.Equal("7${Environment.NewLine}", execution.StandardOutput)
        Assert.Equal(string.Empty, execution.StandardError)
    }

    @Fact
    func ProtectedReturnPath_BypassesGuardAndReturnsValue() {
        const Source = `package Issue2953.ValidProtectedReturn
import System
func F() int32 {
    try {
        return 8
    } finally {
    }
}
Console.WriteLine(F())`
        let execution = CompileLoadAndRun("ValidProtectedReturn", Source)
        Assert.Equal(0, execution.ExitCode)
        Assert.Equal("8${Environment.NewLine}", execution.StandardOutput)
        Assert.Equal(string.Empty, execution.StandardError)
    }

    @Fact
    func VoidProtectedFallthrough_DoesNotEmitNonVoidGuard() {
        const Source = `package Issue2953.VoidProtectedFallthrough
import System
func F(condition bool) {
    try {
        if condition {
            return
        }
    } finally {
    }
    Console.WriteLine("done")
}
F(false)`
        let execution = CompileLoadAndRun("VoidProtectedFallthrough", Source)
        Assert.Equal(0, execution.ExitCode)
        Assert.Equal("done${Environment.NewLine}", execution.StandardOutput)
        Assert.Equal(string.Empty, execution.StandardError)
    }

    @Fact
    func NonExhaustiveSwitch_WithRewrittenReturnStillReportsGs0100() {
        let sources = []string{`package Issue2953.NonExhaustiveFixed
func F(x int32, values []int32) int32 {
    switch x {
        case 0 {
            unsafe {
                fixed p *int32 = values {
                    return *p
                }
            }
        }
    }
}`, `package Issue2953.NonExhaustiveProtected
func F(x int32) int32 {
    try {
        switch x {
            case 0 { return 1 }
        }
    } finally {
    }
}`}
        for source in sources {
            using let peStream = MemoryStream()
            let result = Compilation(SyntaxTree.Parse(SourceText.From(source))).Emit(peStream)
            let diagnostic = Assert.Single(result.Diagnostics)
            Assert.False(result.Success)
            Assert.Equal("GS0100", diagnostic.Id)
            Assert.Equal(int64(0), peStream.Length)
        }
    }

    private data class ExecutionResult(ExitCode int32, StandardOutput string, StandardError string) : IEquatable[
        ExecutionResult
    ] { }

    shared {
        private const GuardMessage string = DiagnosticDescriptors.NonVoidFallthroughGuardMessage

        /// Gets fixed and protected-return shapes that must reach the fallthrough guard.
        func FallthroughCases() sequence[[]object] {
            yield Case("FixedArm", `func F(x DateTimeKind, values []int32) int32 {
    switch x {
        case DateTimeKind.Unspecified {
            unsafe {
                fixed p *int32 = values {
                    return *p
                }
            }
        }
        case DateTimeKind.Utc { return 2 }
        case DateTimeKind.Local { return 3 }
    }
}
Console.WriteLine(F(DateTimeKind(99), []int32{7}))`)
            yield Case("SealedPatternFixed", `sealed interface Expr { }
class Literal : Expr { }
func F(x Expr, values []int32) int32 {
    switch x {
        case _ is Literal {
            unsafe {
                fixed p *int32 = values {
                    return *p
                }
            }
        }
    }
}
Console.WriteLine(F(default(Expr), []int32{7}))`)
            yield Case("NestedFixed", `func F(x DateTimeKind, values []int32) int32 {
    switch x {
        case DateTimeKind.Unspecified {
            unsafe {
                fixed p *int32 = values {
                    fixed q *int32 = values {
                        return *q
                    }
                }
            }
        }
        case DateTimeKind.Utc { return 2 }
        case DateTimeKind.Local { return 3 }
    }
}
Console.WriteLine(F(DateTimeKind(99), []int32{7}))`)
            yield Case("SwitchInsideFixed", `func F(x DateTimeKind, values []int32) int32 {
    unsafe {
        fixed p *int32 = values {
            switch x {
                case DateTimeKind.Unspecified { return *p }
                case DateTimeKind.Utc { return 2 }
                case DateTimeKind.Local { return 3 }
            }
        }
    }
}
Console.WriteLine(F(DateTimeKind(99), []int32{7}))`)
            yield Case("FixedInsideLoop", `func F(x DateTimeKind, values []int32) int32 {
    switch x {
        case DateTimeKind.Unspecified {
            for {
                unsafe {
                    fixed p *int32 = values {
                        return *p
                    }
                }
            }
        }
        case DateTimeKind.Utc { return 2 }
        case DateTimeKind.Local { return 3 }
    }
}
Console.WriteLine(F(DateTimeKind(99), []int32{7}))`)
            yield Case("FixedInsideTry", `func F(x DateTimeKind, values []int32) int32 {
    switch x {
        case DateTimeKind.Unspecified {
            try {
                unsafe {
                    fixed p *int32 = values {
                        return *p
                    }
                }
            } finally {
            }
        }
        case DateTimeKind.Utc { return 2 }
        case DateTimeKind.Local { return 3 }
    }
}
Console.WriteLine(F(DateTimeKind(99), []int32{7}))`)
            yield Case("TryInsideFixed", `func F(x DateTimeKind, values []int32) int32 {
    switch x {
        case DateTimeKind.Unspecified {
            unsafe {
                fixed p *int32 = values {
                    try {
                        return *p
                    } finally {
                    }
                }
            }
        }
        case DateTimeKind.Utc { return 2 }
        case DateTimeKind.Local { return 3 }
    }
}
Console.WriteLine(F(DateTimeKind(99), []int32{7}))`)
            yield Case("PlainTry", `func F(x DateTimeKind) int32 {
    try {
        switch x {
            case DateTimeKind.Unspecified { return 1 }
            case DateTimeKind.Utc { return 2 }
            case DateTimeKind.Local { return 3 }
        }
    } finally {
    }
}
Console.WriteLine(F(DateTimeKind(99)))`)
            yield Case("Scope", `func F(x DateTimeKind) int32 {
    switch x {
        case DateTimeKind.Unspecified {
            scope {
                return 1
            }
        }
        case DateTimeKind.Utc { return 2 }
        case DateTimeKind.Local { return 3 }
    }
}
Console.WriteLine(F(DateTimeKind(99)))`)
        }

        private func Case(name string, body string)[]object -> []object{
            name,
            "package Issue2953.$name${Environment.NewLine}import System${Environment.NewLine}$body"
        }

        private func CompileLoadAndRun(name string, source string) ExecutionResult {
            using let peStream = MemoryStream()
            let emit = Compilation(SyntaxTree.Parse(SourceText.From(source))).Emit(peStream)
            Assert.True(
                emit.Success,
                string.Join(
                    Environment.NewLine,
                    emit.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.ToString())
                )
            )
            let bytes = peStream.ToArray()
            let assembly = EmittedFixture.Load(bytes)
            Assert.NotEmpty(assembly.GetTypes())
            let stem = "Issue2953_${name}_${Guid.NewGuid():N}"
            let directory = Directory.GetCurrentDirectory()
            let assemblyPath = Path.Combine(directory, stem + ".dll")
            let runtimeConfigPath = Path.Combine(directory, stem + ".runtimeconfig.json")
            try {
                File.WriteAllBytes(assemblyPath, bytes)
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": {
      "name": "Microsoft.NETCore.App",
      "version": "10.0.0"
    }
  }
}`)
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = directory
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add("--runtimeconfig")
                startInfo.ArgumentList.Add(runtimeConfigPath)
                startInfo.ArgumentList.Add(assemblyPath)
                using let process = Process.Start(startInfo) ??
                    throw InvalidOperationException("Failed to start compiled issue #2953 probe.")
                let stdoutTask = process.StandardOutput.ReadToEndAsync()
                let stderrTask = process.StandardError.ReadToEndAsync()
                if !process.WaitForExit(30_000) {
                    process.Kill(entireProcessTree: true)
                    Assert.Fail("$name execution timed out.")
                }
                let standardOutput = stdoutTask.GetAwaiter().GetResult()
                let standardError = stderrTask.GetAwaiter().GetResult()
                return ExecutionResult(process.ExitCode, standardOutput, standardError)
            } finally {
                File.Delete(assemblyPath)
                File.Delete(runtimeConfigPath)
            }
        }
    }
}
