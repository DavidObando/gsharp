// <copyright file="Issue1449DelegateCtorOverTypeBuilderEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1449 — emitting a function-literal event handler whose delegate type
/// is a constructed generic (<c>Action&lt;object, EventArgs&gt;</c>) crashed
/// with GS9998 "NotSupportedException: TypeBuilder generic instantiation does
/// not support resolving members." The delegate's CLR type is realized as a
/// reflection-emit <c>TypeBuilderInstantiation</c> (the event sender slot is a
/// host-runtime <c>object</c> while the <c>EventArgs</c> argument is loaded
/// through the reference <see cref="System.Reflection.MetadataLoadContext"/>),
/// so calling <c>GetConstructors()</c> on it throws. The emitter now resolves
/// the delegate's canonical <c>(object, IntPtr)</c> constructor from the open
/// generic definition instead.
/// <para>
/// Reproducing the crash requires compiling with explicit reference assemblies
/// so the BCL types flow through a MetadataLoadContext (matching how gsc is
/// driven in real builds); the in-process default reference set resolves every
/// type to a host runtime type and never produces the mixed-context
/// instantiation. The tests therefore pass the host shared framework as
/// <c>/r:</c> references.
/// </para>
/// </summary>
public class Issue1449DelegateCtorOverTypeBuilderEmitTests
{
    [Fact]
    public void EndToEnd_NonCapturingEventHandlerLambda_Runs()
    {
        // Action<object, EventArgs>-shaped delegate ctor over a
        // TypeBuilderInstantiation, no-capture closure branch.
        var source = """
            package Issue1449NoCapture
            import System

            class Notifier1449NC {
                event Updated (object?, EventArgs) -> void

                func Raise() {
                    Updated?(this, EventArgs())
                }
            }

            func Main() {
                let n = Notifier1449NC()
                n.Updated += (s object?, e EventArgs) -> Console.WriteLine("handled")
                n.Raise()
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("handled\n", output);
    }

    [Fact]
    public void EndToEnd_CapturingEventHandlerLambda_Runs()
    {
        // Same constructed-generic delegate ctor, but the handler captures an
        // outer variable so it flows through the capture-bearing closure
        // branch.
        var source = """
            package Issue1449Capture
            import System

            class Counter1449C {
                var total int32 = 0
            }

            class Notifier1449C {
                event Updated (object?, EventArgs) -> void

                func Raise() {
                    Updated?(this, EventArgs())
                }
            }

            func Main() {
                let c = Counter1449C()
                let n = Notifier1449C()
                n.Updated += (s object?, e EventArgs) -> Console.WriteLine(c.total + 5)
                n.Raise()
                n.Raise()
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n5\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1449_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            // Issue #1449 only reproduces when BCL types are resolved through a
            // MetadataLoadContext (engaged by passing explicit /r: references),
            // which is how gsc is invoked in real builds. Reference the host
            // shared framework so EventArgs is an MLC type while the event
            // sender stays a host-runtime object — the mixed-context
            // instantiation that produced the original crash.
            var runtimeDir = RuntimeEnvironment.GetRuntimeDirectory();
            var args = new List<string>
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
            };
            foreach (var refDll in Directory.GetFiles(runtimeDir, "*.dll"))
            {
                args.Add("/r:" + refDll);
            }

            args.Add(srcPath);

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
            }
        }
    }
}
