// <copyright file="Issue1133OutVarScopeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1133: an inline <c>out var n</c> / <c>out let n</c> declaration on a
/// call to a user-defined <em>instance</em> method (e.g.
/// <c>this.G(out var n)</c> via implicit <c>this</c>) must leak the new local
/// into the ENCLOSING block scope — like C# — so it is usable by later
/// statements. Previously the local was accepted at the call site but a
/// subsequent use failed with GS0125 ("Variable doesn't exist") because the
/// re-bind (after overload resolution) never declared it. These end-to-end
/// tests confirm the leaked local both binds and receives the value at runtime.
/// </summary>
public class Issue1133OutVarScopeEmitTests
{
    [Fact]
    public void InstanceMethod_OutVar_LeaksToEnclosingScope_AndReceivesValue()
    {
        var source = """
            package P
            import System

            class C {
                func G(out x int32) {
                    x = 5
                }

                public func F() int32 {
                    G(out var y)
                    return y
                }
            }

            let c = C{ }
            Console.WriteLine(c.F())
            """;

        Assert.Equal("5\n", CompileAndRun(source));
    }

    [Fact]
    public void InstanceMethod_OutLet_ReadAfterCall()
    {
        var source = """
            package P
            import System

            class C {
                func G(out x int32) {
                    x = 11
                }

                public func F() int32 {
                    G(out let y)
                    return y
                }
            }

            let c = C{ }
            Console.WriteLine(c.F())
            """;

        Assert.Equal("11\n", CompileAndRun(source));
    }

    [Fact]
    public void InstanceMethod_OutVar_ReassignedThenUsed()
    {
        var source = """
            package P
            import System

            class C {
                func G(out x int32) {
                    x = 5
                }

                public func F() int32 {
                    G(out var y)
                    y = 7
                    return y
                }
            }

            let c = C{ }
            Console.WriteLine(c.F())
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    [Fact]
    public void InstanceMethod_OutVar_UsedAsLaterCallArgument()
    {
        var source = """
            package P
            import System

            class C {
                func G(out x int32) {
                    x = 6
                }

                func H(v int32) int32 {
                    return v * 2
                }

                public func F() int32 {
                    G(out var y)
                    return H(y)
                }
            }

            let c = C{ }
            Console.WriteLine(c.F())
            """;

        Assert.Equal("12\n", CompileAndRun(source));
    }

    [Fact]
    public void InstanceMethod_OutDiscard_Binds()
    {
        var source = """
            package P
            import System

            class C {
                func G(out x int32) {
                    x = 5
                }

                public func F() int32 {
                    G(out _)
                    return 0
                }
            }

            let c = C{ }
            Console.WriteLine(c.F())
            """;

        Assert.Equal("0\n", CompileAndRun(source));
    }

    [Fact]
    public void ExplicitReceiverInstanceMethod_OutVar_LeaksToEnclosingScope()
    {
        var source = """
            package P
            import System

            class C {
                public func G(out x int32) {
                    x = 9
                }
            }

            let c = C{ }
            c.G(out var y)
            Console.WriteLine(y)
            """;

        Assert.Equal("9\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1133_emit_").FullName;
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
