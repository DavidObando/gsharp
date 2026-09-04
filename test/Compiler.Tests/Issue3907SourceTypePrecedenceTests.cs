// <copyright file="Issue3907SourceTypePrecedenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #3907: a SOURCE type declaration outranks an imported one carrying the
/// same fully-qualified name, and an <c>async</c> function whose return clause
/// spells the void-result envelope may use an arrow body over a void call.
/// </summary>
/// <remarks>
/// <para><b>Source beats metadata for a package-qualified name.</b> The
/// dotted-name binder resolved <c>Pkg.Name</c> through a reflection prefix walk
/// BEFORE consulting same-compilation declarations, so whenever the reference
/// set also contained <c>Pkg.Name</c> the metadata type won and the source one
/// was never considered. C# resolves that collision the other way (Roslyn
/// reports <c>CS0436</c> and uses the source type).</para>
/// <para>It bites hardest when an assembly is compiled against a build of
/// ITSELF, which is the normal state for <c>Gsharp.Runtime.Channels</c>: gsc
/// appends the bundled channel runtime to every reference set, so while
/// compiling that runtime's own sources every <c>Gsharp.Concurrency.X</c> in a
/// base clause bound to the PREVIOUS build's <c>X</c>. The single wrong base
/// link on <c>class TaskArm[T] : Gsharp.Concurrency.TaskArm</c> produced three
/// diagnostics at once — <c>GS0214</c> (no accessible two-argument base
/// constructor), <c>GS0185</c> (override does not match the base) and
/// <c>GS0155</c> (<c>TaskArm[T]</c> is not an <c>ArmDescriptor</c>). The BARE
/// spelling was always correct, which is why only the qualified one failed and
/// why the shape did not reproduce until the declaring assembly's name was part
/// of the repro.</para>
/// <para>Both cases RUN. The base-link case is specifically about WHICH type a
/// name denotes: a binding-only assertion cannot tell a correct base link from
/// one that resolves to a different assembly's same-named type and happens to
/// type-check, and a wrong link changes the emitted base-constructor call and
/// vtable slot — so ILVerify runs too.</para>
/// </remarks>
public class Issue3907SourceTypePrecedenceTests
{
    [Fact]
    public void PackageQualifiedBaseName_BindsToTheSourceTypeNotTheImportedHomonym()
    {
        // `Gsharp.Concurrency` + assembly name `Gsharp.Runtime.Channels` is the
        // self-compilation shape: gsc auto-references the bundled channel
        // runtime, which already declares Gsharp.Concurrency.TaskArm and
        // Gsharp.Concurrency.TaskArm`1.
        const string source = @"
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

    protected open func Describe() string -> ""base:"" + Tag
}

internal open class TaskArm[T] : Gsharp.Concurrency.TaskArm {
    internal init(tag string, arm int32) : base(tag, arm) {
    }

    protected open override func Describe() string -> ""derived:"" + Tag + "":"" + Arm.ToString()

    internal func Show() string -> Describe()
}

let arms = System.Collections.Generic.List[ArmDescriptor]()
let derived = TaskArm[int32](""t"", 7)
arms.Add(derived)
Console.WriteLine(derived.Show())
Console.WriteLine(""count="" + arms.Count.ToString())
Console.WriteLine(""isArmDescriptor="" + (arms[0] is ArmDescriptor).ToString())
";

        var lines = CompileVerifyAndRunAs(source, "Gsharp.Runtime.Channels");

        // The base constructor ran (Tag/Arm came through it), the override won
        // over the base's Describe, and the derived type really is an
        // ArmDescriptor — the three things the wrong base link broke.
        Assert.Contains("derived:t:7", lines);
        Assert.Contains("count=1", lines);
        Assert.Contains("isArmDescriptor=True", lines);
    }

    [Fact]
    public void PackageQualifiedName_StillReachesAnImportedTypeWhenSourceDeclaresNoSuchName()
    {
        // Anti-over-reach guard: the new source-first probe must not shadow
        // ordinary qualified CLR names. `System.Text.StringBuilder` has no
        // same-compilation homonym and must keep resolving through the
        // reflection walk.
        const string source = @"
package Demo

import System

class Holder {
    var builder System.Text.StringBuilder = System.Text.StringBuilder()
}

let h = Holder()
h.builder.Append(""ok"")
Console.WriteLine(h.builder.ToString())
Console.WriteLine(""type="" + h.builder.GetType().Name)
";

        var lines = CompileVerifyAndRunAs(source, "Demo");

        Assert.Contains("ok", lines);
        Assert.Contains("type=StringBuilder", lines);
    }

    [Fact]
    public void AsyncFunctionWithVoidResultEnvelope_MayUseAnArrowBodyOverAVoidCall()
    {
        // `public async ValueTask Run<T>(ValueTask<T> body) => Deposit(await …);`
        // — AsyncLetCell.Run's shape. Issue #1918 lets an async function spell
        // its envelope instead of the awaited result; the parser's
        // return-vs-statement choice for an arrow body ran before that
        // normalization and lowered this to `{ return <void expr> }`, which the
        // binder rejected with GS0122 + GS0124. Both neighbouring spellings
        // (`func F() -> voidExpr` and `async func F() -> voidExpr`) were already
        // right.
        const string source = @"
package Demo

import System
import System.Threading.Tasks

class Cell {
    var log string = """"

    async func RunValueTask[T](body ValueTask[T]) ValueTask -> Deposit(""v:"" + (await body).ToString())

    async func RunTask[T](body Task[T]) Task -> Deposit(""t:"" + (await body).ToString())

    async func RunBare() -> Deposit(""bare"")

    func RunSync() -> Deposit(""sync"")

    private func Deposit(entry string) {
        log = log + entry + "";""
    }
}

async func Main() {
    let c = Cell()
    await c.RunValueTask[int32](ValueTask[int32](1))
    await c.RunTask[int32](Task.FromResult(2))
    await c.RunBare()
    c.RunSync()
    Console.WriteLine(""log="" + c.log)
}

Main().GetAwaiter().GetResult()
";

        var lines = CompileVerifyAndRunAs(source, "Demo");

        // Every arrow body ran its void call exactly once, in order — the
        // observable difference between an expression STATEMENT (correct) and a
        // dropped or doubled body.
        Assert.Contains("log=v:1;t:2;bare;sync;", lines);
    }

    private static string[] CompileVerifyAndRunAs(string source, string assemblyName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3907_precedence_").FullName;
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
                "/assemblyname:" + assemblyName,
                srcPath,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

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
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"sample exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout
                .ReplaceLineEndings("\n")
                .Split('\n', StringSplitOptions.RemoveEmptyEntries);
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
}
