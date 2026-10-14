// <copyright file="Issue4580CapturingRefReturningLocalFunctionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #4580: a CAPTURING ref-returning local function literal is emitted
/// as the `Invoke` method of a synthesized closure class. That method
/// used to be declared by-value (`int32 Invoke(...)`) while its body
/// returned a managed pointer (`ldelema; ret`) and every call site
/// stored the result as one, so the program crashed with an
/// AccessViolationException at run time. Each case compiles, ILVerifies and
/// RUNS the program, asserting stdout byte-for-byte.
class Issue4580CapturingRefReturningLocalFunctionTests {
    @Fact
    func ReportedShape_CapturedLocalArrayInClassMethod_WritesThroughAlias() {
        const Source = `package Repro

class C {
    func Run() int32 {
        var data = []int32{10}
        let At = func (index int32) ref int32 {
            return ref data[index]
        }
        var ref alias = At(0)
        alias = 42
        return data[0]
    }
}

Console.WriteLine(C().Run())`
        Assert.Equal("42" + Environment.NewLine, CompileVerifyAndRun(Source))
    }

    @Fact
    func CapturedLocal_InTopLevelFunction_WritesThroughAliasAndCallStorage() {
        const Source = `package Issue4580Local

func Run() string {
    var data = []int32{1, 2, 3}
    let At = func (index int32) ref int32 {
        return ref data[index]
    }
    var ref alias = At(0)
    alias = 40
    At(2) = At(1) + 5
    return "${data[0]},${data[1]},${data[2]}"
}

Console.WriteLine(Run())`
        Assert.Equal("40,2,7" + Environment.NewLine, CompileVerifyAndRun(Source))
    }

    @Fact
    func CapturedParameter_WritesThroughAlias() {
        const Source = `package Issue4580Parameter

func Run(data []int32) int32 {
    let At = func (index int32) ref int32 {
        return ref data[index]
    }
    var ref alias = At(1)
    alias = 7
    return data[1] * 10 + data[0]
}

Console.WriteLine(Run([]int32{1, 2}))`
        Assert.Equal("71" + Environment.NewLine, CompileVerifyAndRun(Source))
    }

    @Fact
    func CapturedThisField_OfClass_WritesThroughAlias() {
        const Source = `package Issue4580This

class Counter {
    var hits int32
    func Bump() int32 {
        let Slot = func () ref int32 {
            return ref this.hits
        }
        var ref h = Slot()
        h = h + 5
        Slot() = Slot() + 1
        return this.hits
    }
}

let c = Counter()
Console.WriteLine(c.Bump())
Console.WriteLine(c.Bump())`
        Assert.Equal("6" + Environment.NewLine + "12" + Environment.NewLine, CompileVerifyAndRun(Source))
    }

    @Fact
    func NestedLiterals_InnerRefReturningLiteralCapturesOuterLocal() {
        const Source = `package Issue4580Nested

class C {
    func Run() string {
        var data = []int32{1, 2, 3}
        let Outer = func (k int32) int32 {
            let Inner = func (index int32) ref int32 {
                return ref data[index]
            }
            var ref a = Inner(k)
            a = a * 10
            return Inner(k)
        }
        let r = Outer(2)
        return "${data[0]},${data[1]},${data[2]};${r}"
    }
}

Console.WriteLine(C().Run())`
        Assert.Equal("1,2,30;30" + Environment.NewLine, CompileVerifyAndRun(Source))
    }

    @Fact
    func RefReadOnlyReturn_CapturedLocal_ObservesLaterWrites() {
        const Source = `package Issue4580ReadOnly

class C {
    func Run() int32 {
        var data = []int32{10, 20}
        let View = func (index int32) ref readonly int32 {
            return ref data[index]
        }
        let ref readonly v = View(1)
        data[1] = 99
        return v + View(0)
    }
}

Console.WriteLine(C().Run())`
        Assert.Equal("109" + Environment.NewLine, CompileVerifyAndRun(Source))
    }

    @Fact
    func StructEncloser_CaptureFreeAndCapturingLiterals_WriteThroughAlias() {
        // The capturing literal is emitted as a `<closure_*>` Invoke method
        // nested in the struct, and is the half this test discriminates on.
        // The capture-free literal is a control: it is hosted on
        // `<local_host_*>` as the literal's own function symbol, which
        // already carried the by-ref return before #4580.
        const Source = `package Issue4580Struct

struct Holder {
    var n int32
    func Run(data []int32) int32 {
        let At = func (xs []int32, index int32) ref int32 {
            return ref xs[index]
        }
        var ref a = At(data, 0)
        a = 31
        return data[0]
    }
    func RunCapturing(data []int32) int32 {
        let At = func (index int32) ref int32 {
            return ref data[index]
        }
        var ref a = At(0)
        a = 32
        return data[0]
    }
}

var h = Holder{}
Console.WriteLine(h.Run([]int32{1}))
Console.WriteLine(h.RunCapturing([]int32{1}))`
        Assert.Equal("31" + Environment.NewLine + "32" + Environment.NewLine, CompileVerifyAndRun(Source))
    }

    shared {
        private func CompileVerifyAndRun(source string) string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue4580CapturingRefReturningLocalFunctionTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            try {
                let sourcePath = Path.Combine(directory, "Program.gs")
                let outputPath = Path.Combine(directory, "Issue4580.dll")
                File.WriteAllText(sourcePath, source)
                let arguments = List[string]{
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    sourcePath
                }
                using let stdout = StringWriter()
                using let stderr = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(stdout)
                Console.SetError(stderr)
                var exitCode int32
                try {
                    exitCode = Program.Main(arguments.ToArray())
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, "gsc failed:${Environment.NewLine}$stdout$stderr")
                IlVerifier.Verify(outputPath)
                using let process Process? = Process.Start(
                    ProcessStartInfo("dotnet"){
                        ArgumentList = {
                            "exec",
                            "--runtimeconfig",
                            Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                            outputPath
                        },
                        WorkingDirectory = directory,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false
                    }
                )
                Assert.NotNull(process)
                let output = process!!.StandardOutput.ReadToEndAsync()
                let error = process!!.StandardError.ReadToEndAsync()
                Assert.True(process!!.WaitForExit(30_000), "dotnet exec timed out")
                let errorText = error.GetAwaiter().GetResult()
                Assert.True(process!!.ExitCode == 0, "exited ${process!!.ExitCode}:${Environment.NewLine}$errorText")
                return output.GetAwaiter().GetResult().ReplaceLineEndings(Environment.NewLine)
            } finally {
                // Best-effort cleanup: a transiently locked file must not turn a
                // passing run red or mask the original assertion failure.
                try {
                    Directory.Delete(directory, recursive: true)
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
    }
}
