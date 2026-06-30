// <copyright file="Issue1446PropertyIndexAssignEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1446 — writing to an array element through a bare instance
/// auto-property (<c>Prop[i] = v</c>) crashed emission with GS9998
/// "Variable 'Prop' has no local slot or parameter index in the current
/// method." The bare property name resolved to an
/// <c>ImplicitPropertyVariableSymbol</c>, which (unlike the implicit-field
/// case from #674) had no special handling in <c>BindIndexAssignmentExpression</c>
/// and fell through to a bare-variable load. The fix initialises a temp local
/// from the property getter (the array reference) and stores into that.
/// </summary>
public class Issue1446PropertyIndexAssignEmitTests
{
    [Fact]
    public void EndToEnd_InitArrayPropertyElementWriteInCtor_Runs()
    {
        var source = """
            package Probe1446a
            import System

            open class Holder1446a {
                init() {
                    Items = [3]int32
                    Items[0] = 10
                    Items[1] = 20
                    Items[2] = 30
                }
                prop Items []int32 { get; init; }
            }

            func Main() {
                let h = Holder1446a()
                Console.WriteLine(h.Items[0] + h.Items[1] + h.Items[2])
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("60\n", output);
    }

    [Fact]
    public void EndToEnd_MutableArrayPropertyElementWriteInMethod_Runs()
    {
        var source = """
            package Probe1446b
            import System

            open class Holder1446b {
                prop Data []string { get; set; }
                func Fill() {
                    Data = [2]string
                    Data[0] = "a"
                    Data[1] = "b"
                }
            }

            func Main() {
                let h = Holder1446b()
                h.Fill()
                Console.WriteLine(h.Data[0] + h.Data[1])
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("ab\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1446_exe_").FullName;
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
