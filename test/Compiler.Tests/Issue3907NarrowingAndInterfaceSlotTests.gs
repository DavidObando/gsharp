// <copyright file="Issue3907NarrowingAndInterfaceSlotTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3907: the last two defects standing between the migrated
/// `src/Sdk/Gsharp.Runtime.Channels` and a clean compile.
/// @remarks <b>Narrowing lost a nested assignment's value.</b>
/// `SelectRandom.Shuffle`'s cache-or-grow idiom is
/// `order = (buffer = new int[…])`; the nested assignment's STATIC type
/// is `buffer`'s declared `[]?int32`, so the outer assignment looked
/// like it stored a nullable and `order` stayed nullable for the rest of
/// the method — while the identical `order = [8]int32` narrowed.
///
/// <b>An inherited interface slot had no emitted handle.</b> ADR-0174's
/// `ISendSelectableCore[T] : ISelectableCore[T]` declares
/// `Deregister` on the BASE; calling it through the derived interface
/// crashed the emitter, because the resolver only ever searched the receiver
/// interface's own definition.
///
/// Both cases COMPILE, ILVERIFY and RUN, and both carry a control that
/// passed before the fix (ADR-0154) — the direct assignment, and a slot the
/// receiver interface declares itself.
open class Issue3907NarrowingAndInterfaceSlotTests {
    @Fact
    func NestedAssignmentValue_NarrowsTheOuterTargetLikeADirectOne() {
        // `Direct` is the control: it narrowed before the fix, so a mutant that
        // narrows nothing fails it, and a mutant that narrows everything is
        // caught by `StillNullable` below.
        const source = `
package Demo

import System

class Cache {
    shared {
        private var buffer []?int32

        func Nested(n int32) int32 {
            var order []?int32 = buffer
            if order == nil || order.Length < n {
                // The cache-or-grow idiom: assign through the field.
                order = (buffer = [Math.Max(n, 8)]int32)
            }
            for var i = 0; i < n; i++ {
                order[i] = i
            }
            var total = 0
            for var i = n - 1; i > 0; i-- {
                let j = i - 1
                // A deconstruction assignment whose TARGETS index the narrowed
                // local: the shape that surfaced this in SelectRandom.gs.
                order[i], order[j] = order[j], order[i]
                total = total + order[i]
            }
            return total + order.Length
        }

        func Direct(n int32) int32 {
            var order []?int32 = buffer
            if order == nil || order.Length < n {
                order = [Math.Max(n, 8)]int32
            }
            return order.Length
        }
    }
}

Console.WriteLine("nested=" + Cache.Nested(4).ToString())
Console.WriteLine("direct=" + Cache.Direct(4).ToString())
Console.WriteLine("done")
`
        let lines = CompileVerifyAndRun(source)
        // 8 is Math.Max(4, 8); the swap sum over 0..3 is 0+1+2 = 3 for the
        // three iterations, so the numbers pin real execution, not just
        // binding.
        Assert.Contains("nested=11", lines)
        Assert.Contains("direct=8", lines)
        Assert.Equal("done", lines[^1])
    }

    @Fact
    func ANullableSlotWithoutTheAssignment_IsStillRejected() {
        // Anti-vacuity guard: the narrowing must come from an assignment that
        // actually stores a non-nil value. Passes both before and after.
        const source = `
package Demo

import System

func Use(order []?int32) int32 {
    return order.Length
}

Console.WriteLine("unreachable")
`
        let log = CompileExpectingFailure(source)
        Assert.Contains("GS0158", log, StringComparison.Ordinal)
    }

    @Fact
    func InheritedGenericInterfaceSlot_EmitsAndDispatches() {
        // `Deregister` is declared on the BASE interface and called through a
        // receiver typed as the DERIVED one — ADR-0174's
        // `ISendSelectableCore[T] : ISelectableCore[T]` shape. `Register` is
        // the control: declared on the derived interface itself, it resolved
        // before the fix, so a mutant that re-parents everything at the base
        // fails it.
        const source = `
package Demo

import System

internal interface IBase[T] {
    func Deregister(node T) string;
}

internal interface IDerived[T] : IBase[T] {
    func Register(node T) string;
}

class Impl[T] : IDerived[T] {
    func Deregister(node T) string -> "dereg:" + node!!.ToString()!!

    func Register(node T) string -> "reg:" + node!!.ToString()!!
}

class Arm[T] {
    let Selectable IDerived[T]

    init(selectable IDerived[T]) {
        Selectable = selectable
    }

    func Go(n T) string {
        let a = Selectable.Register(n)
        let b = Selectable.Deregister(n)
        return a + "|" + b
    }
}

Console.WriteLine("str=" + Arm[string](Impl[string]()).Go("x"))
Console.WriteLine("int=" + Arm[int32](Impl[int32]()).Go(7))
Console.WriteLine("done")
`
        let lines = CompileVerifyAndRun(source)
        // Both slots run, in order, and dispatch to the right implementation.
        Assert.Contains("str=reg:x|dereg:x", lines)
        Assert.Contains("int=reg:7|dereg:7", lines)
        Assert.Equal("done", lines[^1])
    }

    shared {
        private func CompileVerifyAndRun(source string)[]string {
            let tempDir = Directory.CreateTempSubdirectory("gs_3907_narrow_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "Program.gs")
                File.WriteAllText(srcPath, source)
                let outPath = Path.Combine(tempDir, "Program.dll")
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                let (compileExit, compileLog) = RunCompiler(args)
                Assert.True(compileExit == 0, (`gsc failed:
` + "$compileLog"))
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

        private func CompileExpectingFailure(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_3907_narrow_neg_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "Program.gs")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + Path.Combine(tempDir, "Program.dll"),
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath
                }
                let (compileExit, compileLog) = RunCompiler(args)
                Assert.True(compileExit != 0, (`gsc unexpectedly succeeded:
` + "$compileLog"))
                return compileLog
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }

        private func RunCompiler(args List[string])(Exit int32, Log string) {
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                let exit = Program.Main(args.ToArray())
                return (exit, compileOut.ToString() + "\n" + compileErr.ToString())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
        }
    }
}
