// <copyright file="Issue3527SharedMemberVsPackageFunctionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3527 — inside a <c>shared</c> member body, an unqualified call whose
/// name collides with a same-named PACKAGE-level function silently bound the
/// package function instead of the enclosing type's own <c>shared</c> sibling
/// method, with no diagnostic. This proves the fix end-to-end: the minimal
/// two-file repro from the issue now compiles, emits verifiable IL, and
/// executes the type's own method.
/// </summary>
public class Issue3527SharedMemberVsPackageFunctionEmitTests
{
    [Fact]
    public void EndToEnd_SharedMethodBareCall_PrefersOwnSharedSibling_OverPackageFunction()
    {
        // The exact repro from the issue, split across two files in the same
        // package: Helper.gs declares a package-level `check`, Main.gs
        // declares a class whose `shared` block ALSO declares a private
        // `check`. `Run`'s bare `check()` call must bind its own sibling and
        // increment `count`, so `Main` returns 0.
        const string helperSource = """
            package i3527sharedvspkg

            func check() {
            }
            """;
        const string mainSource = """
            package i3527sharedvspkg

            class Checks {
              shared {
                private var count int32

                private func check() {
                  count++
                }

                public func Run() int32 {
                  check()
                  return count
                }
              }
            }

            func Main() int32 {
              return Checks.Run() == 1 ? 0 : 1
            }
            """;

        var exitCode = CompileAndRun(helperSource, mainSource);
        Assert.Equal(0, exitCode);
    }

    private static int CompileAndRun(params string[] sources)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3527_exe_").FullName;
        try
        {
            var dllPath = Path.Combine(tempDir, "test.dll");
            var srcPaths = new string[sources.Length];
            for (var i = 0; i < sources.Length; i++)
            {
                srcPaths[i] = Path.Combine(tempDir, $"test{i}.gs");
                File.WriteAllText(srcPaths[i], sources[i]);
            }

            var args = new System.Collections.Generic.List<string>
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
            };
            args.AddRange(srcPaths);

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
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
