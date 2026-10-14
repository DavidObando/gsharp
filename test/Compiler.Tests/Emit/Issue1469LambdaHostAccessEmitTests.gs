// <copyright file="Issue1469LambdaHostAccessEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1469 — a non-capturing (zero-capture) lambda was hoisted to a static
/// method on the top-level `<Program>` host type. When such a lambda
/// reads a `protected`/`private` member of its parameter's type (a
/// positional member of a `protected` nested data class, or a private
/// backing field), the emitted `ldfld`/`call` falls outside that
/// member's accessibility domain — producing an unverifiable `FieldAccess`
/// IL site and a runtime (cref:FieldAccessException), even though gsc
/// reports zero errors. The fix routes such non-capturing lambdas through a
/// (fieldless) display class nested inside the lexically enclosing user type,
/// matching the #1335 capture-bearing nesting, so the lambda shares the
/// enclosing member's accessibility domain (as C# does with its `<>c`
/// display class).
/// - Facet A — a non-capturing lambda over a positional member of a `protected` nested `data class`
/// (the Oahu.Decrypt `ChunkReader.TrackEntry` shape).
/// - Facet B — a non-capturing lambda reading a `private` backing field of a non-public type.
/// - Facet C — a non-capturing lambda whose enclosing type is GENERIC, locking in that the
/// generic-encloser fallback (top-level static placement) still emits verifiable IL.
open class Issue1469LambdaHostAccessEmitTests {
    @Fact
    func EndToEnd_FacetA_NonCapturingLambdaOverProtectedNestedDataClassMember_Runs() {
        let source = `package Probe1469a
import System
import System.Linq
import System.Collections.Generic

open class ChunkReader1469A {
    protected let entries List[TrackEntry1469A] = List[TrackEntry1469A]()
    func AddOne() {
        entries.Add(TrackEntry1469A(5, 1000))
    }
    func FirstId() uint32 {
        return entries.Select((e TrackEntry1469A) -> e.TrackId).First()
    }
    protected open data class TrackEntry1469A(TrackId uint32, Timescale uint32) {
    }
}

func Main() {
    let r = ChunkReader1469A()
    r.AddOne()
    Console.WriteLine(r.FirstId())
}`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_FacetB_NonCapturingLambdaOverPrivateBackingField_Runs() {
        let source = `package Probe1469b
import System
import System.Linq
import System.Collections.Generic

class Box1469B {
    private let secret int32
    init(s int32) {
        secret = s
    }
    func SumVia() int32 {
        let items = List[Box1469B]()
        items.Add(Box1469B(7))
        items.Add(Box1469B(35))
        return items.Select((b Box1469B) -> b.secret).Sum()
    }
}

func Main() {
    let x = Box1469B(0)
    Console.WriteLine(x.SumVia())
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_FacetC_NonCapturingLambdaInsideGenericEnclosingType_Runs() {
        let source = `package Probe1469c
import System
import System.Linq
import System.Collections.Generic

class GHolder1469C[T] {
    let nums List[int32] = List[int32]()
    func Seed() {
        nums.Add(3)
        nums.Add(4)
    }
    func Doubled() int32 {
        return nums.Select((n int32) -> n * 2).Sum()
    }
}

func Main() {
    let g = GHolder1469C[string]()
    g.Seed()
    Console.WriteLine(g.Doubled())
}`
        let output = CompileAndRun(source)
        Assert.Equal("14${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1469_exe_").FullName
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
