// <copyright file="Issue2083NonEventNullDelegateSourceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2083: PR #2079 (issue #2066) made the delegate-to-delegate
/// adaptation sequence unconditionally null-guarded, which silently turned a
/// null non-nullable delegate source into a null result instead of the
/// pre-#2079 fail-fast <see cref="ArgumentException"/>. The fix restores the
/// throw for every source *except* a field-like event's backing field (the
/// one case, per #2066, where a non-nullable static type genuinely can be
/// null at runtime). This test proves a plain (non-event) non-nullable
/// class-field of an anonymous function type, when read as null and adapted
/// to a named delegate type, still throws instead of silently producing
/// null.
/// </summary>
public class Issue2083NonEventNullDelegateSourceEmitTests
{
    [Fact]
    public void NonEventNonNullableFieldSource_NullAtRuntime_ThrowsInsteadOfSilentlyNull()
    {
        var source = """
            package Issue2083Pkg
            import System

            type Handler = delegate func() void

            class Box {
                var H (() -> void)
            }

            func UseHandler(h Handler) {
                Console.WriteLine("called")
            }

            let b = Box{}
            UseHandler(b.H)
            """;

        var (exitCode, stdout, stderr) = CompileAndRun(source);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("ArgumentException", stdout + stderr);
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRun(string source)
    {
        var tempDir = Path.Combine(AppContext.BaseDirectory, "Issue2083_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
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
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
            IlVerifier.Verify(outPath);

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
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();

            return (proc.ExitCode, stdout.Replace("\r\n", "\n"), stderr.Replace("\r\n", "\n"));
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
