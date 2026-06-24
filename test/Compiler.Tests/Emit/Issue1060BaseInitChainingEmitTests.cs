// <copyright file="Issue1060BaseInitChainingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1060: end-to-end CLR emit + ilverify coverage for a derived class
/// constructor initializer (<c>init(...) : base(args)</c>) chaining to a base
/// class's explicit <c>init(...)</c> member constructors (rather than only a
/// primary constructor). Validates that the resolved base constructor is the
/// one actually invoked in emitted CIL (the <c>call instance void
/// Base::.ctor(...)</c> targets the selected overload), that overload selection
/// among multiple explicit base inits is by argument types, and that the
/// pre-existing primary-ctor and CLR-base chaining paths are not regressed.
/// </summary>
public class Issue1060BaseInitChainingEmitTests
{
    [Fact]
    public void EndToEnd_ChainToSingleExplicitBaseInit_RunsBaseCtorAndSetsField()
    {
        var source = """
            package p
            open class A {
                var X int32
                init(x int32) { X = x }
            }
            class B : A {
                init(x int32) : base(x) { }
            }
            func Main() {
                var b = B(7)
                System.Console.WriteLine(b.X)
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void EndToEnd_SelectsAmongMultipleExplicitBaseInitsByArgCount()
    {
        var source = """
            package p
            open class A {
                var Tag string
                init(x int32) { Tag = "one" }
                init(x int32, y int32) { Tag = "two" }
            }
            class B : A {
                init() : base(1, 2) { }
            }
            func Main() {
                var b = B()
                System.Console.WriteLine(b.Tag)
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("two\n", output);
    }

    [Fact]
    public void EndToEnd_SelectsAmongMultipleExplicitBaseInitsByArgType()
    {
        var source = """
            package p
            open class A {
                var Tag string
                init(x int32) { Tag = "int" }
                init(s string) { Tag = "string" }
            }
            class B : A {
                init() : base("hi") { }
            }
            func Main() {
                var b = B()
                System.Console.WriteLine(b.Tag)
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("string\n", output);
    }

    [Fact]
    public void EndToEnd_ChainToBasePrimaryConstructor_StillWorks()
    {
        var source = """
            package p
            open class A(X int32) {}
            class B : A {
                init(x int32) : base(x) {}
                func Read() int32 { return X }
            }
            func Main() {
                var b = B(42)
                System.Console.WriteLine(b.Read())
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void EndToEnd_ChainToClrBaseConstructor_StillWorks()
    {
        var source = """
            package p
            class MyError : System.Exception {
                var Code int32
                init(m string, c int32) : base(m) { Code = c }
            }
            func Main() {
                var e = MyError("boom", 13)
                System.Console.WriteLine(e.Message)
                System.Console.WriteLine(e.Code)
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("boom\n13\n", output);
    }

    [Fact]
    public void Library_ChainToExplicitBaseInit_PassesIlVerify()
    {
        // ilverify is invoked unconditionally by CompileLibrary; emitting a call
        // to the wrong base .ctor token (e.g. a non-existent parameterless ctor)
        // would fail verification here.
        var source = """
            package p
            open class A {
                var X int32
                init(x int32) { X = x }
                init(x int32, y int32) { X = x + y }
            }
            class B : A {
                init(x int32) : base(x) { }
                init() : base(1, 2) { }
            }
            """;

        var dllPath = CompileLibrary(source);
        TryCleanup(dllPath);
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1060_lib_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new[]
        {
            "/out:" + outPath,
            "/target:library",
            "/targetframework:net10.0",
            srcPath,
        };

        RunCompiler(args);
        IlVerifier.Verify(outPath);
        return outPath;
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1060_exe_").FullName;
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

            RunCompiler(args);
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

    private static void RunCompiler(string[] args)
    {
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
    }

    private static void TryCleanup(string dllPath)
    {
        try
        {
            var dir = Path.GetDirectoryName(dllPath);
            if (dir != null && Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch
        {
        }
    }
}
