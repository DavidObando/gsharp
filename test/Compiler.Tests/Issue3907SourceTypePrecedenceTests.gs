// <copyright file="Issue3907SourceTypePrecedenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3907: a SOURCE type declaration outranks an imported one carrying the
/// same fully-qualified name, and an `async` function whose return clause
/// spells the void-result envelope may use an arrow body over a void call.
/// @remarks <b>Source beats metadata for a package-qualified name.</b> The
/// dotted-name binder resolved `Pkg.Name` through a reflection prefix walk
/// BEFORE consulting same-compilation declarations, so whenever the reference
/// set also contained `Pkg.Name` the metadata type won and the source one
/// was never considered. C# resolves that collision the other way (Roslyn
/// reports `CS0436` and uses the source type).
///
/// It bites hardest when an assembly is compiled against a build of
/// ITSELF, which is the normal state for `Gsharp.Runtime.Channels`: gsc
/// appends the bundled channel runtime to every reference set, so while
/// compiling that runtime's own sources every `Gsharp.Concurrency.X` in a
/// base clause bound to the PREVIOUS build's `X`. The single wrong base
/// link on `class TaskArm[T] : Gsharp.Concurrency.TaskArm` produced three
/// diagnostics at once — `GS0214` (no accessible two-argument base
/// constructor), `GS0185` (override does not match the base) and
/// `GS0155` (`TaskArm[T]` is not an `ArmDescriptor`). The BARE
/// spelling was always correct, which is why only the qualified one failed and
/// why the shape did not reproduce until the declaring assembly's name was part
/// of the repro.
///
/// Both cases RUN. The base-link case is specifically about WHICH type a
/// name denotes: a binding-only assertion cannot tell a correct base link from
/// one that resolves to a different assembly's same-named type and happens to
/// type-check, and a wrong link changes the emitted base-constructor call and
/// vtable slot — so ILVerify runs too.
open class Issue3907SourceTypePrecedenceTests {
    @Fact
    func PackageQualifiedBaseName_BindsToTheSourceTypeNotTheImportedHomonym() {
        // `Gsharp.Concurrency` + assembly name `Gsharp.Runtime.Channels` is the
        // self-compilation shape: gsc auto-references the bundled channel
        // runtime, which already declares Gsharp.Concurrency.TaskArm and
        // Gsharp.Concurrency.TaskArm`1.
        const source = `
package Gsharp.Concurrency

import System

internal open class ArmDescriptor {
    protected init(arm int32) {
        Arm = arm
    }

    internal prop Arm int32 {
        get;
        private set;
    }
}

internal open class TaskArm : ArmDescriptor {
    internal init(tag string, arm int32) : base(arm) {
        Tag = tag
    }

    internal prop Tag string {
        get;
        private set;
    }

    protected open func Describe() string -> "base:" + Tag
}

internal open class TaskArm[T] : Gsharp.Concurrency.TaskArm {
    internal init(tag string, arm int32) : base(tag, arm) {
    }

    protected open override func Describe() string -> "derived:" + Tag + ":" + Arm.ToString()

    internal func Show() string -> Describe()
}

let arms = System.Collections.Generic.List[ArmDescriptor]()
let derived = TaskArm[int32]("t", 7)
arms.Add(derived)
Console.WriteLine(derived.Show())
Console.WriteLine("count=" + arms.Count.ToString())
Console.WriteLine("isArmDescriptor=" + (arms[0] is ArmDescriptor).ToString())
`
        let lines = CompileVerifyAndRunAs(source, "Gsharp.Runtime.Channels")
        // The base constructor ran (Tag/Arm came through it), the override won
        // over the base's Describe, and the derived type really is an
        // ArmDescriptor — the three things the wrong base link broke.
        Assert.Contains("derived:t:7", lines)
        Assert.Contains("count=1", lines)
        Assert.Contains("isArmDescriptor=True", lines)
    }

    @Fact
    func PackageQualifiedName_StillReachesAnImportedTypeWhenSourceDeclaresNoSuchName() {
        // Anti-over-reach guard: the new source-first probe must not shadow
        // ordinary qualified CLR names. `System.Text.StringBuilder` has no
        // same-compilation homonym and must keep resolving through the
        // reflection walk.
        const source = `
package Demo

import System

class Holder {
    var builder System.Text.StringBuilder = System.Text.StringBuilder()
}

let h = Holder()
h.builder.Append("ok")
Console.WriteLine(h.builder.ToString())
Console.WriteLine("type=" + h.builder.GetType().Name)
`
        let lines = CompileVerifyAndRunAs(source, "Demo")
        Assert.Contains("ok", lines)
        Assert.Contains("type=StringBuilder", lines)
    }

    @Fact
    func AsyncFunctionWithVoidResultEnvelope_MayUseAnArrowBodyOverAVoidCall() {
        // `public async ValueTask Run<T>(ValueTask<T> body) => Deposit(await …);`
        // — AsyncLetCell.Run's shape. Issue #1918 lets an async function spell
        // its envelope instead of the awaited result; the parser's
        // return-vs-statement choice for an arrow body ran before that
        // normalization and lowered this to `{ return <void expr> }`, which the
        // binder rejected with GS0122 + GS0124. Both neighbouring spellings
        // (`func F() -> voidExpr` and `async func F() -> voidExpr`) were already
        // right.
        const source = `
package Demo

import System
import System.Threading.Tasks

class Cell {
    var log string = ""

    async func RunValueTask[T](body ValueTask[T]) ValueTask -> Deposit("v:" + (await body).ToString())

    async func RunTask[T](body Task[T]) Task -> Deposit("t:" + (await body).ToString())

    async func RunBare() -> Deposit("bare")

    func RunSync() -> Deposit("sync")

    private func Deposit(entry string) {
        log = log + entry + ";"
    }
}

async func Main() {
    let c = Cell()
    await c.RunValueTask[int32](ValueTask[int32](1))
    await c.RunTask[int32](Task.FromResult(2))
    await c.RunBare()
    c.RunSync()
    Console.WriteLine("log=" + c.log)
}

Main().GetAwaiter().GetResult()
`
        let lines = CompileVerifyAndRunAs(source, "Demo")
        // Every arrow body ran its void call exactly once, in order — the
        // observable difference between an expression STATEMENT (correct) and a
        // dropped or doubled body.
        Assert.Contains("log=v:1;t:2;bare;sync;", lines)
    }

    shared {
        private func CompileVerifyAndRunAs(source string, assemblyName string)[]string {
            let tempDir = Directory.CreateTempSubdirectory("gs_3907_precedence_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "Program.gs")
                File.WriteAllText(srcPath, source)
                let outPath = Path.Combine(tempDir, "Program.dll")
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/assemblyname:" + assemblyName,
                    srcPath
                }
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
                return stdout.ReplaceLineEndings("\n").Split('\n', StringSplitOptions.RemoveEmptyEntries)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
    }
}
