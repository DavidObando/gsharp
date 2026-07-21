// <copyright file="Issue1283ImplicitConversionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1283: a user-defined <c>func operator implicit (x T) U</c> declared
/// inside a struct/class body must be applied IMPLICITLY wherever a target type
/// is expected — at return, <c>let</c>/<c>var</c> init with an explicit type,
/// field/property store, and argument passing. Each site emits a
/// <c>call U op_Implicit(T)</c> around the source value, exactly like the
/// explicit type-call cast form <c>U(x)</c>. These tests compile a program that
/// exercises every position, verify the emitted IL, and assert the runtime
/// output proves the conversion ran.
/// </summary>
public class Issue1283ImplicitConversionEmitTests
{
    [Fact]
    public void ExactOahuCliTui_StyleNullableAndSemanticColorSites_CompileWithoutGS0155()
    {
        var semanticColor = """
            package Oahu.Cli.Tui.Tokens
            import Spectre.Console

            data struct SemanticColor(Value Color) {
                func operator implicit(c SemanticColor) Color {
                    return c.Value
                }
                func operator implicit(c SemanticColor) Style {
                    return Style(c.Value)
                }
            }
            """;
        var sites = """
            package Oahu.Cli.Tui.Widgets
            import Spectre.Console
            import Oahu.Cli.Tui.Tokens

            class ConversionSites {
                var fill Style?

                func TakeNullable(fill Style?) {}
                func TakeStyle(fill Style) {}

                func ReturnNullable(fill Style) Style? {
                    return fill
                }

                func PreserveNullable(fill Style?) Style? {
                    let copy Style? = fill
                    this.fill = fill
                    this.TakeNullable(fill)
                    return copy
                }

                func ReturnStyle(color SemanticColor) Style {
                    return color
                }

                func Apply(fill Style, color SemanticColor) {
                    let nullable Style? = fill
                    this.fill = fill
                    this.TakeNullable(fill)
                    let style Style = color
                    this.TakeStyle(color)
                }
            }
            """;

        var spectrePath = typeof(Spectre.Console.Style).Assembly.Location;
        CompileAndVerify(
            new[] { semanticColor, sites },
            new[]
            {
                spectrePath,
                Path.Combine(Path.GetDirectoryName(spectrePath)!, "Spectre.Console.Ansi.dll"),
            });
    }

    [Fact]
    public void InBodyImplicit_AppliedAtEveryTargetTypedPosition_EmitsAndRuns()
    {
        var source = """
            package P
            import System

            struct Meters {
                var V int32
                func operator implicit (v int32) Meters {
                    return Meters{V: v}
                }
            }

            class C {
                var P Meters
                func Take(m Meters) {
                    Console.WriteLine(m.V)
                }
                func Ret() Meters {
                    return 5
                }
                func F(n int32) {
                    let a Meters = n
                    Console.WriteLine(a.V)
                    var b Meters
                    b = n
                    Console.WriteLine(b.V)
                    this.P = n
                    Console.WriteLine(this.P.V)
                    this.Take(n)
                }
            }

            let c = C{ }
            Console.WriteLine(c.Ret().V)
            c.F(7)
            """;

        Assert.Equal("5\n7\n7\n7\n7\n", CompileAndRun(source));
    }

    [Fact]
    public void InBodyImplicit_OnDataClass_AppliedAtAssignment_EmitsAndRuns()
    {
        var source = """
            package P
            import System

            data class Meters {
                var V int32
                func operator implicit (v int32) Meters {
                    return Meters{V: v}
                }
            }

            let m Meters = 42
            Console.WriteLine(m.V)
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void InBodyImplicit_FromVariableOperand_AppliedAtArgument_EmitsAndRuns()
    {
        var source = """
            package P
            import System

            struct Meters {
                var V int32
                func operator implicit (v int32) Meters {
                    return Meters{V: v}
                }
            }

            func show(m Meters) {
                Console.WriteLine(m.V)
            }

            let n = 11
            show(n)
            """;

        Assert.Equal("11\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = CreateTestDirectory();
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new System.Collections.Generic.List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
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
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");

            // (a) Static verification: the emitted IL must be valid.
            IlVerifier.Verify(outPath);

            // (b) Dynamic verification: the emitted code must execute.
            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + outPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = Process.Start(psi)!;
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static void CompileAndVerify(string[] sources, string[] references)
    {
        var workDir = CreateTestDirectory();
        try
        {
            var outPath = Path.Combine(workDir, "test.dll");
            var args = new System.Collections.Generic.List<string>
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };

            foreach (var reference in references)
            {
                args.Add("/reference:" + reference);
            }

            for (var i = 0; i < sources.Length; i++)
            {
                var sourcePath = Path.Combine(workDir, $"source{i}.gs");
                File.WriteAllText(sourcePath, sources[i]);
                args.Add(sourcePath);
            }

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int exitCode;
            try
            {
                exitCode = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            var diagnostics = compileOut.ToString() + compileErr;
            Assert.True(exitCode == 0, diagnostics);
            Assert.DoesNotContain("GS0155", diagnostics, StringComparison.Ordinal);
            IlVerifier.Verify(outPath, references);
        }
        finally
        {
            try { Directory.Delete(workDir, recursive: true); } catch { }
        }
    }

    private static string CreateTestDirectory()
    {
        var root = Path.Combine(Environment.CurrentDirectory, "TestArtifacts");
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, "gs_issue1283_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }
}
