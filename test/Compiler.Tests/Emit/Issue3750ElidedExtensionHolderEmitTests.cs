// <copyright file="Issue3750ElidedExtensionHolderEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3750 — cs2gs lowers a C# extension-holder <c>static class</c> to
/// top-level receiver-clause funcs and keeps the (now empty) holder alive when
/// something still names it in a <c>typeof</c>. This is the gsc-side proof that
/// the shape cs2gs emits does not merely bind: the empty holder reaches
/// metadata as a real type in the emitted assembly, so
/// <c>typeof(Holder).Assembly.Location</c> — the idiom both migrated call sites
/// use — answers the emitted assembly, while the lifted extension still
/// dispatches through the receiver form.
/// </summary>
public class Issue3750ElidedExtensionHolderEmitTests
{
    [Fact]
    public void EndToEnd_TypeOfRetainedExtensionHolder_ResolvesAndNamesEmittedAssembly()
    {
        var source = """
            package Probe3750
            import System

            class NamedParamsExtensionFixture3750 {
            }

            func (source string) Describe3750(statusCode int32) string ->
                source + ":" + statusCode.ToString()

            func Main() {
                let holder = typeof(NamedParamsExtensionFixture3750)
                Console.WriteLine(holder.Name)
                Console.WriteLine(holder.Assembly.Location == typeof(Probe3750Marker).Assembly.Location)
                Console.WriteLine("ok".Describe3750(200))
            }

            class Probe3750Marker {
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal(
            $"NamedParamsExtensionFixture3750{Environment.NewLine}True{Environment.NewLine}ok:200{Environment.NewLine}",
            output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3750_exe_").FullName;
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

            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch (IOException)
            {
                // Best-effort cleanup of the temp compile directory.
            }
            catch (UnauthorizedAccessException)
            {
                // Best-effort cleanup of the temp compile directory.
            }
        }
    }
}
