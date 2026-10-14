// <copyright file="Issue1490MaxStackEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1490 — method bodies were emitted with the default `.maxstack 8`
/// because every `MethodBodyStreamEncoder.AddMethodBody` call omitted the
/// `maxStack` argument. Any body whose evaluation-stack peak exceeds eight
/// (a many-argument call/constructor, a deeply nested arithmetic expression, an
/// async `MoveNext` state machine, …) emitted invalid IL that
/// `ilverify` rejected with `StackOverflow`.
///
/// Each facet below produced a stack peak greater than 8 and failed ilverify on
/// current main; all pass after the fix, which now declares a computed
/// `.maxstack` for every emitted body. The four facets exercise the
/// distinct body-emission paths: a normal method (many-arg `newobj`), a
/// deeply nested arithmetic expression, an `async` method (the
/// `MoveNext` state-machine path) and a constructor body.
open class Issue1490MaxStackEmitTests {
    @Fact
    func EndToEnd_ManyArgumentGuidConstructor_Verifies() {
        let source = `package Probe1490Guid
import System

class Rng1490 {
    var n int32
    init() { n = 0 }
    func Next(bits int32) int64 {
        n = n + bits
        return int64(n)
    }
}

func Main() {
    let r = Rng1490()
    let g = System.Guid(
        uint32(r.Next(32)),
        uint16(r.Next(16)),
        uint16(r.Next(16)),
        uint8(r.Next(8)),
        uint8(r.Next(8)),
        uint8(r.Next(8)),
        uint8(r.Next(8)),
        uint8(r.Next(8)),
        uint8(r.Next(8)),
        uint8(r.Next(8)),
        uint8(r.Next(8)))
    Console.WriteLine(g.ToString().Length)
    Console.WriteLine("ok1490guid")
}`
        let output = CompileAndRun(source)
        Assert.Equal("36${Environment.NewLine}ok1490guid${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_DeeplyNestedArithmeticExpression_Verifies() {
        let source = `package Probe1490Nested
import System

func Deep1490(a int32, b int32, c int32, d int32, e int32, f int32, g int32, h int32) int32 {
    return ((((a + b) * (c + d)) - ((e + f) * (g + h)))
        + ((((a * c) + (b * d)) - ((e * g) + (f * h))))
        + (((a + e) * (b + f)) - ((c + g) * (d + h))))
}

func Main() {
    Console.WriteLine(Deep1490(1, 2, 3, 4, 5, 6, 7, 8))
    Console.WriteLine("ok1490nested")
}`
        let output = CompileAndRun(source)
        Assert.EndsWith("ok1490nested${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_AsyncMethodWithDeepBody_Verifies() {
        let source = `package Probe1490Async
import System
import System.Threading.Tasks

class Acc1490 {
    var n int32
    init() { n = 0 }
    func Next(bits int32) int64 {
        n = n + bits
        return int64(n)
    }
}

class Worker1490 {
    async func BuildAsync() string {
        let a = Acc1490()
        await Task.Delay(1)
        let g = System.Guid(
            uint32(a.Next(32)),
            uint16(a.Next(16)),
            uint16(a.Next(16)),
            uint8(a.Next(8)),
            uint8(a.Next(8)),
            uint8(a.Next(8)),
            uint8(a.Next(8)),
            uint8(a.Next(8)),
            uint8(a.Next(8)),
            uint8(a.Next(8)),
            uint8(a.Next(8)))
        return g.ToString()
    }
}

func Main() {
    let w = Worker1490()
    let t = w.BuildAsync()
    t.Wait()
    Console.WriteLine(t.Result.Length)
    Console.WriteLine("ok1490async")
}`
        let output = CompileAndRun(source)
        Assert.Equal("36${Environment.NewLine}ok1490async${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_ConstructorWithManyArgumentCall_Verifies() {
        let source = `package Probe1490Ctor
import System

class Holder1490 {
    var s string
    init() {
        let g = System.Guid(
            uint32(1),
            uint16(2),
            uint16(3),
            uint8(4),
            uint8(5),
            uint8(6),
            uint8(7),
            uint8(8),
            uint8(9),
            uint8(10),
            uint8(11))
        s = g.ToString()
    }
}

func Main() {
    let h = Holder1490()
    Console.WriteLine(h.s.Length)
    Console.WriteLine("ok1490ctor")
}`
        let output = CompileAndRun(source)
        Assert.Equal("36${Environment.NewLine}ok1490ctor${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1490_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
                IlVerifier.Verify(dllPath)
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
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
                } catch { }
            }
        }
    }
}
