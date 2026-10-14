// <copyright file="Issue2921LambdaBodyDefiniteReturnTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #2921: non-void lambda bodies enforce GS0100 before emission.
open class Issue2921LambdaBodyDefiniteReturnTests {
    @Theory
    @MemberData("MissingReturnCases")
    func MissingReturnReportsSingleGs0100AndDoesNotEmit(name string, source string) {
        let result = InvokeCompiler(source, name)
        Assert.NotEqual(0, result.ExitCode)
        let errors = result
            .Output
            .Split(Environment.NewLine)
            .Where((line string) -> line.Contains("error GS", StringComparison.Ordinal))
            .ToArray()
        Assert.Single(errors)
        Assert.Contains("error GS0100: Not all code paths return a value.", errors[0], StringComparison.Ordinal)
        Assert.False(File.Exists(result.AssemblyPath))
    }

    @Theory
    @MemberData("AcceptedCases")
    func AcceptedLambdasLoadAndRunInChildProcess(name string, expectedOutput string, source string) {
        let result = InvokeCompiler(source, name)
        Assert.Equal(0, result.ExitCode)
        let assembly = EmittedFixture.Load(result.AssemblyPath)
        Assert.NotEmpty(assembly.GetTypes())
        Assert.Equal(expectedOutput, RunBounded(result.AssemblyPath, name))
    }

    @Fact
    func UnknownReturnTypeDoesNotCascadeGs0100() {
        let result = InvokeCompiler(`package Issue2921.UnknownReturnType
var bad (bool) -> MissingType[int32] = (v bool) -> {
    if v { return MissingFunction() }
}`, "UnknownReturnType")
        Assert.Contains("error GS0113:", result.Output, StringComparison.Ordinal)
        Assert.DoesNotContain("error GS0100:", result.Output, StringComparison.Ordinal)
    }

    shared {
        /// Gets lambda bodies with a reachable fall-through path.
        func MissingReturnCases() sequence[[]object] {
            yield Case("SwitchEscape", `package Issue2921.SwitchEscape
func G(f (int32) -> int32) int32 { return f(1) }
func F(x int32) int32 {
    return G(func(v int32) int32 {
        outer: for {
            switch v {
                case 1 { break outer }
                default { return 1 }
            }
        }
    })
}
public var result = F(0)`)
            yield Case("ConditionalFunctionLiteral", `package Issue2921.ConditionalFunctionLiteral
func G(f (int32) -> int32) int32 { return f(1) }
func F() int32 {
    return G(func(v int32) int32 { if v == 0 { return 1 } })
}
public var result = F()`)
            yield Case("InferredArrowLambda", `package Issue2921.InferredArrowLambda
func Use(f (int32) -> int32) { }
Use((v int32) -> { if v == 0 { return 1 } })`)
            yield Case(
                "AsyncFunctionLiteral",
                "package Issue2921.AsyncFunctionLiteral\nlet bad = async func(v int32) int32 { if v == 0 { return 1 } }"
            )
            yield Case("TryFinally", `package Issue2921.TryFinally
func Use(f (int32) -> int32) { }
Use(func(v int32) int32 {
    try { if v == 0 { return 1 } }
    finally { }
})`)
            yield Case("NestedFunctionLiteral", `package Issue2921.NestedFunctionLiteral
let outer = func() (int32) -> int32 {
    return func(v int32) int32 { if v == 0 { return 1 } }
}`)
            yield Case("FixedFunctionLiteral", `package Issue2921.FixedFunctionLiteral
func Use(f () -> int32) { }
func F(xs []int32) {
    Use(func() int32 {
        unsafe {
            fixed p *int32 = xs {
                if xs.Length > 0 { return 1 }
            }
        }
    })
}
F([]int32{})`)
        }

        /// Gets accepted lambda programs and their expected output.
        func AcceptedCases() sequence[[]object] {
            yield Case("OrdinaryShapes", "30\n", `package Issue2921.OrdinaryShapes
import System
import System.Linq
import System.Collections.Generic

let expression = (x int32) -> x + 1
let block = (x int32) -> {
    if x == 0 { return 10 }
    return x + 1
}
let nested = (x int32) -> { return (y int32) -> x + y }

var seen = 0
let action = func(v int32) { seen = v }
action(3)

let nums = List[int32]()
nums.Add(2)
let selected = nums.Select((x) -> { return x * 3 }).Single()
Console.WriteLine(expression(1) + block(0) + nested(4)(5) + selected + seen)`)
            yield Case("TerminatingBodies", "5\n", `package Issue2921.TerminatingBodies
import System

let box = Lazy[string](valueFactory: () -> {
    throw InvalidOperationException("not called")
})
let forever = func() int32 { for { } }

var finalCount = 0
let guarded = func(v int32) int32 {
    try { return v }
    finally { finalCount += 1 }
}
Console.WriteLine(guarded(4) + finalCount)`)
            yield Case("AsyncFunctionLiteral", "3\n", `package Issue2921.AsyncFunctionLiteralGuard
import System

let asyncRead = async func(v int32) int32 { return v + 1 }
Console.WriteLine(asyncRead(2).Result)`)
            yield Case("FixedFunctionLiteral", "3\n", `package Issue2921.FixedFunctionLiteralGuard
import System

func F(xs []int32) int32 {
    let read = func() int32 {
        unsafe {
            fixed p *int32 = xs {
                return xs.Length
            }
        }
    }
    return read()
}
Console.WriteLine(F([]int32{1, 2, 3}))`)
        }

        private func Case(name string, source string)[]object -> []object{name, source}

        private func Case(name string, expectedOutput string, source string)[]object -> []object{
            name,
            expectedOutput,
            source
        }

        private func InvokeCompiler(source string, name string)(ExitCode int32, Output string, AssemblyPath string) {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2921LambdaBodyDefiniteReturnTests", name)
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let assemblyPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            File.Delete(assemblyPath)
            File.Delete(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"))
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
            return (exitCode, stdout.ToString() + stderr.ToString(), assemblyPath)
        }

        private func RunBounded(assemblyPath string, name string) string {
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
                Assert.True(process!!.WaitForExit(5_000), "$name: emitted program did not stop after kill")
            }
            Assert.True(exited, "$name: emitted program timed out")
            let output = outputTask.GetAwaiter().GetResult()
            let error = errorTask.GetAwaiter().GetResult()
            Assert.True(process!!.ExitCode == 0, ("$name" + `: emitted program failed:
` + "$error"))
            return output.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
