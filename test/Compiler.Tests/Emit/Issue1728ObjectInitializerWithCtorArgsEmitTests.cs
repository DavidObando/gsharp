// <copyright file="Issue1728ObjectInitializerWithCtorArgsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1728 — a G# construction combining constructor arguments with a
/// trailing property-initializer suffix (<c>Target(args) { Name = value }</c>,
/// gsc issue #522) must actually run and set BOTH the constructor-assigned
/// member AND every suffix-assigned member. This is the native G# form cs2gs
/// now emits for a C# <c>new Foo(x) { Bar = 2 }</c> (see
/// <c>Cs2Gs.Tests.Issue1728ObjectInitializerWithCtorArgsTranslationTests</c>
/// for the translator-fidelity side); this file proves the emitted form is
/// not just syntactically valid but semantically correct at runtime. Each
/// test uses a UNIQUE package/type name (Emit-suite convention).
/// </summary>
public class Issue1728ObjectInitializerWithCtorArgsEmitTests
{
    [Fact]
    public void CtorArgPlusSingleMemberInitializer_SetsBothMembers()
    {
        const string source = """
            package i1728single
            import System

            class Foo {
                prop X int32 { get; init; }
                prop Bar int32 { get; set; }
                init(x int32) { X = x }
            }

            func Main() {
                let f = Foo(10) { Bar = 2 }
                System.Console.WriteLine(f.X)
                System.Console.WriteLine(f.Bar)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("10\n2\n", output);
    }

    [Fact]
    public void CtorArgPlusMultiMemberInitializer_SetsAllMembers()
    {
        const string source = """
            package i1728multi
            import System

            class Foo {
                prop X int32 { get; init; }
                prop Bar int32 { get; set; }
                prop Baz string { get; set; }
                init(x int32) { X = x }
            }

            func Main() {
                let f = Foo(10) { Bar = 2, Baz = "hi" }
                System.Console.WriteLine(f.X)
                System.Console.WriteLine(f.Bar)
                System.Console.WriteLine(f.Baz)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("10\n2\nhi\n", output);
    }

    [Fact]
    public void CtorArgPlusMemberInitializer_UsedAsArgumentExpression_Runs()
    {
        // The construction-with-initializer-suffix form must compose at any
        // expression position, not just a `let`/`var` initializer.
        const string source = """
            package i1728argpos
            import System

            class Foo {
                prop X int32 { get; init; }
                prop Bar int32 { get; set; }
                init(x int32) { X = x }
            }

            func Show(f Foo) { System.Console.WriteLine(f.X + f.Bar) }

            func Main() { Show(Foo(10) { Bar = 2 }) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("12\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1728_exe_").FullName;
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
