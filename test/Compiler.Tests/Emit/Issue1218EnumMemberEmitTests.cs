// <copyright file="Issue1218EnumMemberEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1218: inherited System.Enum / System.ValueType / System.Object
/// instance members must emit and run on enum values. An enum is a CLR value
/// type whose base chain is System.Enum -&gt; System.ValueType -&gt;
/// System.Object, so its inherited members (Enum.HasFlag,
/// Object/ValueType ToString / GetHashCode / Equals, Object.GetType) resolve to
/// real CLR MethodInfos. The value-type receiver is boxed before the
/// <c>callvirt</c>; for HasFlag the enum argument is additionally boxed to
/// System.Enum. These tests compile a program that exercises each member,
/// statically verify the IL, and assert the runtime output. G# enums get
/// sequential values (Red=0, Green=1, Blue=2) with no explicit-value or
/// <c>[Flags]</c> syntax, so HasFlag is exercised with single-flag equality
/// semantics (Green.HasFlag(Green) is true, Green.HasFlag(Blue) is false).
/// </summary>
public class Issue1218EnumMemberEmitTests
{
    [Fact]
    public void EnumReceiver_HasFlag_BoxesArgumentAndRuns()
    {
        var source = """
            package P
            import System

            enum Color { Red, Green, Blue }

            Console.WriteLine(Color.Green.HasFlag(Color.Green))
            Console.WriteLine(Color.Green.HasFlag(Color.Blue))
            Console.WriteLine(Color.Blue.HasFlag(Color.Green))
            """;

        Assert.Equal("True\nFalse\nFalse\n", CompileAndRun(source));
    }

    [Fact]
    public void EnumReceiver_ToStringAndGetType_BoxAndRun()
    {
        var source = """
            package P
            import System

            enum Color { Red, Green, Blue }

            Console.WriteLine(Color.Green.ToString())
            Console.WriteLine(Color.Green.GetType().Name)
            """;

        Assert.Equal("Green\nColor\n", CompileAndRun(source));
    }

    [Fact]
    public void EnumReceiver_EqualsAndGetHashCode_BoxAndRun()
    {
        var source = """
            package P
            import System

            enum Color { Red, Green, Blue }

            Console.WriteLine(Color.Green.Equals(Color.Green))
            Console.WriteLine(Color.Green.Equals(Color.Blue))
            Console.WriteLine(Color.Green.GetHashCode() == Color.Green.GetHashCode())
            Console.WriteLine(Color.Green.GetHashCode() == Color.Blue.GetHashCode())
            """;

        Assert.Equal("True\nFalse\nTrue\nFalse\n", CompileAndRun(source));
    }

    [Fact]
    public void EnumReceiver_HasFlagThroughClassMethod_EmitsAndRuns()
    {
        // Mirrors the original repro from issue #1218: HasFlag invoked through a
        // class method whose parameter is the enum type. Verifies the binder
        // resolves the inherited member on a parameter-typed receiver (not only
        // on a `Type.Member` literal) and that it emits and runs.
        var source = """
            package P
            import System

            enum Color { Red, Green, Blue }

            class C {
                func Test(a Color, b Color) bool {
                    return a.HasFlag(b)
                }
            }

            let c = C{ }
            Console.WriteLine(c.Test(Color.Blue, Color.Blue))
            Console.WriteLine(c.Test(Color.Blue, Color.Green))
            """;

        Assert.Equal("True\nFalse\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1218_emit_").FullName;
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

            // (a) Static verification: the emitted IL must be valid.
            IlVerifier.Verify(outPath);

            // (b) Dynamic verification: the emitted code must execute.
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
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
