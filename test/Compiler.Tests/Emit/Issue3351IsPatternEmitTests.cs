// <copyright file="Issue3351IsPatternEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Runtime and IL verification for boolean pattern <c>is</c> expressions.</summary>
public sealed class Issue3351IsPatternEmitTests
{
    [Fact]
    public void ValueTypeAndNotNil_AfterTypeNarrowing_IsAlwaysTrue()
    {
        const string Source = """
            package Issue3351.NotNil
            import System

            func Match(value object) bool {
                return value is int32 and not nil
            }

            Console.WriteLine(Match(0))
            Console.WriteLine(Match(42))
            Console.WriteLine(Match("not an int"))
            """;

        var result = CompileAndRun(Source);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal(
            $"True{Environment.NewLine}True{Environment.NewLine}False{Environment.NewLine}",
            result.Stdout);
    }

    [Fact]
    public void FullPatternMatrix_AndSwitchNarrowing_VerifiesAndRuns()
    {
        const string Source = """
            package Issue3351
            import System
            import System.Threading.Tasks

            enum Color { Red, Green }

            class Box {
                prop P int32 { get; init; }
            }

            open class Animal { }
            class Dog : Animal {
                prop Name string { get; init; }
                func Bark() string { return Name + ":woof" }
            }

            class Counter {
                shared {
                    var Reads int32
                }
            }

            func Next() int32 {
                Counter.Reads += 1
                return 5
            }

            func ConstantOr(n int32) bool { return n is 1 or 2 }
            func RelationalAnd(n int32) bool { return n is > 0 and < 10 }
            func ListMatch(values []int32) bool { return values is [1, .., 3] }
            func NotMatch(n int32) bool { return n is not 5 }
            func Parenthesized(n int32) bool { return n is (1 or > 5) }
            func Property(value Box) bool { return value is { P: > 0 } }
            func Nested(n int32) bool { return n is (1 or > 5) and not 9 }
            func NilTest(value object?) bool { return value is nil }
            func TypeTest(value object?) bool { return value is string }
            func TypeAndNil(value object?) bool { return value is string and not nil }
            func ArrayType(value object) bool { return value is []int32 }

            async func AsyncPattern(n int32) bool {
                await Task.Yield()
                return n is > 0 and < 10
            }

            func TypeProperty(value object) int32 {
                if value is string { Length: > 0 } {
                    return value.Length
                }
                return -1
            }

            func DirectSwitch(value Animal) string {
                return switch value {
                    case Dog { Name: "Rex" }: value.Bark()
                    default: "miss"
                }
            }

            func AndSwitch(value Animal) string {
                return switch value {
                    case Dog and { Name: "Rex" }: value.Bark()
                    default: "miss"
                }
            }

            func StatementSwitch(value Animal) string {
                var result = "miss"
                switch value {
                    case Dog { Name: "Rex" } { result = value.Bark() }
                    default { }
                }
                return result
            }

            const limit = 5
            const string = 5
            let bookended = []int32{1, 2, 3}
            let short = []int32{1, 2}
            let red = Color.Red

            Console.WriteLine(ConstantOr(2))
            Console.WriteLine(ConstantOr(3))
            Console.WriteLine(RelationalAnd(5))
            Console.WriteLine(RelationalAnd(15))
            Console.WriteLine(ListMatch(bookended))
            Console.WriteLine(ListMatch(short))
            Console.WriteLine(NotMatch(4))
            Console.WriteLine(NotMatch(5))
            Console.WriteLine(5 !is 6 or 7)
            Console.WriteLine(Parenthesized(7))
            Console.WriteLine(Property(Box{P: 1}))
            Console.WriteLine(Property(Box{P: 0}))
            Console.WriteLine(TypeProperty("hello"))
            Console.WriteLine(TypeProperty(42))
            Console.WriteLine(Nested(7))
            Console.WriteLine(Nested(9))
            Console.WriteLine(NilTest(nil))
            Console.WriteLine(NilTest("x"))
            Console.WriteLine(TypeTest("x"))
            Console.WriteLine(TypeTest(42))
            Console.WriteLine(TypeAndNil("x"))
            Console.WriteLine(TypeAndNil(42))
            Console.WriteLine(ArrayType(bookended))
            Console.WriteLine(ArrayType("x"))
            Console.WriteLine(AsyncPattern(5).Result)
            Console.WriteLine(Next() is > 0 and < 10)
            Console.WriteLine(Counter.Reads)
            Console.WriteLine(DirectSwitch(Dog{Name: "Rex"}))
            Console.WriteLine(DirectSwitch(Animal{}))
            Console.WriteLine(AndSwitch(Dog{Name: "Rex"}))
            Console.WriteLine(AndSwitch(Dog{Name: "Buddy"}))
            Console.WriteLine(StatementSwitch(Dog{Name: "Rex"}))
            Console.WriteLine(StatementSwitch(Animal{}))
            Console.WriteLine(switch red { case Color.Red: "red" case Color.Green: "green" default: "other" })
            Console.WriteLine(switch 5 { case limit: "limit" default: "other" })
            Console.WriteLine(Color.Red is Color.Red)
            Console.WriteLine(5 is limit)
            Console.WriteLine(switch 5 { case string: "collision-constant" default: "other" })
            Console.WriteLine("hello" is string)
            Console.WriteLine(5 is == string)
            """;

        var result = CompileAndRun(Source);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal(
            string.Join(Environment.NewLine,
            [
                "True",
                "False",
                "True",
                "False",
                "True",
                "False",
                "True",
                "False",
                "True",
                "True",
                "True",
                "False",
                "5",
                "-1",
                "True",
                "False",
                "True",
                "False",
                "True",
                "False",
                "True",
                "False",
                "True",
                "False",
                "True",
                "True",
                "1",
                "Rex:woof",
                "miss",
                "Rex:woof",
                "miss",
                "Rex:woof",
                "miss",
                "red",
                "limit",
                "True",
                "True",
                "collision-constant",
                "True",
                "True",
                string.Empty,
            ]),
            result.Stdout);
    }

    private static (int ExitCode, string Stdout) CompileAndRun(string source)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue3351IsPatternEmitTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var previousOut = Console.Out;
            var previousErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExitCode;
            try
            {
                compileExitCode = Program.Main(
                [
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100,GS0286",
                    sourcePath,
                ]);
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousErr);
            }

            Assert.True(
                compileExitCode == 0,
                $"gsc failed (exit {compileExitCode}):\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
            IlVerifier.Verify(outputPath);

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add("--runtimeconfig");
            startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"));
            startInfo.ArgumentList.Add(outputPath);

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Failed to start dotnet exec.");
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
            Assert.True(
                process.ExitCode == 0,
                $"sample exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
            return (process.ExitCode, stdout.ReplaceLineEndings(Environment.NewLine));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
