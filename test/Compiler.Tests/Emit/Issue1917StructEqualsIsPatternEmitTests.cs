// <copyright file="Issue1917StructEqualsIsPatternEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1917: a struct method shadowing <c>object.Equals(object)</c> whose
/// body narrows the parameter with an <c>is</c> type-test
/// (<c>obj is Money &amp;&amp; Cents == obj.Cents</c>, ADR-0069 smart-cast) emitted
/// IL that ilverify rejects with <c>StackUnexpected: [found address of
/// 'object'][expected readonly address of 'Money']</c>. The struct's field
/// access on the narrowed parameter re-loaded the ORIGINAL <c>object</c>-typed
/// argument slot's address instead of unboxing/narrowing it to the pattern's
/// target type first, so the CLR JIT tolerated the mismatched stack shape but
/// ilverify's stricter typed-stack model did not.
/// </summary>
public class Issue1917StructEqualsIsPatternEmitTests
{
    [Fact]
    public void StructEqualsOverride_IsPatternSmartCastFieldAccess_RunsAndIlVerifies()
    {
        var source = """
            package P
            import System

            struct Money {
                var Cents int32
                func Equals(obj object?) bool {
                    return obj is Money && Cents == obj.Cents
                }
            }

            var a = Money{ Cents: 100 }
            var b = Money{ Cents: 100 }
            var c = Money{ Cents: 200 }
            var oa object = a
            Console.WriteLine(oa.Equals(b))
            Console.WriteLine(oa.Equals(c))
            Console.WriteLine(oa.Equals("not money"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\nFalse\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1917_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
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
                compileExit = Program.Main(args);
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

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
