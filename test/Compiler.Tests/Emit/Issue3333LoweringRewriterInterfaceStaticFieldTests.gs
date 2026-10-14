// <copyright file="Issue3333LoweringRewriterInterfaceStaticFieldTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3333 — three lowering rewriters override
/// `RewriteFieldAssignmentExpression` and re-introduced the #1644 defect
/// on their own paths: an interface static field write (ADR-0089 / #1030) is
/// built with the `(syntax, field, interfaceType, value)` constructor, and
/// rebuilding it through the variable-receiver constructor silently drops
/// (cref:GSharp.Core.CodeAnalysis.Binding.BoundFieldAssignmentExpression.InterfaceType).
/// The emitter then parents the field reference at the bare open-generic
/// TypeDef instead of a `TypeSpec`, and the interface's `.cctor` is
/// invoked on the uninstantiated type at runtime.
/// - `MoveNextBodyRewriter` — the write appears in an `async` method and the right-hand side mentions a
/// hoisted local, so the node is cloned to carry the rewritten value.
/// - `SpillSequenceSpiller` — the right-hand side is itself an `await`, so the assignment is rebuilt
/// around the spilled value.
/// - `HoistedFieldRewriter` — the write appears in an iterator whose locals are hoisted into
/// state-machine fields.
///
/// Every case uses a <em>generic</em> interface, which is what makes the
/// dropped routing observable: a non-generic interface static field resolves
/// against the TypeDef either way, which is why the existing #1030 and #1644
/// coverage on these same paths does not catch it. Each test writes through two
/// distinct constructions so a regression that collapses them to shared storage
/// also fails.
///
/// Every interface is uniquely named so the process-wide symbol caches
/// cannot alias across tests.
open class Issue3333LoweringRewriterInterfaceStaticFieldTests {
    @Fact
    func AsyncMethod_InterfaceStaticFieldWrite_KeepsPerConstructionStorage() {
        // MoveNextBodyRewriter: `n` is hoisted into a state-machine field, so
        // the assignment is cloned to carry the rewritten right-hand side.
        let source = `package Probe3333a
import System
import System.Threading.Tasks

interface IBoxA3333[T] {
    shared {
        var Count int32 = 0
    }
}

async func BumpAsync(n int32) {
    await Task.Delay(1)
    IBoxA3333[int32].Count = n
    IBoxA3333[string].Count = n + 100
}

func Main() {
    BumpAsync(5).Wait()
    Console.WriteLine(IBoxA3333[int32].Count)
    Console.WriteLine(IBoxA3333[string].Count)
}`
        Assert.Equal(`5
105
`, CompileAndRun(source))
    }

    @Fact
    func AwaitedRightHandSide_InterfaceStaticFieldWrite_KeepsPerConstructionStorage() {
        // SpillSequenceSpiller: the right-hand side contains an await, so
        // SpillFieldAssignment rebuilds the assignment around the spilled value.
        let source = `package Probe3333b
import System
import System.Threading.Tasks

interface IBoxB3333[T] {
    shared {
        var Count int32 = 0
    }
}

async func GetAsync(n int32) int32 {
    await Task.Delay(1)
    return n
}

async func BumpAsync(n int32) {
    IBoxB3333[int32].Count = await GetAsync(n)
    IBoxB3333[string].Count = await GetAsync(n + 100)
}

func Main() {
    BumpAsync(5).Wait()
    Console.WriteLine(IBoxB3333[int32].Count)
    Console.WriteLine(IBoxB3333[string].Count)
}`
        Assert.Equal(`5
105
`, CompileAndRun(source))
    }

    @Fact
    func Iterator_InterfaceStaticFieldWrite_KeepsPerConstructionStorage() {
        // HoistedFieldRewriter: the iterator's locals are hoisted into
        // state-machine fields, which clones the enclosing assignment.
        let source = `package Probe3333c
import System
import System.Collections.Generic

interface IBoxC3333[T] {
    shared {
        var Count int32 = 0
    }
}

func numbers(n int32) IEnumerable[int32] {
    IBoxC3333[int32].Count = n
    yield n
    IBoxC3333[string].Count = n + 100
    yield n + 1
}

func Main() {
    for v in numbers(5) {
        Console.WriteLine(v)
    }

    Console.WriteLine(IBoxC3333[int32].Count)
    Console.WriteLine(IBoxC3333[string].Count)
}`
        Assert.Equal(`5
6
5
105
`, CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_3333_exe_").FullName
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
                return stdout.Replace("\r\n", "\n")
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
