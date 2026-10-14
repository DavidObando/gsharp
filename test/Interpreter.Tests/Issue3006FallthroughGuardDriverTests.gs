// <copyright file="Issue3006FallthroughGuardDriverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Compiler
import GSharp.Core.CodeAnalysis
import GSharp.Repl
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Threading
import System.Threading.Tasks
import Xunit

/// Issue #3006: every user-function invocation path must surface the non-void
/// fallthrough guard instead of returning `default(T)`.
open class Issue3006FallthroughGuardDriverTests {
    @Theory
    @MemberData("FallthroughCases")
    async func UnmatchedExhaustiveSwitch_AllDriversSurfaceGuard(name string, source string) {
        // ADR-0156 Phase 1: every driver executes emitted code, so all three
        // surface the guard identically — the InvalidOperationException crash
        // protocol of the CLR host, not an interpreter diagnostic.
        let root = CreateEmptyProbeRoot(name)
        try {
            let bareCompiler = RunSourceDriver(
                CreateEmptyDirectory(root, "bare-gsc"),
                source,
                GSharp.Compiler.Program.Main
            )
            Assert.Equal(ExpectedUnhandledExceptionExitCode, bareCompiler.ExitCode)
            Assert.Equal(string.Empty, bareCompiler.StandardOutput)
            Assert.Contains(
                "Unhandled exception. System.InvalidOperationException: $GuardMessage",
                bareCompiler.StandardError
            )
            let gsi = RunSourceDriver(CreateEmptyDirectory(root, "gsi"), source, GSharp.Repl.Program.Main)
            Assert.Equal(ExpectedUnhandledExceptionExitCode, gsi.ExitCode)
            Assert.Equal(string.Empty, gsi.StandardOutput)
            Assert.Contains("Unhandled exception. System.InvalidOperationException: $GuardMessage", gsi.StandardError)
            let emitted = await CompileAndRunAsync(CreateEmptyDirectory(root, "gsc-emit"), source)
            Assert.Equal(0, emitted.Compile.ExitCode)
            Assert.Equal(string.Empty, emitted.Compile.StandardError)
            Assert.Equal(ExpectedUnhandledExceptionExitCode, emitted.Execution.ExitCode)
            Assert.Equal(string.Empty, emitted.Execution.StandardOutput)
            Assert.Contains("System.InvalidOperationException: $GuardMessage", emitted.Execution.StandardError)
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Fact
    async func ExhaustiveControlFlow_AllDriversReturnDistinctValues() {
        const Source = `import System

enum E { A, B, C }

func EnumSwitch(x E) int32 {
    switch x {
        case E.A { return 11 }
        case E.B { return 22 }
        case E.C { return 33 }
    }
}

func IntSwitch(x int32) int32 {
    switch x {
        case 1 { return 44 }
        default { return 55 }
    }
}

func StringIf(x string) int32 {
    if x == "first" {
        return 66
    } else {
        return 77
    }
}

func ProtectedReturn() int32 {
    try {
        return 88
    } finally {
    }
}

func Generic[T any](value T) T {
    return value
}

func ExpressionSwitch(x E) int32 {
    return switch x {
        case E.A: 111
        case E.B: 222
        case E.C: 333
    }
}

func InfiniteLoop() int32 {
    for {
    }
}

Console.WriteLine(EnumSwitch(E.B))
Console.WriteLine(IntSwitch(9))
Console.WriteLine(StringIf("other"))
Console.WriteLine(ProtectedReturn())
Console.WriteLine(Generic("generic"))
Console.WriteLine(ExpressionSwitch(E.C))`
        let expected = "22${Environment.NewLine}" +
            "55${Environment.NewLine}" +
            "77${Environment.NewLine}" +
            "88${Environment.NewLine}" +
            "generic${Environment.NewLine}" +
            "333${Environment.NewLine}"
        let root = CreateEmptyProbeRoot("Valid")
        try {
            let bareCompiler = RunSourceDriver(
                CreateEmptyDirectory(root, "bare-gsc"),
                Source,
                GSharp.Compiler.Program.Main
            )
            Assert.Equal(0, bareCompiler.ExitCode)
            Assert.Equal(expected + "Success.${Environment.NewLine}", bareCompiler.StandardOutput)
            Assert.Equal(string.Empty, bareCompiler.StandardError)
            let gsi = RunSourceDriver(CreateEmptyDirectory(root, "gsi"), Source, GSharp.Repl.Program.Main)
            Assert.Equal(0, gsi.ExitCode)
            Assert.Equal(expected, gsi.StandardOutput)
            Assert.Equal(string.Empty, gsi.StandardError)
            let emitted = await CompileAndRunAsync(CreateEmptyDirectory(root, "gsc-emit"), Source)
            Assert.Equal(0, emitted.Compile.ExitCode)
            Assert.Equal(string.Empty, emitted.Compile.StandardError)
            Assert.Equal(0, emitted.Execution.ExitCode)
            Assert.Equal(expected, emitted.Execution.StandardOutput)
            Assert.Equal(string.Empty, emitted.Execution.StandardError)
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Fact
    async func FallthroughGuard_PreservesInvalidOperationExceptionType() {
        const Source = `import System

func F(x DateTimeKind) int32 {
    switch x {
        case DateTimeKind.Unspecified { return 11 }
        case DateTimeKind.Utc { return 22 }
        case DateTimeKind.Local { return 33 }
    }
}

try {
    F(DateTimeKind(99))
} catch (ex InvalidOperationException) {
    Console.WriteLine(ex.Message)
}`
        let expected = GuardMessage + Environment.NewLine
        let root = CreateEmptyProbeRoot("Caught")
        try {
            let bareCompiler = RunSourceDriver(
                CreateEmptyDirectory(root, "bare-gsc"),
                Source,
                GSharp.Compiler.Program.Main
            )
            Assert.Equal(0, bareCompiler.ExitCode)
            Assert.Equal(expected + "Success.${Environment.NewLine}", bareCompiler.StandardOutput)
            Assert.Equal(string.Empty, bareCompiler.StandardError)
            let gsi = RunSourceDriver(CreateEmptyDirectory(root, "gsi"), Source, GSharp.Repl.Program.Main)
            Assert.Equal(0, gsi.ExitCode)
            Assert.Equal(expected, gsi.StandardOutput)
            Assert.Equal(string.Empty, gsi.StandardError)
            let emitted = await CompileAndRunAsync(CreateEmptyDirectory(root, "gsc-emit"), Source)
            Assert.Equal(0, emitted.Compile.ExitCode)
            Assert.Equal(string.Empty, emitted.Compile.StandardError)
            Assert.Equal(0, emitted.Execution.ExitCode)
            Assert.Equal(expected, emitted.Execution.StandardOutput)
            Assert.Equal(string.Empty, emitted.Execution.StandardError)
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    /// ADR-0156 Phase 1: the guard is a runtime exception on every driver, so
    /// the evaluator's GS0100 diagnostic (which carried the function's
    /// declaration location) is gone. What remains observable — and what this
    /// pins so a silently swallowed guard cannot pass — is the crash protocol:
    /// the CLR-host "Unhandled exception." prefix, the exception type and
    /// guard message, and a stack trace rooted in the program's own frames.
    @Fact
    func FallthroughGuard_RendersClrHostCrashProtocol() {
        let source = `import System

` + `func F(x DateTimeKind) int32 {
    switch x {
        case DateTimeKind.Unspecified { return 11 }
        case DateTimeKind.Utc { return 22 }
        case DateTimeKind.Local { return 33 }
    }
}

F(DateTimeKind(99))`
        let root = CreateEmptyProbeRoot("CrashProtocol")
        try {
            let bareCompiler = RunSourceDriver(
                CreateEmptyDirectory(root, "bare-gsc"),
                source,
                GSharp.Compiler.Program.Main
            )
            Assert.Equal(ExpectedUnhandledExceptionExitCode, bareCompiler.ExitCode)
            AssertCrashProtocol(bareCompiler.StandardError)
            let gsi = RunSourceDriver(CreateEmptyDirectory(root, "gsi"), source, GSharp.Repl.Program.Main)
            Assert.Equal(ExpectedUnhandledExceptionExitCode, gsi.ExitCode)
            AssertCrashProtocol(gsi.StandardError)
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    private data class DriverResult(ExitCode int32, StandardOutput string, StandardError string) : IEquatable[
        Issue3006FallthroughGuardDriverTests.DriverResult
    ] { }

    shared {
        private const GuardMessage string = DiagnosticDescriptors.NonVoidFallthroughGuardMessage

        func FallthroughCases() sequence[[]object] {
            yield Case("DirectFunction", `import System

func F(x DateTimeKind) int32 {
    switch x {
        case DateTimeKind.Unspecified { return 11 }
        case DateTimeKind.Utc { return 22 }
        case DateTimeKind.Local { return 33 }
    }
}

Console.WriteLine(F(DateTimeKind(99)))`)
            yield Case("EntryPoint", `import System

func Main() int32 {
    let x = DateTimeKind(99)
    switch x {
        case DateTimeKind.Unspecified { return 11 }
        case DateTimeKind.Utc { return 22 }
        case DateTimeKind.Local { return 33 }
    }
}`)
            yield Case("NestedFunctionCall", `import System

func F(x DateTimeKind) int32 {
    switch x {
        case DateTimeKind.Unspecified { return 11 }
        case DateTimeKind.Utc { return 22 }
        case DateTimeKind.Local { return 33 }
    }
}

func Invoke() int32 {
    return F(DateTimeKind(99))
}

Console.WriteLine(Invoke())`)
            yield Case("FixedArm", `import System

func F(x DateTimeKind, values []int32) int32 {
    switch x {
        case DateTimeKind.Unspecified {
            unsafe {
                fixed p *int32 = values {
                    return *p
                }
            }
        }
        case DateTimeKind.Utc { return 22 }
        case DateTimeKind.Local { return 33 }
    }
}

Console.WriteLine(F(DateTimeKind(99), []int32{11}))`)
            yield Case("ProtectedFinally", `import System

func F(x DateTimeKind) int32 {
    try {
        switch x {
            case DateTimeKind.Unspecified { return 11 }
            case DateTimeKind.Utc { return 22 }
            case DateTimeKind.Local { return 33 }
        }
    } finally {
    }
}

Console.WriteLine(F(DateTimeKind(99)))`)
            yield Case("LambdaInvoke", `import System

let f = func(x DateTimeKind) int32 {
    switch x {
        case DateTimeKind.Unspecified { return 11 }
        case DateTimeKind.Utc { return 22 }
        case DateTimeKind.Local { return 33 }
    }
}

Console.WriteLine(f(DateTimeKind(99)))`)
            yield Case("InstanceMethod", `import System

class C {
    func F(x DateTimeKind) int32 {
        switch x {
            case DateTimeKind.Unspecified { return 11 }
            case DateTimeKind.Utc { return 22 }
            case DateTimeKind.Local { return 33 }
        }
    }
}

Console.WriteLine(C().F(DateTimeKind(99)))`)
            yield Case("PropertyGetter", `import System

class C {
    prop Kind DateTimeKind
    prop Value int32 {
        get {
            switch this.Kind {
                case DateTimeKind.Unspecified { return 11 }
                case DateTimeKind.Utc { return 22 }
                case DateTimeKind.Local { return 33 }
            }
        }
    }
}

let c = C{}
c.Kind = DateTimeKind(99)
Console.WriteLine(c.Value)`)
            yield Case("StaticPropertyGetter", `import System

class C {
    shared {
        prop Kind DateTimeKind -> DateTimeKind(99)
        prop Value int32 {
            get {
                switch Kind {
                    case DateTimeKind.Unspecified { return 11 }
                    case DateTimeKind.Utc { return 22 }
                    case DateTimeKind.Local { return 33 }
                }
            }
        }
    }
}

Console.WriteLine(C.Value)`)
            yield Case("IndexerGetter", `import System

class C {
    prop this[x DateTimeKind] int32 {
        get {
            switch x {
                case DateTimeKind.Unspecified { return 11 }
                case DateTimeKind.Utc { return 22 }
                case DateTimeKind.Local { return 33 }
            }
        }
    }
}

Console.WriteLine(C{}[DateTimeKind(99)])`)
            yield Case("UserOperator", `import System

struct Choice {
    var Kind DateTimeKind
}

func (left Choice) operator +(right Choice) int32 {
    switch left.Kind {
        case DateTimeKind.Unspecified { return 11 }
        case DateTimeKind.Utc { return 22 }
        case DateTimeKind.Local { return 33 }
    }
}

Console.WriteLine(Choice{Kind: DateTimeKind(99)} + Choice{})`)
            yield Case("LiftedNullableOperator", `import System

struct Choice(Kind DateTimeKind) {
}

func (left Choice) operator +(right Choice) int32 {
    switch left.Kind {
        case DateTimeKind.Unspecified { return 11 }
        case DateTimeKind.Utc { return 22 }
        case DateTimeKind.Local { return 33 }
    }
}

let left Choice? = Choice(DateTimeKind(99))
let right Choice? = Choice(DateTimeKind.Utc)
Console.WriteLine((left + right)!!)`)
        }

        private func AssertCrashProtocol(standardError string) {
            Assert.StartsWith(
                "Unhandled exception. System.InvalidOperationException: $GuardMessage",
                standardError,
                StringComparison.Ordinal
            )
            Assert.Contains("   at Default.<Program>.<Main>$$(String[] args)", standardError, StringComparison.Ordinal)
            Assert.DoesNotContain("MethodBaseInvoker", standardError, StringComparison.Ordinal)
        }

        private prop ExpectedUnhandledExceptionExitCode int32 -> if OperatingSystem.IsWindows() {
            unchecked(int32(0xE0434352U))
        } else {
            134
        }

        private func Case(name string, source string)[]object -> []object{name, source}

        private func CreateEmptyProbeRoot(name string) string {
            let root = Path.Combine(GetRepositoryRoot(), "out", "test-artifacts", "issue3006-$name-${Guid.NewGuid():N}")
            Assert.False(Directory.Exists(root))
            Directory.CreateDirectory(root)
            Assert.Empty(Directory.EnumerateFileSystemEntries(root))
            return root
        }

        private func CreateEmptyDirectory(root string, name string) string {
            let directory = Path.Combine(root, name)
            Assert.False(Directory.Exists(directory))
            Directory.CreateDirectory(directory)
            Assert.Empty(Directory.EnumerateFileSystemEntries(directory))
            return directory
        }

        private func RunSourceDriver(
            directory string,
            source string,
            driver([]string) -> int32
        ) Issue3006FallthroughGuardDriverTests
            .DriverResult {
            let sourcePath = Path.Combine(directory, "Probe.gs")
            File.WriteAllText(sourcePath, source)
            return CaptureDriver(() -> driver([]string{sourcePath}))
        }

        private async func CompileAndRunAsync(directory string, source string)(
            Compile Issue3006FallthroughGuardDriverTests.DriverResult,
            Execution Issue3006FallthroughGuardDriverTests.DriverResult
        ) {
            let sourcePath = Path.Combine(directory, "Probe.gs")
            let assemblyPath = Path.Combine(directory, "Probe.dll")
            File.WriteAllText(sourcePath, source)
            let compile = CaptureDriver(
                () -> GSharp
                    .Compiler
                    .Program
                    .Main([]string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath})
            )
            if compile.ExitCode != 0 {
                return (compile, Issue3006FallthroughGuardDriverTests.DriverResult(-1, string.Empty, string.Empty))
            }
            let result = await DotnetProcess.RunAsync(directory, []string{assemblyPath})
            return (
                compile,
                Issue3006FallthroughGuardDriverTests.DriverResult(
                    result.ExitCode,
                    result.StandardOutput,
                    result.StandardError
                )
            )
        }

        private func CaptureDriver(driver() -> int32) Issue3006FallthroughGuardDriverTests.DriverResult {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = driver()
                return Issue3006FallthroughGuardDriverTests.DriverResult(exitCode, stdout.ToString(), stderr.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func GetRepositoryRoot() string {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil && !RepositoryRootMarker.IsRoot(directory.FullName) {
                directory = directory.Parent
            }
            return directory?.FullName ?? throw InvalidOperationException("Could not locate repository root.")
        }
    }
}
