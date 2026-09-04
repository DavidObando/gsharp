// <copyright file="Issue3907AsyncLambdaTaskEnvelopeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #3907 (issue #1918 parity for function literals): an <c>async func</c>
/// may spell its return-type clause as the explicit <c>Task</c> /
/// <c>Task[T]</c> / <c>ValueTask</c> / <c>ValueTask[T]</c> wrapper rather than
/// the bare awaited result. <c>DeclarationBinder</c> has normalized that form
/// for NAMED functions since #1918; a function LITERAL took the clause
/// literally, so an <c>async func (…) ValueTask[T] { … return t }</c> rejected
/// its own body with <c>GS0155 Cannot convert 'T' to 'ValueTask[T]'</c> and
/// then handed callers a doubly-wrapped <c>Task[ValueTask[T]]</c>.
/// </summary>
/// <remarks>
/// <para>The migrated <c>src/Sdk/Gsharp.Runtime.Channels</c> is where this
/// surfaced: C# <c>static async ValueTask&lt;T&gt; Awaited(…)</c> LOCAL
/// functions (<c>ChannelOps.Awaited.cs</c>) translate to exactly this shape,
/// and three of the app's remaining error sites were this one defect.</para>
/// <para>Witness of discrimination (ADR-0154): the two <c>Bare</c> cases below
/// declare the awaited result directly and passed BEFORE the fix, so a mutant
/// that unwraps unconditionally — or one that never unwraps — is caught by the
/// envelope cases alone. The assertions RUN the emitted program and ILVerify
/// it, because the failure mode this guards is a wrong observable delegate
/// return type, which a binding-only assertion cannot see.</para>
/// </remarks>
public class Issue3907AsyncLambdaTaskEnvelopeTests
{
    [Fact]
    public void AsyncLambda_DeclaringTheTaskEnvelope_BindsRunsAndVerifies()
    {
        // Each `Envelope*` local declares the wrapper explicitly and returns the
        // awaited result from its body — the C# `async ValueTask<T>` shape.
        // Each `Bare*` local declares the awaited result, the form that already
        // worked, so a mutant cannot pass by treating every clause the same way.
        const string source = @"
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
        Console.WriteLine(""void=$x"")
    }

    let vt = await EnvelopeValueTask(21)
    Console.WriteLine(""vt=$vt"")
    let t = await EnvelopeTask(21)
    Console.WriteLine(""t=$t"")
    let bare = await BareResult(21)
    Console.WriteLine(""bare=$bare"")
    await EnvelopeVoid(7)
}

await Main()
Console.WriteLine(""done"")
";

        var lines = CompileVerifyAndRun(source);

        Assert.Contains("vt=42", lines);
        Assert.Contains("t=26", lines);
        Assert.Contains("bare=210", lines);
        Assert.Contains("void=7", lines);
        Assert.Equal("done", lines[^1]);
    }

    [Fact]
    public void AsyncLambda_DeclaringTheEnvelope_IsCallableThroughItsDeclaredType()
    {
        // The observable delegate return type must be the wrapper the clause
        // asked for, not `Task[ValueTask[T]]`: binding `let v ValueTask[int32] =`
        // against the call is what pins that down, and it is exactly the shape
        // the migrated channels runtime uses (`return Awaited(pending)` from a
        // non-async caller declared `ValueTask[T]`).
        const string source = @"
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
    Console.WriteLine(""outer=$outer"")
}

await Main()
Console.WriteLine(""done"")
";

        var lines = CompileVerifyAndRun(source);

        Assert.Contains("outer=42", lines);
        Assert.Equal("done", lines[^1]);
    }

    private static string[] CompileVerifyAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3907_async_lambda_").FullName;
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

            // Both checks are load-bearing on this effort: an executing test has
            // passed a broken build that only ILVerify caught, and an
            // ILVerify-clean build has produced a wrong runtime answer.
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
}
