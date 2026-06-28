// <copyright file="Issue1391DefaultArgImportedGenericEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1391: passing the untyped <c>default</c> literal to an IMPORTED (CLR)
/// generic method invoked with an explicit type argument — e.g.
/// <c>Task.FromResult[int32](default)</c> — must compile AND lower the argument
/// to the proper default value of the SUBSTITUTED parameter type
/// (<c>default(int32)</c> = 0, <c>default(string)</c> = null,
/// <c>default(bool)</c> = false). Before the fix the call failed overload
/// resolution (GS0159); these tests round-trip gsc → PE → ilverify → dotnet exec
/// to prove a valid, correctly-typed default is emitted.
/// </summary>
public class Issue1391DefaultArgImportedGenericEmitTests
{
    [Fact]
    public void ImportedGenericDefault_PrimitiveTypeArg_ProducesZero()
    {
        var source = """
            package P
            import System
            import System.Threading.Tasks

            func R() Task[int32] { return Task.FromResult[int32](default) }

            var t = R()
            Console.WriteLine(t.Result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n", output);
    }

    [Fact]
    public void ImportedGenericDefault_ReferenceTypeArg_ProducesNull()
    {
        var source = """
            package P
            import System
            import System.Threading.Tasks

            func R() Task[string] { return Task.FromResult[string](default) }

            var t = R()
            Console.WriteLine(t.Result == nil)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void ImportedGenericDefault_BoolTypeArg_ProducesFalse()
    {
        var source = """
            package P
            import System
            import System.Threading.Tasks

            func R() Task[bool] { return Task.FromResult[bool](default) }

            var t = R()
            Console.WriteLine(t.Result)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("False\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1391_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
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

            using var proc = Process.Start(psi);
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
