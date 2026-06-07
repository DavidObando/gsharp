// <copyright file="Issue530TaskOfNullableMembersEmitTests.cs" company="GSharp">
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
/// Issue #530: <c>Task&lt;T?&gt;.Result</c> (and other members like
/// <c>.GetAwaiter()</c>) fail to bind when the type argument is nullable.
/// These tests exercise both nullable reference types (<c>string?</c>) and
/// nullable value types (<c>int32?</c>), plus a non-nullable regression guard.
/// </summary>
public class Issue530TaskOfNullableMembersEmitTests
{
    [Fact]
    public void Result_On_Task_Of_NullableString_Returns_Value()
    {
        var source = """
            package P

            import System
            import System.Threading.Tasks

            let t = Task.FromResult[string?]("hi")
            let r = t.Result
            Console.WriteLine(r)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hi\n", output);
    }

    [Fact]
    public void GetAwaiter_On_Task_Of_NullableString_Returns_Value()
    {
        var source = """
            package P

            import System
            import System.Threading.Tasks

            let t = Task.FromResult[string?]("hello")
            let awaiter = t.GetAwaiter()
            let r = awaiter.GetResult()
            Console.WriteLine(r)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hello\n", output);
    }

    [Fact]
    public void Result_On_Task_Of_NullableInt32_Returns_Value()
    {
        var source = """
            package P

            import System
            import System.Threading.Tasks

            let t = Task.FromResult[int32?](42)
            let r = t.Result
            Console.WriteLine(r)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void Await_Task_Of_NullableString_Returns_Value()
    {
        var source = """
            package P

            import System
            import System.Threading.Tasks

            async func getVal() string? {
                let t = Task.FromResult[string?]("awaited")
                return await t
            }

            let r = getVal().Result
            Console.WriteLine(r)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("awaited\n", output);
    }

    [Fact]
    public void Await_Task_Of_NullableInt32_Returns_Value()
    {
        var source = """
            package P

            import System
            import System.Threading.Tasks

            async func getVal() int32? {
                let t = Task.FromResult[int32?](99)
                return await t
            }

            let r = getVal().Result
            Console.WriteLine(r)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    [Fact]
    public void Result_On_Task_Of_NonNullableString_Regression()
    {
        // Non-nullable T regression guard — must still work.
        var source = """
            package P

            import System
            import System.Threading.Tasks

            let t = Task.FromResult[string]("world")
            let r = t.Result
            Console.WriteLine(r)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("world\n", output);
    }

    [Fact]
    public void ConfigureAwait_On_Task_Of_NullableString()
    {
        var source = """
            package P

            import System
            import System.Threading.Tasks

            async func getVal() string? {
                let t = Task.FromResult[string?]("configured")
                return await t.ConfigureAwait(false)
            }

            let r = getVal().Result
            Console.WriteLine(r)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("configured\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: true);
        Assert.True(
            exitCode == 0,
            $"exited {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(
        string source,
        bool expectSuccess)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_530_").FullName;
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
