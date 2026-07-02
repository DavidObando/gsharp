// <copyright file="Issue1635DeferCaptureMetadataEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1635 NB-1: <c>CaptureDeferArguments</c> rebuilds the deferred call
/// so it can run against eagerly-captured locals. The rebuild must carry
/// EVERY metadata property of the original bound call — not just the
/// receiver/target and arguments — or the deferred call emits wrong dispatch
/// or unverifiable IL. These tests round-trip through compile → IL-verify →
/// run for two scenarios the short reconstruction dropped:
/// <list type="bullet">
/// <item>a `defer` on a constrained-interface instance call (issue #943),
/// which needs <c>ConstrainedReceiverTypeParameter</c>/<c>ConstrainedInterfaceType</c>
/// to emit a valid `constrained.`-prefixed `callvirt`;</item>
/// <item>a `defer` on an imported generic instance method with an explicit
/// type argument (issue #320), which needs <c>TypeArgumentSymbols</c> to
/// close the generic method correctly.</item>
/// </list>
/// Before the fix, the constrained-call scenario throws
/// <see cref="InvalidProgramException"/> at run time because the rebuilt
/// call loses the `constrained.` dispatch info.
/// </summary>
public class Issue1635DeferCaptureMetadataEmitTests
{
    [Fact]
    public void Defer_OnConstrainedInterfaceInstanceCall_PreservesConstrainedDispatch()
    {
        var source = """
            package p
            import System

            func Touch[T IComparable[T]](a T, b T) {
                defer a.CompareTo(b)
                Console.WriteLine("body")
            }

            Touch[int32](7, 3)
            Console.WriteLine("done")
            """;

        var output = CompileVerifyAndRun(source);
        Assert.Equal("body\ndone\n", output);
    }

    [Fact]
    public void Defer_OnImportedInstanceGenericMethodWithExplicitTypeArgument_PreservesTypeArguments()
    {
        var source = """
            package p
            import System
            import System.Collections.Generic

            func conv(x int32) string {
                Console.WriteLine(x.ToString())
                return x.ToString()
            }

            var list = List[int32]()
            list.Add(1)
            list.Add(2)
            list.Add(3)
            {
                defer list.ConvertAll[string](conv)
                Console.WriteLine("body")
            }
            """;

        var output = CompileVerifyAndRun(source);
        Assert.Equal("body\n1\n2\n3\n", output);
    }

    private static string CompileVerifyAndRun(string source)
    {
        var workDir = Path.Combine(AppContext.BaseDirectory, "issue1635_defer_" + Guid.NewGuid().ToString("N"));
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
            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try
            {
                Directory.Delete(workDir, recursive: true);
            }
            catch
            {
                // Best-effort cleanup; ignore.
            }
        }
    }
}
