// <copyright file="Issue2152LambdaAssignmentInferenceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2152 — a block-body lambda whose trailing expression is an
/// assignment infers a <c>void</c> return type on the target-less inference
/// path (overload resolution), so it matches an <c>Action</c>-style
/// <c>(int32) -&gt; void</c> delegate parameter. These tests compile,
/// IL-verify, and run a lambda-with-assignment-body invoked through an
/// inferred void-delegate parameter, asserting the assignment took effect.
/// </summary>
public class Issue2152LambdaAssignmentInferenceEmitTests
{
    [Fact]
    public void OverloadedVoidDelegate_AssignmentBodyLambda_InfersVoid_AndRuns()
    {
        var source = """
            package P
            import System

            func run(a () -> void) { a() }
            func run(b (int32) -> void) { b(9) }

            var total = 0
            run((x int32) -> { total = total + x })
            Console.WriteLine(total)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("9\n", output);
    }

    [Fact]
    public void OverloadedVoidDelegate_CompoundAssignmentBodyLambda_InfersVoid_AndRuns()
    {
        var source = """
            package P
            import System

            func run(a () -> void) { a() }
            func run(b (int32) -> void) { b(5) }

            var total = 3
            run((x int32) -> { total += x })
            Console.WriteLine(total)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("8\n", output);
    }

    private static string CompileAndRun(string source, string[] referencePaths = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2152_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new System.Collections.Generic.List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };

            if (referencePaths != null)
            {
                foreach (var reference in referencePaths)
                {
                    args.Add("/reference:" + reference);
                    File.Copy(reference, Path.Combine(tempDir, Path.GetFileName(reference)), overwrite: true);
                }
            }

            args.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
            IlVerifier.Verify(outPath, additionalReferences: referencePaths);

            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
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
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

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
            }
        }
    }
}
