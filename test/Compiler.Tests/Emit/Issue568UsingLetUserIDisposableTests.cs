// <copyright file="Issue568UsingLetUserIDisposableTests.cs" company="GSharp">
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
/// Issue #568: <c>using let</c> on a G# class that implements
/// <c>IDisposable</c> was rejected with GS0119 because
/// <c>ConversionClassifier.TryBuildDisposeCall</c> could not find the
/// <c>Dispose()</c> method — the user class had no CLR type yet. The fix
/// adds a user-type path that probes <c>StructSymbol.TryGetMethodIncludingInherited</c>.
/// </summary>
public class Issue568UsingLetUserIDisposableTests
{
    [Fact]
    public void UsingLet_GSharpClassImplementingIDisposable_CallsDispose()
    {
        var source = """
            package Probe
            import System

            class Fixture : IDisposable {
                func Dispose() {
                    Console.WriteLine("disposed")
                }
            }

            func test() {
                using let f = Fixture{}
                Console.WriteLine("inside")
            }
            test()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("inside\ndisposed\n", output);
    }

    [Fact]
    public void UsingLet_GSharpClassInheritsDispose_FromBaseClass()
    {
        // A G# class whose base class provides Dispose should also work.
        var source = """
            package Probe
            import System

            open class BaseDisp : IDisposable {
                func Dispose() {
                    Console.WriteLine("base-dispose")
                }
            }

            class Child : BaseDisp {
            }

            func test() {
                using let c = Child{}
                Console.WriteLine("used")
            }
            test()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("used\nbase-dispose\n", output);
    }

    [Fact]
    public void UsingLet_NonDisposableType_StillReportsGS0119()
    {
        var source = """
            package Probe
            import System

            using let x = 42
            Console.WriteLine(x)
            """;

        var errors = CompileExpectingErrors(source);
        Assert.Contains(errors, e => e.Contains("GS0119"));
    }

    [Fact]
    public void UsingLet_GSharpClassInheritsDispose_FromImportedBaseClass()
    {
        // Issue #2148: a G# class deriving from an imported IDisposable CLR base
        // (MemoryStream : Stream : IDisposable) must be usable in a `using`
        // statement — the inherited Dispose lives on the imported base's CLR type.
        var source = """
            package Probe
            import System
            import System.IO

            open class MyStream : MemoryStream {
                init() : base() {}
            }

            func test() {
                using let s = MyStream()
                s.WriteByte(1)
                Console.WriteLine("used")
            }
            test()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("used\n", output);
    }

    [Fact]
    public void AwaitUsingLet_GSharpClassInheritsDisposeAsync_FromImportedBaseClass()
    {
        // Issue #2148: the same fallback applies to `await using` — a G# class
        // deriving from an imported IAsyncDisposable base (Stream implements
        // IAsyncDisposable) resolves the inherited DisposeAsync on the CLR base.
        var source = """
            package Probe
            import System
            import System.IO

            open class MyAsyncStream : MemoryStream {
                init() : base() {}
            }

            async func test() {
                await using let s = MyAsyncStream()
                s.WriteByte(1)
                Console.WriteLine("aused")
            }
            test().GetAwaiter().GetResult()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("aused\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue568_").FullName;
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

    private static List<string> CompileExpectingErrors(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue568_err_").FullName;
        try
        {
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

            Assert.True(compileExit != 0, "expected gsc to report errors but it succeeded");
            var combined = compileOut.ToString() + compileErr.ToString();
            return combined.Split('\n').Where(l => !string.IsNullOrWhiteSpace(l)).ToList();
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
