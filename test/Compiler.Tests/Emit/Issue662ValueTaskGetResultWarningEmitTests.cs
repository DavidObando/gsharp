// <copyright file="Issue662ValueTaskGetResultWarningEmitTests.cs" company="GSharp">
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
/// Issue #662: end-to-end emit test asserting that the compiler produces
/// warning GS0275 when <c>.GetAwaiter().GetResult()</c> is called directly
/// on a <c>ValueTask</c>/<c>ValueTask&lt;T&gt;</c>.
/// </summary>
public class Issue662ValueTaskGetResultWarningEmitTests
{
    [Fact]
    public void Compiler_Emits_GS0275_Warning_For_ValueTask_GetResult()
    {
        var source = """
            package P

            import System
            import System.Threading.Tasks

            let vt = ValueTask[bool](true)
            let r = vt.GetAwaiter().GetResult()
            Console.WriteLine(r)
            """;

        var (exitCode, stdout, stderr) = CompileAndRunRaw(source);
        Assert.True(exitCode == 0, $"exited {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        Assert.Equal("True\n", stdout);
    }

    [Fact]
    public void Compiler_Output_Contains_GS0275_Warning_Text()
    {
        var source = """
            package P

            import System
            import System.Threading.Tasks

            let vt = ValueTask[bool](true)
            let r = vt.GetAwaiter().GetResult()
            Console.WriteLine(r)
            """;

        var compilerOutput = CompileOnly(source);
        Assert.Contains("GS0275", compilerOutput);
        Assert.Contains("warning", compilerOutput);
        Assert.Contains("AsTask", compilerOutput);
    }

    [Fact]
    public void Compiler_Does_Not_Emit_GS0275_For_AsTask_Pattern()
    {
        var source = """
            package P

            import System
            import System.Threading.Tasks

            let vt = ValueTask[bool](true)
            let r = vt.AsTask().GetAwaiter().GetResult()
            Console.WriteLine(r)
            """;

        var compilerOutput = CompileOnly(source);
        Assert.DoesNotContain("GS0275", compilerOutput);
    }

    [Fact]
    public void Compiler_Does_Not_Emit_GS0275_For_Task_GetResult()
    {
        var source = """
            package P

            import System
            import System.Threading.Tasks

            let t = Task.FromResult(42)
            let r = t.GetAwaiter().GetResult()
            Console.WriteLine(r)
            """;

        var compilerOutput = CompileOnly(source);
        Assert.DoesNotContain("GS0275", compilerOutput);
    }

    /// <summary>
    /// Compiles and runs the given source; returns exit code + output.
    /// </summary>
    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_662_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = BuildCompilerArgs(outPath, srcPath);

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

            // GS0275 is a warning, so compilation should succeed.
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

    /// <summary>
    /// Compiles only (no run), captures compiler stdout which includes diagnostics.
    /// </summary>
    private static string CompileOnly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_662c_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = BuildCompilerArgs(outPath, srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            try
            {
                Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            return compileOut.ToString();
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static List<string> BuildCompilerArgs(string outPath, string srcPath)
    {
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
        return args;
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
