// <copyright file="Issue1441StringFromCharArrayEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1441 — `string(charArray)` (the G# rendering of C#
/// <c>new string(char[])</c>) bound as a <c>[]char -&gt; string</c> conversion
/// but had no emit path, crashing with GS9998
/// "Conversion from '[]char' to 'string' is not yet supported by the emitter".
/// The fix materialises it via the <c>System.String(char[])</c> constructor.
/// </summary>
public class Issue1441StringFromCharArrayEmitTests
{
    [Fact]
    public void EndToEnd_StringFromMutatedCharArray_Runs()
    {
        var source = """
            package Probe1441a
            import System

            func Conv(n int32) string {
                let nameBts = [n]char
                var i = 0
                while i < n {
                    nameBts[i] = 'x'
                    i = i + 1
                }
                return string(nameBts)
            }

            func Main() {
                Console.WriteLine(Conv(3))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("xxx\n", output);
    }

    [Fact]
    public void EndToEnd_StringFromCharArrayParameter_Runs()
    {
        var source = """
            package Probe1441b
            import System

            func ToText(chars []char) string {
                return string(chars)
            }

            func Main() {
                let buf = [3]char
                buf[0] = 'h'
                buf[1] = 'i'
                buf[2] = '!'
                Console.WriteLine(ToText(buf))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hi!\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1441_exe_").FullName;
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
