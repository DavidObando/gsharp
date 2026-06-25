// <copyright file="Issue1123AssignmentSmartCastEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1123 — Kotlin-style assignment smart cast emit coverage. After a
/// nullable local is assigned a statically non-null reference value, a
/// subsequent member access binds and emits against the assigned value's
/// non-null (possibly more-derived) type. Each test compiles via in-process
/// <c>gsc</c>, IL-verifies the emitted PE (so the narrowed read's
/// <c>castclass</c>/no-op is well-formed), and runs it under
/// <c>dotnet exec</c>, asserting captured stdout.
/// </summary>
public class Issue1123AssignmentSmartCastEmitTests
{
    private const string Hierarchy = """
        package Test
        import System

        class E { func M() int32 { return 42 } }

        open class Animal {
            var Name string
            open func Describe() string { return Name }
        }

        class Dog : Animal {
            override func Describe() string { return Name + " (dog)" }
            func Bark() string { return Name + ":woof" }
        }

        """;

    [Fact]
    public void AssignmentSmartCast_NarrowsNullableLocalToNonNull_AndRuns()
    {
        var source = Hierarchy + """
            func Run(fresh E) int32 {
                var x E? = nil
                x = fresh
                return x.M()
            }

            Console.WriteLine(Run(E{}))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void AssignmentSmartCast_NarrowsToAssignedDerivedType_CallsDerivedMember()
    {
        // Kotlin narrows to the assigned value's static type: assigning a `Dog`
        // to an `Animal?` local lets the `Dog`-only `Bark()` bind and emit.
        var source = Hierarchy + """
            func Run(d Dog) string {
                var a Animal? = nil
                a = d
                return a.Bark()
            }

            Console.WriteLine(Run(Dog{Name: "Rex"}))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Rex:woof\n", output);
    }

    [Fact]
    public void AssignmentSmartCast_NarrowingReachesIntoNestedBlock()
    {
        var source = Hierarchy + """
            func Run(fresh E, flag bool) int32 {
                var x E? = nil
                x = fresh
                if flag {
                    return x.M()
                }
                return 0
            }

            Console.WriteLine(Run(E{}, true))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1123_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
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

            Assert.True(
                compileExit == 0,
                $"gsc failed (exit {compileExit}):\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

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

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"sample exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
