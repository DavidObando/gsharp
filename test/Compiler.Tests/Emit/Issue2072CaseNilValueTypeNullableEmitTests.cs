// <copyright file="Issue2072CaseNilValueTypeNullableEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2072 — a switch/case-nil pattern against a value-type
/// <c>Nullable&lt;T&gt;</c> discriminant crashed emit with GS9998.
/// <para>
/// <c>PatternBinder.BindConstantPattern</c> built the <c>nil</c>-arm's
/// converted value directly as a bare <c>BoundConversionExpression</c>,
/// bypassing <c>ConversionClassifier.BindConversion</c>'s issue #504
/// lowering that rewrites <c>nil -&gt; Nullable&lt;value-type&gt;</c> to a
/// <c>BoundDefaultExpression</c> so emit can materialize the verifiable
/// <c>ldloca; initobj; ldloc</c> shape instead of an invalid <c>ldnull</c>
/// against a value-type <c>Nullable&lt;T&gt;</c> slot. Fixed by routing that
/// conversion through the same classifier entry point used everywhere else.
/// </para>
/// Covers a BCL primitive (<c>int32?</c>), a user struct, and a user enum
/// discriminant — every facet crashed emit on current main and passes after
/// the fix. Each uses a UNIQUE package/type name because the in-process
/// <c>FunctionTypeSymbol</c> cache is name-keyed.
/// </summary>
public class Issue2072CaseNilValueTypeNullableEmitTests
{
    [Fact]
    public void EndToEnd_CaseNil_Int32Nullable_Runs()
    {
        const string source = """
            package i2072int32
            import System

            class C {
                shared {
                    func Describe(x int32?) string -> switch x {
                        case _ is int32: "has value"
                        case nil: "none"
                        default: "impossible"
                    }
                }
            }

            func Main() {
                System.Console.WriteLine(C.Describe(5))
                System.Console.WriteLine(C.Describe(nil))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("has value\nnone\n", output);
    }

    [Fact]
    public void EndToEnd_CaseNil_UserStructNullable_Runs()
    {
        const string source = """
            package i2072struct
            import System

            struct Point2072(X int32, Y int32) { }

            class C {
                shared {
                    func Describe(p Point2072?) string -> switch p {
                        case _ is Point2072: "has point"
                        case nil: "no point"
                        default: "impossible"
                    }
                }
            }

            func Main() {
                System.Console.WriteLine(C.Describe(Point2072(1, 2)))
                System.Console.WriteLine(C.Describe(nil))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("has point\nno point\n", output);
    }

    [Fact]
    public void EndToEnd_CaseNil_UserEnumNullable_Runs()
    {
        const string source = """
            package i2072enum
            import System

            enum Color2072 { Red, Green, Blue }

            class C {
                shared {
                    func Describe(c Color2072?) string -> switch c {
                        case _ is Color2072: "has color"
                        case nil: "no color"
                        default: "impossible"
                    }
                }
            }

            func Main() {
                System.Console.WriteLine(C.Describe(Color2072.Green))
                System.Console.WriteLine(C.Describe(nil))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("has color\nno color\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2072_exe_").FullName;
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
