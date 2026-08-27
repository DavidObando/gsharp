// <copyright file="Issue3524VariadicNamedDelegateEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3524: a variadic parameter whose element type is a user-declared
/// named G# delegate crashed emit with GS9998 (<c>NotSupportedException:
/// Cannot resolve element type token for 'Spec'.</c>) from
/// <c>ImportedMemberRefFactory.GetElementTypeToken</c>. The method's
/// element-token cases handled structs/enums/interfaces but had no branch
/// for <c>DelegateTypeSymbol</c>,
/// so encoding the variadic parameter's slice/array element type (the named
/// delegate) fell through to the terminal throw. The same named delegate
/// worked fine as an ordinary, non-variadic parameter.
/// </summary>
public class Issue3524VariadicNamedDelegateEmitTests
{
    [Fact]
    public void EndToEnd_VariadicNamedDelegateParameter_Runs()
    {
        const string source = """
            package FindingVariadicNamedDelegateArray

            delegate Spec(value float64) float64;

            func Apply(value float64, specs ... Spec) float64 {
              return specs[0](value)
            }

            func Main() int32 {
              let result = Apply(3.0, (value float64) -> value * 2.0)
              return result == 6.0 ? 0 : 1
            }
            """;

        var exitCode = CompileAndRun(source);
        Assert.Equal(0, exitCode);
    }

    private static int CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3524_exe_").FullName;
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
                proc.ExitCode == 0 || proc.ExitCode == 1,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return proc.ExitCode;
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
