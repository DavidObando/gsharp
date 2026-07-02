// <copyright file="Issue1714StringZeroValueEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1714: the interpreter's <c>Evaluator.DefaultValue</c> gives
/// <c>string</c> Go-style value semantics — its zero value is <c>""</c>, not
/// the CLR reference-type default <c>null</c>. Before this fix the emitted
/// IL diverged and produced <c>null</c> for a missing map value, an
/// uninitialized struct/class string field, and an unset <c>string</c>
/// auto-property. These end-to-end tests compile-and-run each scenario and
/// assert the emitted program agrees with the chosen (interpreter) zero-value
/// semantics: <c>""</c>, never <c>nil</c>. Each uses a UNIQUE package/type
/// name because the in-process <c>FunctionTypeSymbol</c> cache is name-keyed.
/// </summary>
public class Issue1714StringZeroValueEmitTests
{
    [Fact]
    public void EndToEnd_MapStringStringMiss_YieldsEmptyString()
    {
        const string source = """
            package i1714mapmiss
            import System

            func Main() {
                var m = map[string,string]{}
                let v = m["missing"]
                System.Console.WriteLine(v == "")
                System.Console.WriteLine(v == nil)
                System.Console.WriteLine("[${v}]")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n[]\n", output);
    }

    [Fact]
    public void EndToEnd_StructStringField_DefaultsToEmptyString()
    {
        const string source = """
            package i1714structfield
            import System

            struct Point { var Label string var X int32 }

            func Main() {
                let p = Point{X: 5}
                System.Console.WriteLine(p.Label == "")
                System.Console.WriteLine(p.Label == nil)
                System.Console.WriteLine(p.X)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n5\n", output);
    }

    [Fact]
    public void EndToEnd_ClassStringField_DefaultsToEmptyString()
    {
        const string source = """
            package i1714classfield
            import System

            class Widget { var Name string }

            func Main() {
                let w = Widget{}
                System.Console.WriteLine(w.Name == "")
                System.Console.WriteLine(w.Name == nil)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
    }

    [Fact]
    public void EndToEnd_ClassStringAutoProperty_DefaultsToEmptyString()
    {
        const string source = """
            package i1714autoprop
            import System

            class Widget { prop Name string { get; set; } }

            func Main() {
                let w = Widget{}
                System.Console.WriteLine(w.Name == "")
                System.Console.WriteLine(w.Name == nil)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
    }

    [Fact]
    public void EndToEnd_DefaultStringExpression_IsEmptyString()
    {
        const string source = """
            package i1714defaultexpr
            import System

            func Main() {
                let s string = default(string)
                System.Console.WriteLine(s == "")
                System.Console.WriteLine(s == nil)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1714_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
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
                $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            IlVerifier.Verify(dllPath);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

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
