// <copyright file="Issue2082LambdaLiteralNamedDelegateEventEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2082: assigning an inline lambda/func-literal to a field-like event
/// of a user-declared named delegate type via <c>+=</c> must adapt the lambda
/// to the declared named-delegate type, not erase it to the lambda's natural
/// CLR <c>Action</c>/<c>Func</c> shape. Previously the lambda kept its
/// closure-delegate CLR type, mismatching the event accessor's declared
/// parameter type and failing IL verification.
/// </summary>
public class Issue2082LambdaLiteralNamedDelegateEventEmitTests
{
    [Fact]
    public void LambdaLiteralAddedToNamedDelegateEvent_AdaptsToDeclaredType_RunsAndVerifies()
    {
        var source = """
            package Issue2082Pkg
            import System

            type TickHandler = delegate func(count int32) void

            class Clock {
                public event Ticked TickHandler
            }

            func Main() {
                let c = Clock()
                c.Ticked += func(count int32) void { System.Console.WriteLine(count) }
            }
            """;

        Assert.Equal(string.Empty, CompileAndRun(source, invoke: false));
    }

    [Fact]
    public void LambdaLiteralAddedToNamedDelegateEvent_InvokedViaSnapshot_ProducesCorrectOutput()
    {
        var source = """
            package Issue2082Pkg2
            import System

            type TickHandler = delegate func(count int32) void

            class Clock {
                event Ticked TickHandler

                func Subscribe() {
                    Ticked += func(count int32) void { System.Console.WriteLine(count) }
                }

                func Fire(count int32) {
                    let snapshot = Ticked
                    if snapshot != nil {
                        snapshot(count)
                    }
                }
            }

            let c = Clock()
            c.Subscribe()
            c.Fire(42)
            """;

        Assert.Equal("42\n", CompileAndRun(source, invoke: true));
    }

    private static string CompileAndRun(string source, bool invoke)
    {
        var tempDir = Path.Combine(AppContext.BaseDirectory, "Issue2082_" + Guid.NewGuid().ToString("N"));
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
