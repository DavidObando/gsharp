// <copyright file="Issue1199ImportedCompositeLiteralEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1199: end-to-end emit tests proving a composite literal
/// <c>T{Member: value}</c> on an IMPORTED reference-type class (a BCL class)
/// constructs the instance via its parameterless constructor and assigns each
/// named settable member through its CLR property setter / field — the C#
/// object-initializer lowering. Each test compiles via <c>gsc</c>, runs
/// <c>ilverify</c>, executes the produced assembly, and asserts the member value
/// round-trips, which can only hold if the setter actually ran.
/// </summary>
public class Issue1199ImportedCompositeLiteralEmitTests
{
    [Fact]
    public void ImportedClassCompositeLiteral_SettableProperty_RoundTrips()
    {
        var source = """
            package Probe
            import System
            import System.Text

            var sb = StringBuilder{Capacity: 128}
            Console.WriteLine(sb.Capacity)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("128\n", output);
    }

    [Fact]
    public void ImportedClassCompositeLiteral_MultipleMembers_RoundTrip()
    {
        var source = """
            package Probe
            import System
            import System.Text

            var sb = StringBuilder{Capacity: 64}
            sb.Append("hi")
            Console.WriteLine(sb.Capacity)
            Console.WriteLine(sb.ToString())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("64\nhi\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1199_").FullName;
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
}
