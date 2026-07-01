// <copyright file="Issue1556ReceiverDefaultParamEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1556 — a receiver-form (extension-style) function
/// <c>func (x T) M(a A, b B = &lt;default&gt;) R</c> could not be called with a
/// trailing defaulted parameter omitted: the binder validated against the full
/// parameter count and reported GS0144 ("requires N arguments but was given
/// N-1") without filling the trailing defaults. The equivalent free-function
/// and static (<c>shared</c>) call paths already synthesized omitted trailing
/// slots from each parameter's captured default constant (ADR-0063 / issues
/// #936, #1319).
/// <para>
/// The fix teaches <c>OverloadResolver.BindExtensionFunctionCall</c> to count
/// the leading non-optional user parameters (the receiver occupies
/// <c>Parameters[0]</c>, so the scan runs over <c>Parameters[1..]</c>), accept
/// any argument count in <c>[required, total]</c>, and pad the omitted trailing
/// slots from each parameter's captured default value before the generic
/// inference and per-position conversion loops — exactly as the free-function,
/// static, and user-instance call paths do.
/// </para>
/// Each test uses a UNIQUE package/type name because the in-process
/// <c>FunctionTypeSymbol</c> cache is name-keyed.
/// </summary>
public class Issue1556ReceiverDefaultParamEmitTests
{
    [Fact]
    public void EndToEnd_ValueReceiver_OneTrailingDefaultOmitted_Runs()
    {
        const string source = """
            package i1556one
            import System

            func (x int32) Combine1556(a int32, b int32 = 5) int32 -> x + a + b

            func Main() {
                let v = 3
                Console.WriteLine(v.Combine1556(1))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("9\n", output);
    }

    [Fact]
    public void EndToEnd_ValueReceiver_AllTrailingDefaultsOmitted_Runs()
    {
        const string source = """
            package i1556all
            import System

            func (x int32) C21556(a int32 = 2, b int32 = 5) int32 -> x + a + b

            func Main() {
                let v = 3
                Console.WriteLine(v.C21556())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("10\n", output);
    }

    [Fact]
    public void EndToEnd_ValueReceiver_AllArgumentsSupplied_Runs()
    {
        const string source = """
            package i1556full
            import System

            func (x int32) CombineFull1556(a int32, b int32 = 5) int32 -> x + a + b

            func Main() {
                let v = 3
                Console.WriteLine(v.CombineFull1556(1, 9))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("13\n", output);
    }

    [Fact]
    public void EndToEnd_UserStructReceiver_TrailingDefaultOmitted_Runs()
    {
        const string source = """
            package i1556struct
            import System

            struct Pt1556(X int32) { }

            func (p Pt1556) Shift1556(dx int32, dy int32 = 100) int32 -> p.X + dx + dy

            func Main() {
                Console.WriteLine(Pt1556(3).Shift1556(1))
                Console.WriteLine(Pt1556(3).Shift1556(1, 9))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("104\n13\n", output);
    }

    [Fact]
    public void EndToEnd_ReferenceStringReceiver_TrailingDefaultOmitted_Runs()
    {
        const string source = """
            package i1556string
            import System

            func (s string) Rep1556(n int32 = 2) string {
                var r = ""
                for var i = 0; i < n; i = i + 1 { r = r + s }
                return r
            }

            func Main() {
                Console.WriteLine("ab".Rep1556())
                Console.WriteLine("ab".Rep1556(3))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("abab\nababab\n", output);
    }

    [Fact]
    public void EndToEnd_BclTypeReceiver_TrailingDefaultOmitted_Runs()
    {
        const string source = """
            package i1556type
            import System

            func (t Type) Label1556(level int32? = nil, full bool = false) int32 -> if level != nil { level!! } else { 0 }

            func Main() {
                let t = typeof(int32)
                Console.WriteLine(t.Label1556(7))
                Console.WriteLine(t.Label1556())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n0\n", output);
    }

    [Fact]
    public void EndToEnd_NilNullableDefault_Omitted_Runs()
    {
        const string source = """
            package i1556nil
            import System

            func (x int32?) OrElse1556(fallback int32? = nil) int32 -> if fallback != nil { fallback!! } else { 5 }

            func Main() {
                var y int32? = 7
                Console.WriteLine(y.OrElse1556())
                Console.WriteLine(y.OrElse1556(42))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n42\n", output);
    }

    [Fact]
    public void EndToEnd_GenericReceiverForm_TrailingDefaultOmitted_Runs()
    {
        const string source = """
            package i1556generic
            import System

            func (x int32) Gen1556[T](tag T, extra int32 = 11) int32 -> x + extra

            func Main() {
                Console.WriteLine((3).Gen1556[string]("hi"))
                Console.WriteLine((3).Gen1556[string]("hi", 100))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("14\n103\n", output);
    }

    [Fact]
    public void EndToEnd_OverloadDisambiguation_DefaultsParticipate_SelectsCorrectly()
    {
        const string source = """
            package i1556overload
            import System

            func (x int32) Ov1556(a int32, b int32 = 5) int32 -> x + a + b
            func (x int32) Ov1556(a string) int32 -> x + a.Length

            func Main() {
                Console.WriteLine((10).Ov1556(1))
                Console.WriteLine((10).Ov1556("abc"))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("16\n13\n", output);
    }

    [Fact]
    public void Negative_RequiredParameterOmitted_ReportsGs0144()
    {
        // Omitting a REQUIRED (non-defaulted) parameter still reports GS0144;
        // only trailing defaulted parameters may be omitted.
        const string source = """
            package i1556neg
            import System

            func (x int32) Need1556(a int32, b int32 = 5) int32 -> x + a + b

            func Main() {
                Console.WriteLine((10).Need1556())
            }
            """;

        var (exit, output) = CompileOnly(source);
        Assert.NotEqual(0, exit);
        Assert.Contains("GS0144", output);
    }

    [Fact]
    public void Control_FreeFunctionDefault_StillRuns()
    {
        // Regression guard: the free-function default-parameter path that
        // already worked must keep working.
        const string source = """
            package i1556free
            import System

            func F1556(x int32, a int32, b int32 = 5) int32 -> x + a + b

            func Main() {
                Console.WriteLine(F1556(3, 1))
                Console.WriteLine(F1556(3, 1, 9))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("9\n13\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1556_exe_").FullName;
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

    private static (int Exit, string Output) CompileOnly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1556_neg_").FullName;
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

            return (compileExit, stdoutWriter + stderrWriter.ToString());
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
