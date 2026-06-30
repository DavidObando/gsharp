// <copyright file="Issue1486InheritedAutoPropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1486 — reading (or writing) an INHERITED auto-property from a DERIVED
/// class lowered to a direct <c>ldfld</c>/<c>stfld</c> of the base class's PRIVATE
/// <c>&lt;X&gt;k__BackingField</c> instead of dispatching through the accessor.
/// That emitted invalid IL (ilverify <c>FieldAccess: Field is not visible</c>) and
/// threw <see cref="FieldAccessException"/> at runtime. After the fix the direct
/// backing-field lowering fires only when the enclosing type DIRECTLY declares the
/// property; an inherited access dispatches through <c>get_X</c>/<c>set_X</c>.
/// </summary>
public class Issue1486InheritedAutoPropertyEmitTests
{
    [Fact]
    public void EndToEnd_DerivedReadsInheritedAutoProperty_VerifiesAndRuns()
    {
        var source = """
            package Issue1486a
            import System

            open class Issue1486Base {
                init() { Value = 7 }
                prop Value int32 { get; init; }
            }

            class Issue1486Derived : Issue1486Base {
                init() : base() { }
                shared {
                    func Make() int32 {
                        let d = Issue1486Derived()
                        return d.Value
                    }
                }
            }

            func Main() {
                Console.WriteLine(Issue1486Derived.Make())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void EndToEnd_DerivedWritesThenReadsInheritedAutoProperty_VerifiesAndRuns()
    {
        var source = """
            package Issue1486b
            import System

            open class Issue1486BaseW {
                prop Value int32 { get; set; }
            }

            class Issue1486DerivedW : Issue1486BaseW {
                shared {
                    func Make() int32 {
                        let d = Issue1486DerivedW()
                        d.Value = 42
                        return d.Value
                    }
                }
            }

            func Main() {
                Console.WriteLine(Issue1486DerivedW.Make())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void EndToEnd_OwnAutoPropertyStillWorks_VerifiesAndRuns()
    {
        var source = """
            package Issue1486c
            import System

            class Issue1486Own {
                init() { Value = 99 }
                prop Value int32 { get; init; }
                shared {
                    func Make() int32 {
                        let o = Issue1486Own()
                        return o.Value
                    }
                }
            }

            func Main() {
                Console.WriteLine(Issue1486Own.Make())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1486_exe_").FullName;
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
