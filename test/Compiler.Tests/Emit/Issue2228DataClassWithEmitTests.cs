// <copyright file="Issue2228DataClassWithEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2228: a G# `data class` (the canonical target for a C# record class
/// whose data lives in body `init` auto-properties) must support the `with`
/// expression end-to-end — compile without GS0161, allocate a NEW instance
/// (reference semantics: the original instance is left unchanged), and
/// preserve value equality between two instances with identical members.
/// Mirrors the reported `OahuConfig`/`cfg = cfg with { DownloadDirectory = value }`
/// scenario: several primary-constructor fields, one overridden by `with`.
/// </summary>
public class Issue2228DataClassWithEmitTests
{
    [Fact]
    public void DataClass_With_CompilesAndUsesReferenceSemantics()
    {
        var source = """
            package Probe
            import System

            data class OahuConfig(DownloadDirectory string, MaxParallelJobs int32, VerboseLogging bool) {
            }

            var cfg = OahuConfig("downloads", 1, false)
            var updated = cfg with { DownloadDirectory = "elsewhere" }

            // Reference semantics: the original instance is untouched.
            Console.WriteLine(cfg.DownloadDirectory)
            Console.WriteLine(cfg.MaxParallelJobs)
            Console.WriteLine(cfg.VerboseLogging)

            // The new instance has the overridden member and every other
            // member copied from the original.
            Console.WriteLine(updated.DownloadDirectory)
            Console.WriteLine(updated.MaxParallelJobs)
            Console.WriteLine(updated.VerboseLogging)

            // `cfg = cfg with { ... }` (the exact reported call-site shape):
            // assigning back is legal and observably updates the variable.
            cfg = cfg with { DownloadDirectory = "elsewhere" }
            Console.WriteLine(cfg.DownloadDirectory)

            // Value equality: two data-class instances with identical
            // members are equal even though they are distinct heap objects.
            var other = OahuConfig("elsewhere", 1, false)
            Console.WriteLine(cfg == other)
            Console.WriteLine(cfg.Equals(other))
            Console.WriteLine(cfg.GetHashCode() == other.GetHashCode())
            """;

        var output = CompileAndRun(source);
        Assert.Equal(
            "downloads\n1\nFalse\nelsewhere\n1\nFalse\nelsewhere\nTrue\nTrue\nTrue\n",
            output);
    }

    [Fact]
    public void PlainClass_With_StillReportsGs0161()
    {
        var diagnostics = CompileExpectingErrors("""
            package Probe

            class PlainConfig(DownloadDirectory string) {
            }

            var cfg = PlainConfig("downloads")
            var updated = cfg with { DownloadDirectory = "elsewhere" }
            """);

        Assert.Contains(diagnostics, d => d.Contains("GS0161", StringComparison.Ordinal));
        Assert.Contains(diagnostics, d => d.Contains("data class or data struct", StringComparison.Ordinal));
    }

    // ====================================================================
    // Helpers
    // ====================================================================

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2228_").FullName;
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
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // ignored
            }
        }
    }

    private static System.Collections.Generic.List<string> CompileExpectingErrors(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2228_err_").FullName;
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
            try
            {
                Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            var combined = compileOut.ToString() + compileErr.ToString();
            return new System.Collections.Generic.List<string>(
                combined.Split('\n', StringSplitOptions.RemoveEmptyEntries));
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // ignored
            }
        }
    }
}
