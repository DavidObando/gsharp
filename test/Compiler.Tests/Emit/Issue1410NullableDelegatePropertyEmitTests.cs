// <copyright file="Issue1410NullableDelegatePropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1410: null-conditional invocation of a nullable function-typed
/// property must load the property getter result before invoking the delegate.
/// </summary>
public class Issue1410NullableDelegatePropertyEmitTests
{
    [Fact]
    public void NullableVoidDelegateProperty_NullConditionalInvoke_LoadsGetterAndExecutesWhenPresent()
    {
        var source = """
            package P
            import System

            class C {
                prop H ((int32)->void)? { get; set }

                func Set() {
                    H = (x int32) -> Console.WriteLine(x + 1)
                }

                func Raise(x int32) {
                    H?(x)
                }
            }

            let c = C()
            c.Raise(100)
            c.Set()
            c.Raise(41)
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void NullableValueReturningDelegateProperty_NullConditionalInvoke_ReturnsNullableValue()
    {
        var source = """
            package P
            import System

            class C {
                prop H ((int32)->int32)? { get; set }

                func Set() {
                    H = (x int32) -> x * 2
                }

                func Run(x int32) int32? {
                    return H?(x)
                }
            }

            let empty = C()
            Console.WriteLine(empty.Run(21) == nil)

            let c = C()
            c.Set()
            Console.WriteLine(c.Run(21))
            """;

        Assert.Equal("True\n42\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Path.Combine(AppContext.BaseDirectory, "Issue1410_" + Guid.NewGuid().ToString("N"));
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
