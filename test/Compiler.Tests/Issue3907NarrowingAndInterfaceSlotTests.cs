// <copyright file="Issue3907NarrowingAndInterfaceSlotTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #3907: the last two defects standing between the migrated
/// <c>src/Sdk/Gsharp.Runtime.Channels</c> and a clean compile.
/// </summary>
/// <remarks>
/// <para><b>Narrowing lost a nested assignment's value.</b>
/// <c>SelectRandom.Shuffle</c>'s cache-or-grow idiom is
/// <c>order = (buffer = new int[…])</c>; the nested assignment's STATIC type
/// is <c>buffer</c>'s declared <c>[]?int32</c>, so the outer assignment looked
/// like it stored a nullable and <c>order</c> stayed nullable for the rest of
/// the method — while the identical <c>order = [8]int32</c> narrowed.</para>
/// <para><b>An inherited interface slot had no emitted handle.</b> ADR-0174's
/// <c>ISendSelectableCore[T] : ISelectableCore[T]</c> declares
/// <c>Deregister</c> on the BASE; calling it through the derived interface
/// crashed the emitter, because the resolver only ever searched the receiver
/// interface's own definition.</para>
/// <para>Both cases COMPILE, ILVERIFY and RUN, and both carry a control that
/// passed before the fix (ADR-0154) — the direct assignment, and a slot the
/// receiver interface declares itself.</para>
/// </remarks>
public class Issue3907NarrowingAndInterfaceSlotTests
{
    [Fact]
    public void NestedAssignmentValue_NarrowsTheOuterTargetLikeADirectOne()
    {
        // `Direct` is the control: it narrowed before the fix, so a mutant that
        // narrows nothing fails it, and a mutant that narrows everything is
        // caught by `StillNullable` below.
        const string source = @"
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

Console.WriteLine(""nested="" + Cache.Nested(4).ToString())
Console.WriteLine(""direct="" + Cache.Direct(4).ToString())
Console.WriteLine(""done"")
";

        var lines = CompileVerifyAndRun(source);

        // 8 is Math.Max(4, 8); the swap sum over 0..3 is 0+1+2 = 3 for the
        // three iterations, so the numbers pin real execution, not just
        // binding.
        Assert.Contains("nested=11", lines);
        Assert.Contains("direct=8", lines);
        Assert.Equal("done", lines[^1]);
    }

    [Fact]
    public void ANullableSlotWithoutTheAssignment_IsStillRejected()
    {
        // Anti-vacuity guard: the narrowing must come from an assignment that
        // actually stores a non-nil value. Passes both before and after.
        const string source = @"
package Demo

import System

func Use(order []?int32) int32 {
    return order.Length
}

Console.WriteLine(""unreachable"")
";

        var log = CompileExpectingFailure(source);

        Assert.Contains("GS0158", log, StringComparison.Ordinal);
    }

    [Fact]
    public void InheritedGenericInterfaceSlot_EmitsAndDispatches()
    {
        // `Deregister` is declared on the BASE interface and called through a
        // receiver typed as the DERIVED one — ADR-0174's
        // `ISendSelectableCore[T] : ISelectableCore[T]` shape. `Register` is
        // the control: declared on the derived interface itself, it resolved
        // before the fix, so a mutant that re-parents everything at the base
        // fails it.
        const string source = @"
package Demo

import System

internal interface IBase[T] {
    func Deregister(node T) string;
}

internal interface IDerived[T] : IBase[T] {
    func Register(node T) string;
}

class Impl[T] : IDerived[T] {
    func Deregister(node T) string -> ""dereg:"" + node!!.ToString()!!

    func Register(node T) string -> ""reg:"" + node!!.ToString()!!
}

class Arm[T] {
    let Selectable IDerived[T]

    init(selectable IDerived[T]) {
        Selectable = selectable
    }

    func Go(n T) string {
        let a = Selectable.Register(n)
        let b = Selectable.Deregister(n)
        return a + ""|"" + b
    }
}

Console.WriteLine(""str="" + Arm[string](Impl[string]()).Go(""x""))
Console.WriteLine(""int="" + Arm[int32](Impl[int32]()).Go(7))
Console.WriteLine(""done"")
";

        var lines = CompileVerifyAndRun(source);

        // Both slots run, in order, and dispatch to the right implementation.
        Assert.Contains("str=reg:x|dereg:x", lines);
        Assert.Contains("int=reg:7|dereg:7", lines);
        Assert.Equal("done", lines[^1]);
    }

    private static string[] CompileVerifyAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3907_narrow_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "Program.gs");
            File.WriteAllText(srcPath, source);
            var outPath = Path.Combine(tempDir, "Program.dll");

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            var (compileExit, compileLog) = RunCompiler(args);
            Assert.True(compileExit == 0, $"gsc failed:\n{compileLog}");

            IlVerifier.Verify(outPath);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi);
            var stdout = proc!.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"sample exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout
                .ReplaceLineEndings(Environment.NewLine)
                .Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }

    private static string CompileExpectingFailure(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3907_narrow_neg_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "Program.gs");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + Path.Combine(tempDir, "Program.dll"),
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            var (compileExit, compileLog) = RunCompiler(args);
            Assert.True(compileExit != 0, $"gsc unexpectedly succeeded:\n{compileLog}");
            return compileLog;
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }

    private static (int Exit, string Log) RunCompiler(List<string> args)
    {
        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        try
        {
            var exit = Program.Main(args.ToArray());
            return (exit, compileOut + "\n" + compileErr);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }
    }
}
