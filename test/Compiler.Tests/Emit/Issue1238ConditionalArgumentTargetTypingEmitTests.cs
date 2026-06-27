// <copyright file="Issue1238ConditionalArgumentTargetTypingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1238: end-to-end CLR emit coverage for target-typed conditional /
/// switch-expression CALL ARGUMENTS. An <c>if</c>/<c>else</c>, ternary, or
/// switch-expression passed directly as an argument must be target-typed to the
/// corresponding parameter type so a <c>nil</c> (or narrower) branch widens to
/// the parameter's nullable type — matching the behavior already present in
/// <c>return</c> / typed-<c>let</c> positions. The emitted program must run and
/// produce the expected values for both the nil and non-nil branches, and
/// ilverify must accept the assembly.
/// </summary>
public class Issue1238ConditionalArgumentTargetTypingEmitTests
{
    [Fact]
    public void EndToEnd_IfExpressionArgument_NilBranch_RunsCorrectly()
    {
        var source = """
            package Probe
            import System

            class C {
                func Describe(data string?) string {
                    if data == nil {
                        return "none"
                    }
                    return data!!
                }
                func Run(s string?) string {
                    return Describe(if s == nil { nil } else { s!! })
                }
            }

            func Main() {
                var c = C()
                Console.WriteLine(c.Run(nil))
                Console.WriteLine(c.Run("hi"))
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("none\nhi\n", output);
    }

    [Fact]
    public void EndToEnd_SwitchExpressionArgument_NilArm_RunsCorrectly()
    {
        var source = """
            package Probe
            import System

            class C {
                func Describe(data string?) string {
                    if data == nil {
                        return "none"
                    }
                    return data!!
                }
                func Run(n int32) string {
                    return Describe(switch n { case 0: nil default: "val" })
                }
            }

            func Main() {
                var c = C()
                Console.WriteLine(c.Run(0))
                Console.WriteLine(c.Run(7))
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("none\nval\n", output);
    }

    [Fact]
    public void EndToEnd_ConstructorArgument_IfExpressionNilBranch_RunsCorrectly()
    {
        var source = """
            package Probe
            import System

            class Holder {
                let value string?
                init(v string?) {
                    this.value = v
                }
                func Text() string {
                    if this.value == nil {
                        return "empty"
                    }
                    return this.value!!
                }
            }

            class C {
                func Make(s string?) Holder {
                    return Holder(if s == nil { nil } else { s!! })
                }
            }

            func Main() {
                var c = C()
                Console.WriteLine(c.Make(nil).Text())
                Console.WriteLine(c.Make("ok").Text())
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("empty\nok\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_cond1238_exe_").FullName;
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
