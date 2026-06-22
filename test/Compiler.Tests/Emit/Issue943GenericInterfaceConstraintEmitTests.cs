// <copyright file="Issue943GenericInterfaceConstraintEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #943 end-to-end coverage: a type-parameter constraint that names a
/// constructed generic CLR interface — e.g. <c>func Max[T IComparable[T]](...)</c>
/// — now parses, binds (so instance members of the constrained interface are
/// available on values of <c>T</c>), and emits verifiable IL with a
/// <c>constrained.</c>-prefixed <c>callvirt</c> plus a matching
/// <c>GenericParamConstraint</c> row. These tests round-trip each scenario
/// through compile → IL-verify → run, and assert the constraint is actually
/// enforced (a non-satisfying type argument is a binding error, GS0152).
/// </summary>
public class Issue943GenericInterfaceConstraintEmitTests
{
    [Fact]
    public void Max_With_IComparableConstraint_Roundtrips_Int32()
    {
        var source = """
            package P
            import System

            func Max[T IComparable[T]](a T, b T) T {
                if a.CompareTo(b) > 0 { return a }
                return b
            }

            Console.WriteLine(Max[int32](3, 7))
            Console.WriteLine(Max[int32](10, 2))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n10\n", output);
    }

    [Fact]
    public void Max_With_IComparableConstraint_Roundtrips_String()
    {
        var source = """
            package P
            import System

            func Max[T IComparable[T]](a T, b T) T {
                if a.CompareTo(b) > 0 { return a }
                return b
            }

            Console.WriteLine(Max[string]("apple", "banana"))
            Console.WriteLine(Max[string]("zebra", "yak"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("banana\nzebra\n", output);
    }

    [Fact]
    public void AreEqual_With_IEquatableConstraint_Roundtrips()
    {
        var source = """
            package P
            import System

            func AreEqual[T IEquatable[T]](a T, b T) bool {
                return a.Equals(b)
            }

            Console.WriteLine(AreEqual[int32](5, 5))
            Console.WriteLine(AreEqual[int32](5, 6))
            Console.WriteLine(AreEqual[string]("hi", "hi"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\nTrue\n", output);
    }

    [Fact]
    public void Max_With_NonComparableTypeArgument_IsBindingError()
    {
        var source = """
            package P
            import System

            struct Box {
                var value int32
            }

            func Max[T IComparable[T]](a T, b T) T {
                if a.CompareTo(b) > 0 { return a }
                return b
            }

            var x = Box{value: 1}
            var y = Box{value: 2}
            var z = Max[Box](x, y)
            """;

        var diagnostics = CompileExpectingFailure(source);
        Assert.Contains("GS0152", diagnostics);
        Assert.Contains("does not satisfy", diagnostics);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue943_emit_").FullName;
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
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // Best-effort cleanup; ignore.
            }
        }
    }

    private static string CompileExpectingFailure(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue943_err_").FullName;
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

            var combined = compileOut.ToString() + compileErr.ToString();
            Assert.True(compileExit != 0, $"expected compile to fail but it succeeded: {combined}");
            return combined;
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // Best-effort cleanup; ignore.
            }
        }
    }
}
