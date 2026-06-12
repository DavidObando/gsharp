// <copyright file="Issue533NullToNullableParameterEmitTests.cs" company="GSharp">
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
/// Issue #533: passing <c>nil</c> to a CLR method/constructor whose parameter
/// is typed as <c>T?</c> (either nullable reference type like <c>string?</c>,
/// or nullable value type like <c>int?</c>) produces GS0130. These tests verify
/// that overload resolution now accepts <c>nil</c> for nullable parameters and
/// that emit produces valid IL (verified via ilverify).
/// </summary>
public class Issue533NullToNullableParameterEmitTests
{
    [Fact]
    public void Nil_To_CLR_Static_Method_StringParam()
    {
        // String.IsNullOrEmpty takes a `string?` parameter (NRT annotation
        // on `string`). Passing nil must succeed.
        var source = """
            package P

            import System

            var result = String.IsNullOrEmpty(nil)
            Console.WriteLine(result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void Nil_To_CLR_Constructor_StringParam()
    {
        // System.Uri constructor takes a `string` parameter. Passing nil
        // should compile and emit valid IL (runtime will throw, but the
        // binder and emitter should produce valid code).
        // Instead, use StringBuilder(string?) which accepts null at runtime.
        var source = """
            package P

            import System
            import System.Text

            var sb = StringBuilder(nil)
            Console.WriteLine(sb.Length)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n", output);
    }

    [Fact]
    public void Nil_To_User_Function_NullableInt_Param()
    {
        // A G# function taking Nullable[int32], called with nil directly.
        var source = """
            package P

            import System

            func check(n Nullable[int32]) {
                Console.WriteLine(n.HasValue)
            }

            check(nil)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\n", output);
    }

    [Fact]
    public void Nil_To_User_Function_NullableString_Param()
    {
        // A G# function taking string?, called with nil directly.
        var source = """
            package P

            import System

            func check(s string?) {
                Console.WriteLine(s == nil)
            }

            check(nil)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void Nil_To_CLR_Class_Constructor_NullableValueType()
    {
        // Pass nil to a G# class constructor that takes an int32? parameter.
        // This exercises the CLR constructor overload resolution path.
        var source = """
            package P

            import System

            class Box {
                var Value int32?

                init(v int32?) {
                    Value = v
                }
            }

            var b = Box(nil)
            Console.WriteLine(b.Value.HasValue)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\n", output);
    }

    [Fact]
    public void Nil_To_CLR_Class_Constructor_NullableRefType()
    {
        // Pass nil to a G# class constructor that takes a string? parameter.
        var source = """
            package P

            import System

            class Wrapper {
                var Text string?

                init(t string?) {
                    Text = t
                }
            }

            var w = Wrapper(nil)
            Console.WriteLine(w.Text == nil)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void Nil_To_CLR_Instance_Method_StringParam()
    {
        // List<string>.Contains takes a `string?` / `string` parameter.
        // Passing nil should compile and emit valid IL.
        var source = """
            package P

            import System
            import System.Collections.Generic

            var xs = List[string]()
            xs.Add("hello")
            var result = xs.Contains(nil)
            Console.WriteLine(result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\n", output);
    }

    [Fact]
    public void Concrete_String_Value_Still_Works()
    {
        // Regression: passing a non-nil string to String.IsNullOrEmpty.
        var source = """
            package P

            import System

            var result = String.IsNullOrEmpty("hello")
            Console.WriteLine(result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\n", output);
    }

    [Fact]
    public void Concrete_NullableInt_Value_Still_Works()
    {
        // Regression: passing a concrete int to a Nullable[int32] parameter.
        var source = """
            package P

            import System

            func check(n Nullable[int32]) {
                Console.WriteLine(n.HasValue)
                Console.WriteLine(n.GetValueOrDefault())
            }

            check(42)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n42\n", output);
    }

    [Fact]
    public void Task_Of_NullableInt_Regression_From_Issue530()
    {
        // Regression guard: the existing Task<int?> path from #530 still works.
        var source = """
            package P

            import System
            import System.Threading.Tasks

            let t = Task.FromResult[int32?](99)
            let r = t.Result
            Console.WriteLine(r)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var (exitCode, stdout, stderr) = CompileAndRunRaw(source);
        Assert.True(
            exitCode == 0,
            $"exited {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_533_").FullName;
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
