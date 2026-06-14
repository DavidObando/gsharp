// <copyright file="Issue818VariadicAnonymousFunctionTypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #818 — emit / IL-verification coverage for variadic parameters in
/// anonymous function-type clauses <c>(T1, ...T2) -&gt; R</c>.
/// ADR-0102 follow-up: ensures the indirect-call site through a variable
/// typed as an anonymous variadic function-type packs trailing arguments
/// into a slice, accepts a pre-built slice (pass-through), and IL-verifies.
/// </summary>
public class Issue818VariadicAnonymousFunctionTypeEmitTests
{
    [Fact]
    public void AnonymousVariadicLocal_AutoPacks_TrailingArgs()
    {
        var source = """
            package P
            import System

            let f (int32, ...string) -> int32 = (a, args) -> a + args.Length

            Console.WriteLine(f(1, "a", "b", "c"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("4\n", output);
    }

    [Fact]
    public void AnonymousVariadicLocal_PassThroughSlice()
    {
        var source = """
            package P
            import System

            let f (int32, ...string) -> int32 = (a, args) -> a + args.Length

            Console.WriteLine(f(10, []string{"x", "y"}))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("12\n", output);
    }

    [Fact]
    public void AnonymousVariadicLocal_EmptyTrailing_ProducesEmptySlice()
    {
        var source = """
            package P
            import System

            let f (int32, ...string) -> int32 = (a, args) -> a + args.Length

            Console.WriteLine(f(7))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void AnonymousVariadicLocal_NoFixed_PacksAllArgs()
    {
        var source = """
            package P
            import System

            let g (...int32) -> int32 = (xs) -> xs.Length

            Console.WriteLine(g(1, 2, 3, 4, 5))
            Console.WriteLine(g())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n0\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue818_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
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
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
