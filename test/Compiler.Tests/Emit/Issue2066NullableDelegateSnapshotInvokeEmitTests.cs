// <copyright file="Issue2066NullableDelegateSnapshotInvokeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2066: assigning a field-like event to a nullable local of its
/// delegate type, null-guarding the local (smart-cast narrows
/// <c>TickHandler?</c> to <c>TickHandler</c>), then invoking it with call
/// syntax must bind and run identically to invoking the event directly. The
/// direct call-syntax binder previously keyed off the declared (nullable)
/// <c>VariableSymbol.Type</c> rather than any active smart-cast narrowing, so
/// the narrowed local's delegate-invoke branch never matched.
/// </summary>
public class Issue2066NullableDelegateSnapshotInvokeEmitTests
{
    [Fact]
    public void NarrowedNullableNamedDelegateLocal_SnapshotOfFieldLikeEvent_InvokesWhenGuarded()
    {
        var source = """
            package Issue2066Pkg
            import System

            type TickHandler = delegate func(count int32) void

            class Clock {
                event Ticked TickHandler

                func Subscribe() {
                    Ticked += (count int32) -> Console.WriteLine(count)
                }

                func Fire(count int32) {
                    let snapshot TickHandler? = Ticked
                    if snapshot != nil {
                        snapshot(count)
                    }
                }
            }

            let c = Clock()
            c.Fire(1)
            c.Subscribe()
            c.Fire(42)
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void NarrowedNullableAnonymousFunctionTypeLocal_SnapshotOfFieldLikeEvent_InvokesWhenGuarded()
    {
        var source = """
            package Issue2066Pkg
            import System

            class Counter {
                event Bumped (int32) -> void

                func Subscribe() {
                    Bumped += (n int32) -> Console.WriteLine(n)
                }

                func Fire(n int32) {
                    let snapshot ((int32) -> void)? = Bumped
                    if snapshot != nil {
                        snapshot(n)
                    }
                }
            }

            let c = Counter()
            c.Fire(1)
            c.Subscribe()
            c.Fire(7)
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Path.Combine(AppContext.BaseDirectory, "Issue2066_" + Guid.NewGuid().ToString("N"));
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
