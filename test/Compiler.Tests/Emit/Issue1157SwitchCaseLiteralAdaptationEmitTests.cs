// <copyright file="Issue1157SwitchCaseLiteralAdaptationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1157: end-to-end emit + execution test proving a constant integer
/// literal case label adapts to a narrow / unsigned governing type and the
/// correct switch-expression arm is selected at runtime. Mirrors the #1144
/// emit harness: each program compiles via <c>gsc</c>, is IL-verified, and is
/// run under <c>dotnet exec</c> with its runtime output asserted.
/// </summary>
public class Issue1157SwitchCaseLiteralAdaptationEmitTests
{
    [Fact]
    public void UInt8SwitchExpression_LiteralLabelsAdapt_DispatchesCorrectArm()
    {
        var source = """
            package main
            import System

            func F(b uint8) int32 {
                return switch b {
                    case 0: 10
                    case 1: 20
                    default: 30
                }
            }

            func run() {
                Console.WriteLine(F(uint8(1)))
                Console.WriteLine(F(uint8(7)))
                Console.WriteLine(F(uint8(0)))
            }

            run()
            """;

        // case 1 -> 20, no match -> default 30, case 0 -> 10
        Assert.Equal("20\n30\n10\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1157_").FullName;
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

            IlVerifier.Verify(outPath, null, Array.Empty<string>());

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
