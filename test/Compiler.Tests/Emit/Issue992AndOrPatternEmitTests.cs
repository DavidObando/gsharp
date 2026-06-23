// <copyright file="Issue992AndOrPatternEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #992 — `and` / `or` / `not` pattern combinators on switch arms. Each
/// test compiles via the in-process <c>gsc</c>, IL-verifies the emitted PE (so
/// the combinator branch wiring is well-formed), and runs the assembly under
/// <c>dotnet exec</c>, asserting captured stdout.
/// </summary>
public class Issue992AndOrPatternEmitTests
{
    [Fact]
    public void SwitchExpression_AndOr_ClassifySample()
    {
        var source = """
            package T
            import System
            func classify(n int32) string {
                return switch n {
                    case > 0 and < 10: "small-positive"
                    case < 0 or > 100: "extreme"
                    default: "other"
                }
            }
            Console.WriteLine(classify(5))
            Console.WriteLine(classify(-5))
            Console.WriteLine(classify(200))
            Console.WriteLine(classify(50))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("small-positive\nextreme\nextreme\nother\n", output);
    }

    [Fact]
    public void SwitchExpression_CombinatorPrecedence_AndBindsTighterThanOr()
    {
        // `== 0 or > 5 and < 10` parses as `(== 0) or ((> 5) and (< 10))`.
        var source = """
            package T
            import System
            func f(n int32) string {
                return switch n {
                    case == 0 or > 5 and < 10: "A"
                    default: "C"
                }
            }
            Console.WriteLine(f(0))
            Console.WriteLine(f(7))
            Console.WriteLine(f(3))
            Console.WriteLine(f(100))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("A\nA\nC\nC\n", output);
    }

    [Fact]
    public void SwitchExpression_NotPattern_Negates()
    {
        var source = """
            package T
            import System
            func f(n int32) string {
                return switch n {
                    case not > 0: "nonpositive"
                    default: "positive"
                }
            }
            Console.WriteLine(f(-2))
            Console.WriteLine(f(0))
            Console.WriteLine(f(5))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("nonpositive\nnonpositive\npositive\n", output);
    }

    [Fact]
    public void SwitchExpression_ParenthesizedPattern_OverridesPrecedence()
    {
        // `(== 0 or == 1) and not == 0` matches exactly 1.
        var source = """
            package T
            import System
            func f(n int32) string {
                return switch n {
                    case (== 0 or == 1) and not == 0: "one"
                    default: "other"
                }
            }
            Console.WriteLine(f(0))
            Console.WriteLine(f(1))
            Console.WriteLine(f(2))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("other\none\nother\n", output);
    }

    [Fact]
    public void SwitchExpression_TypePatternUnderAnd_SmartCastNarrows()
    {
        // Under `and`, the discriminant is narrowed by the type sub-pattern, so
        // `a.Bark()` resolves against the narrowed `Dog` type in the arm body.
        // The `{ Name: ... }` sub-pattern binds against the discriminant type
        // (Animal), which declares `Name`.
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

            func classify(a Animal) string {
                return switch a {
                    case d is Dog and { Name: "Rex" }: a.Bark()
                    case d is Dog: "other dog"
                    default: a.Describe()
                }
            }

            Console.WriteLine(classify(Dog{Name: "Rex"}))
            Console.WriteLine(classify(Dog{Name: "Buddy"}))
            Console.WriteLine(classify(Animal{Name: "Generic"}))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Rex:woof\nother dog\nGeneric\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue992_").FullName;
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
