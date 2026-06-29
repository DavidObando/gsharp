// <copyright file="Issue1407BclGenericMethodInferenceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1407: BCL generic method inference must handle a by-ref array
/// parameter (<c>Array.Resize&lt;T&gt;(ref T[], int)</c>) and method type inference
/// from an arrow literal to a named delegate parameter
/// (<c>List&lt;T&gt;.ConvertAll&lt;U&gt;(Converter&lt;T,U&gt;)</c>).
/// </summary>
public class Issue1407BclGenericMethodInferenceEmitTests
{
    [Fact]
    public void ArrayResize_InfersElementTypeFromRefSlice_CompilesAndRuns()
    {
        var source = """
            package p
            import System

            var b = []uint8{0}
            Array.Resize(&b, 5)
            if b.Length != 5 { Environment.Exit(11) }
            if b[0] != 0 { Environment.Exit(12) }
            b[4] = 7
            if b[4] != 7 { Environment.Exit(13) }
            """;

        CompileVerifyAndRun(source);
    }

    [Fact]
    public void ListConvertAll_InfersResultTypeFromArrowToConverter_CompilesAndRuns()
    {
        var source = """
            package p
            import System
            import System.Collections.Generic
            import System.Linq

            let xs = []int32{1,2}.ToList()
            let y = xs.ConvertAll((x int32)->x)
            if y.Count != 2 { Environment.Exit(21) }
            if y[0] != 1 { Environment.Exit(22) }
            if y[1] != 2 { Environment.Exit(23) }
            """;

        CompileVerifyAndRun(source);
    }

    private static void CompileVerifyAndRun(string source)
    {
        var workDir = Path.Combine(AppContext.BaseDirectory, "issue1407_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        try
        {
            var srcPath = Path.Combine(workDir, "test.gs");
            var outPath = Path.Combine(workDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
            IlVerifier.Verify(outPath);

            File.WriteAllText(Path.ChangeExtension(outPath, "runtimeconfig.json"), """
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
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            Assert.True(proc.ExitCode == 0, $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        }
        finally
        {
            try
            {
                Directory.Delete(workDir, recursive: true);
            }
            catch
            {
            }
        }
    }
}
