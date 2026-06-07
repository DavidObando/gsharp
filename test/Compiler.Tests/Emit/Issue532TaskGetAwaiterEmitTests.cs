// <copyright file="Issue532TaskGetAwaiterEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #532: <c>Task&lt;T&gt;.GetAwaiter()</c> was rejected as ambiguous (GS0160)
/// between the inherited <c>Task.GetAwaiter()</c> and <c>Task&lt;T&gt;.GetAwaiter()</c>.
/// Resolved as a side effect of #530's most-derived-declaring-type filter (Phase 2d)
/// in overload resolution. These tests lock in the fix as regression coverage.
/// </summary>
public class Issue532TaskGetAwaiterEmitTests
{
    [Fact]
    public void GetAwaiter_GetResult_On_Task_Of_Int_Returns_Value()
    {
        var source = """
            package P

            import System
            import System.Threading.Tasks

            let t = Task.FromResult(42)
            let r = t.GetAwaiter().GetResult()
            Console.WriteLine(r)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void GetAwaiter_GetResult_On_Task_Of_String_Returns_Value()
    {
        var source = """
            package P

            import System
            import System.Threading.Tasks

            let t = Task.FromResult("hi")
            let r = t.GetAwaiter().GetResult()
            Console.WriteLine(r)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hi\n", output);
    }

    [Fact]
    public void GetAwaiter_IsCompleted_On_Task_Of_String_Returns_True()
    {
        var source = """
            package P

            import System
            import System.Threading.Tasks

            let t = Task.FromResult("hi")
            let awaiter = t.GetAwaiter()
            let c = awaiter.IsCompleted
            Console.WriteLine(c)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void GetAwaiter_GetResult_On_NonGeneric_Task_Succeeds()
    {
        var source = """
            package P

            import System
            import System.Threading.Tasks

            let t = Task.CompletedTask
            t.GetAwaiter().GetResult()
            Console.WriteLine("ok")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("ok\n", output);
    }

    [Fact]
    public void GetAwaiter_GetResult_On_Explicit_Task_Of_Int_Parameter()
    {
        var source = """
            package P

            import System
            import System.Threading.Tasks

            func run(t Task[int32]) int32 {
                return t.GetAwaiter().GetResult()
            }

            let result = run(Task.FromResult(99))
            Console.WriteLine(result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    [Fact]
    public void Assert_Equal_Still_Works_Regression_Guard()
    {
        // Regression guard for issue #505 — Assert.Equal ambiguity must not regress.
        var source = """
            package P

            import System
            import System.Threading.Tasks

            let t = Task.FromResult(42)
            let r = t.GetAwaiter().GetResult()
            if r == 42 {
                Console.WriteLine("pass")
            } else {
                Console.WriteLine("fail")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("pass\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var (exitCode, stdout, stderr) = CompileAndRunRaw(source);
        Assert.True(
            exitCode == 0,
            $"exited {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(
        string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_532_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };

            foreach (var bcl in BclReferences.Value)
            {
                args.Add("/r:" + bcl);
            }

            args.Add(srcPath);

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

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            return (proc.ExitCode, stdout.Replace("\r\n", "\n"), stderr.Replace("\r\n", "\n"));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(() =>
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir))
        {
            return Array.Empty<string>();
        }

        return Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
            .Where(p =>
            {
                var name = Path.GetFileName(p);
                return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "mscorlib.dll", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase);
            })
            .ToList();
    });
}
