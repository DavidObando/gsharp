// <copyright file="Issue3907AsyncLambdaTaskEnvelopeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3907 (issue #1918 parity for function literals): an `async func`
/// may spell its return-type clause as the explicit `Task` /
/// `Task[T]` / `ValueTask` / `ValueTask[T]` wrapper rather than
/// the bare awaited result. `DeclarationBinder` has normalized that form
/// for NAMED functions since #1918; a function LITERAL took the clause
/// literally, so an `async func (…) ValueTask[T] { … return t }` rejected
/// its own body with `GS0155 Cannot convert 'T' to 'ValueTask[T]'` and
/// then handed callers a doubly-wrapped `Task[ValueTask[T]]`.
/// @remarks The migrated `src/Sdk/Gsharp.Runtime.Channels` is where this
/// surfaced: C# `static async ValueTask<T> Awaited(…)` LOCAL
/// functions (`ChannelOps.Awaited.cs`) translate to exactly this shape,
/// and three of the app's remaining error sites were this one defect.
///
/// Witness of discrimination (ADR-0154): the two `Bare` cases below
/// declare the awaited result directly and passed BEFORE the fix, so a mutant
/// that unwraps unconditionally — or one that never unwraps — is caught by the
/// envelope cases alone. The assertions RUN the emitted program and ILVerify
/// it, because the failure mode this guards is a wrong observable delegate
/// return type, which a binding-only assertion cannot see.
open class Issue3907AsyncLambdaTaskEnvelopeTests {
    @Fact
    func AsyncLambda_DeclaringTheTaskEnvelope_BindsRunsAndVerifies() {
        // Each `Envelope*` local declares the wrapper explicitly and returns the
        // awaited result from its body — the C# `async ValueTask<T>` shape.
        // Each `Bare*` local declares the awaited result, the form that already
        // worked, so a mutant cannot pass by treating every clause the same way.
        const source = `
package Demo

import System
import System.Threading.Tasks

async func Main() {
    let EnvelopeValueTask = async func (x int32) ValueTask[int32] {
        await Task.Yield()
        return x * 2
    }

    let EnvelopeTask = async func (x int32) Task[int32] {
        await Task.Yield()
        return x + 5
    }

    let BareResult = async func (x int32) int32 {
        await Task.Yield()
        return x * 10
    }

    let EnvelopeVoid = async func (x int32) ValueTask {
        await Task.Yield()
        Console.WriteLine("void=$x")
    }

    let vt = await EnvelopeValueTask(21)
    Console.WriteLine("vt=$vt")
    let t = await EnvelopeTask(21)
    Console.WriteLine("t=$t")
    let bare = await BareResult(21)
    Console.WriteLine("bare=$bare")
    await EnvelopeVoid(7)
}

await Main()
Console.WriteLine("done")
`
        let lines = CompileVerifyAndRun(source)
        Assert.Contains("vt=42", lines)
        Assert.Contains("t=26", lines)
        Assert.Contains("bare=210", lines)
        Assert.Contains("void=7", lines)
        Assert.Equal("done", lines[^1])
    }

    @Fact
    func AsyncLambda_DeclaringTheEnvelope_IsCallableThroughItsDeclaredType() {
        // The observable delegate return type must be the wrapper the clause
        // asked for, not `Task[ValueTask[T]]`: binding `let v ValueTask[int32] =`
        // against the call is what pins that down, and it is exactly the shape
        // the migrated channels runtime uses (`return Awaited(pending)` from a
        // non-async caller declared `ValueTask[T]`).
        const source = `
package Demo

import System
import System.Threading.Tasks

func Outer(seed int32) ValueTask[int32] {
    let Awaited = async func (x int32) ValueTask[int32] {
        await Task.Yield()
        return x * 3
    }

    return Awaited(seed)
}

async func Main() {
    let outer = await Outer(14)
    Console.WriteLine("outer=$outer")
}

await Main()
Console.WriteLine("done")
`
        let lines = CompileVerifyAndRun(source)
        Assert.Contains("outer=42", lines)
        Assert.Equal("done", lines[^1])
    }

    shared {
        private func CompileVerifyAndRun(source string)[]string {
            let tempDir = Directory.CreateTempSubdirectory("gs_3907_async_lambda_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "Program.gs")
                File.WriteAllText(srcPath, source)
                let outPath = Path.Combine(tempDir, "Program.dll")
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                // Both checks are load-bearing on this effort: an executing test has
                // passed a broken build that only ILVerify caught, and an
                // ILVerify-clean build has produced a wrong runtime answer.
                IlVerifier.Verify(outPath)
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
                using let proc Process? = Process.Start(psi)
                let stdout = proc!!.StandardOutput.ReadToEnd()
                let stderr = proc!!.StandardError.ReadToEnd()
                Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc!!.ExitCode == 0, (`sample exited ` + "${proc!!.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine).Split(
                    Environment.NewLine,
                    StringSplitOptions.RemoveEmptyEntries
                )
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
    }
}
