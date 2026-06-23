// <copyright file="Issue991WhenGuardEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #991 — `when` guards on switch arms. Each test compiles via the
/// in-process <c>gsc</c>, IL-verifies the emitted PE (so the inserted
/// guard branch is well-formed), and runs the assembly under
/// <c>dotnet exec</c>, asserting captured stdout.
/// </summary>
public class Issue991WhenGuardEmitTests
{
    [Fact]
    public void SwitchExpression_WhenGuard_ClassifySample()
    {
        var source = """
            package T
            import System
            func classify(n int32) string {
                return switch n {
                    case > 0 when n < 10: "small"
                    case > 0: "big"
                    default: "nonpositive"
                }
            }
            Console.WriteLine(classify(5))
            Console.WriteLine(classify(50))
            Console.WriteLine(classify(-1))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("small\nbig\nnonpositive\n", output);
    }

    [Fact]
    public void SwitchStatement_WhenGuard_ClassifySample()
    {
        var source = """
            package T
            import System
            func describe(n int32) {
                switch n {
                case > 0 when n < 10 { Console.WriteLine("small") }
                case > 0 { Console.WriteLine("big") }
                default { Console.WriteLine("nonpositive") }
                }
            }
            describe(5)
            describe(50)
            describe(-1)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("small\nbig\nnonpositive\n", output);
    }

    [Fact]
    public void SwitchExpression_WhenGuard_WithTypePatternSmartCast()
    {
        // The guard observes the pattern-narrowed discriminant (`a` is `Dog`
        // inside the `is Dog` arm, so `a.Bark()` resolves to Dog's method).
        var source = """
            package T
            import System

            open class Animal {
                var Name string
                open func Describe() string { return Name }
            }
            class Dog : Animal {
                func Bark() string { return Name + ":woof" }
            }
            class Cat : Animal {
                func Purr() string { return Name + ":purr" }
            }

            func classify(a Animal) string {
                return switch a {
                    case d is Dog when a.Bark() == "Rex:woof": "the famous Rex"
                    case d is Dog: d.Bark()
                    case c is Cat: c.Purr()
                    default: a.Describe()
                }
            }

            Console.WriteLine(classify(Dog{Name: "Rex"}))
            Console.WriteLine(classify(Dog{Name: "Buddy"}))
            Console.WriteLine(classify(Cat{Name: "Whiskers"}))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("the famous Rex\nBuddy:woof\nWhiskers:purr\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue991_").FullName;
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
