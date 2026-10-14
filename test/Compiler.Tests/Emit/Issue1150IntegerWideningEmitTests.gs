// <copyright file="Issue1150IntegerWideningEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1150: end-to-end emit + execution tests proving that implicit,
/// lossless integer widening is applied — and the widening conversion actually
/// emitted — when a typed integer value (including a lambda body) is matched to
/// an expected integer type. Each program compiles via `gsc`, is
/// IL-verified, and runs under `dotnet exec` with its runtime values
/// asserted.
open class Issue1150IntegerWideningEmitTests {
    @Fact
    func SumOverUInt32Selector_WidensToInt64_AndRuns() {
        // The selector returns uint32; it widens to long, selecting
        // Enumerable.Sum(Func<T,long>). Sizes 1,2,3 → Sum == 6 (int64),
        // cast to int32. Proves the int64 overload is selected and the
        // widening conversion is emitted in the lambda body.
        let source = `package main
import System
import System.Collections.Generic
import System.Linq

class Item { var Size uint32 }

func run() {
    let items = List[Item]()
    items.Add(Item() { Size = uint32(1) })
    items.Add(Item() { Size = uint32(2) })
    items.Add(Item() { Size = uint32(3) })
    let total = items.Sum((i Item) -> i.Size)
    Console.WriteLine(total)
    Console.WriteLine(int32(total))
}

run()`
        Assert.Equal("6${Environment.NewLine}6${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func LambdaReturnWidening_UInt16ToInt64_AndRuns() {
        // `(x int32) -> uint16(x)` flows into a Func<int32,int64> parameter;
        // the produced delegate must be created over a method returning int64
        // (the uint16→int64 conversion emitted in the body).
        let source = `package main
import System

func Apply(f Func[int32,int64]) int64 { return f(10) }

func run() {
    Console.WriteLine(Apply((x int32) -> uint16(x)))
}

run()`
        Assert.Equal("10${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func BinaryUInt32PlusInt64_WidensAndRuns() {
        let source = `package main
import System

func F(a uint32, b int64) int64 { return a + b }

func run() {
    Console.WriteLine(F(uint32(5), 10L))
}

run()`
        Assert.Equal("15${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func BinaryUInt8PlusInt32_WidensAndRuns() {
        let source = `package main
import System

func G(a uint8, b int32) int32 { return a + b }

func run() {
    Console.WriteLine(G(uint8(200), 100))
}

run()`
        // 200 + 100 == 300 — proving the uint8 operand widened to int32 (a
        // narrow uint8 add would have wrapped at 256).
        Assert.Equal("300${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1150_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath, nil, Array.Empty[string]())
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch {
                    // ignored

                }
            }
        }
    }
}
