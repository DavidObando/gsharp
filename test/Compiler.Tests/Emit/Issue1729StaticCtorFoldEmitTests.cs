// <copyright file="Issue1729StaticCtorFoldEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1729 — runtime proof that the fixed static-constructor fold produces
/// the CORRECT final field value at execution time, not merely a plausible-
/// looking translation. Each source string below is exactly the canonical G#
/// shape <c>cs2gs</c> emits after the fix (verified against
/// <c>Cs2Gs.Tests.Issue1729StaticCtorFoldTranslationTests</c>, which asserts the
/// C#→G# translation itself picks this shape). Every fact uses a UNIQUE
/// package/type name because the in-process compiler caches are name-keyed.
/// </summary>
public class Issue1729StaticCtorFoldEmitTests
{
    /// <summary>
    /// Mode 1 fix: when a static field has BOTH an inline initializer and a
    /// static-ctor assignment, C# runs the field initializer THEN the static
    /// constructor — the constructor's assignment is the field's true final
    /// value. The fold must keep that value (2), not the inline initializer's
    /// value (1).
    /// </summary>
    [Fact]
    public void FoldedStaticCtor_InlineInitializerOverwritten_RunsWithCtorFinalValue()
    {
        const string source = """
            package i1729mode1
            import System

            class C {
                shared {
                    var X int32 = 2
                }
            }

            func Main() { System.Console.WriteLine(C.X) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n", output);
    }

    /// <summary>
    /// Regression: a static field with no inline initializer, assigned once by
    /// an otherwise-trivial static constructor with an RHS independent of the
    /// type's own static state, must still fold correctly and run with the
    /// assigned value.
    /// </summary>
    [Fact]
    public void FoldedStaticCtor_SimpleAssignment_RunsWithFoldedValue()
    {
        const string source = """
            package i1729regression
            import System

            class C {
                shared {
                    var X int32 = 1
                }
            }

            func Main() { System.Console.WriteLine(C.X) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n", output);
    }

    /// <summary>
    /// Mode 4 fix: an outer static field declared AFTER a nested type must
    /// retain its own folded static-ctor initializer — the fold-collection state
    /// is now saved/restored around the nested-type visit instead of being
    /// wiped wholesale, so both the outer and nested fold survive.
    /// </summary>
    [Fact]
    public void FoldedStaticCtor_OuterFieldAfterNestedType_RunsWithBothFoldedValues()
    {
        const string source = """
            package i1729mode4
            import System

            class Outer {
                class Nested {
                    shared {
                        var NestedField int32 = 9
                    }
                }

                shared {
                    var Before int32 = 1
                    var After int32 = 2
                }
            }

            func Main() {
                System.Console.WriteLine(Outer.Before)
                System.Console.WriteLine(Outer.Nested.NestedField)
                System.Console.WriteLine(Outer.After)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n9\n2\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1729_exe_").FullName;
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
