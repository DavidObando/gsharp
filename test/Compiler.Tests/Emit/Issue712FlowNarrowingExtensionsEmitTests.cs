// <copyright file="Issue712FlowNarrowingExtensionsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #712 / ADR-0069 addendum — flow-narrowing extensions across
/// <c>||</c> short-circuit (De Morgan dual of <c>&amp;&amp;</c>) and
/// <c>switch</c> arm discriminator narrowing (in-arm and post-switch).
/// Each test compiles via in-process <c>gsc</c>, IL-verifies the emitted
/// PE (so the inserted <c>castclass</c> for narrowed reads is well-
/// formed), and runs the assembly under <c>dotnet exec</c>.
/// </summary>
public class Issue712FlowNarrowingExtensionsEmitTests
{
    private const string AnimalHierarchy = """
        package Test
        import System

        type Animal open class {
            var Name string
            open func Describe() string { return Name }
        }

        type Dog class : Animal {
            override func Describe() string { return Name + " (dog)" }
            func Bark() string { return Name + ":woof" }
        }

        type Cat class : Animal {
            override func Describe() string { return Name + " (cat)" }
            func Purr() string { return Name + ":purr" }
        }

        """;

    [Fact]
    public void Or_ElseBranch_OfNegatedIsTest_CallsDerivedMethod()
    {
        var source = AnimalHierarchy + """
            func Run(a Animal, flag bool) {
                if !(a is Dog) || flag {
                    Console.WriteLine("skipped")
                } else {
                    Console.WriteLine(a.Bark())
                }
            }

            Run(Dog{Name: "Rex"}, false)
            Run(Dog{Name: "Rex"}, true)
            Run(Cat{Name: "Whiskers"}, false)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Rex:woof\nskipped\nskipped\n", output);
    }

    [Fact]
    public void Or_GuardStyle_BangIsTest_LiftsNarrowingAfterExit()
    {
        var source = AnimalHierarchy + """
            func Run(a Animal, force bool) {
                if a !is Dog || force {
                    Console.WriteLine("skipped")
                    return
                }

                Console.WriteLine(a.Bark())
                Console.WriteLine(a.Describe())
            }

            Run(Dog{Name: "Rex"}, false)
            Run(Dog{Name: "Rex"}, true)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Rex:woof\nRex (dog)\nskipped\n", output);
    }

    [Fact]
    public void Or_RightOperand_OfNegatedIsTest_BindsAtNarrowedType()
    {
        var source = AnimalHierarchy + """
            func Run(a Animal) bool {
                return !(a is Dog) || a.Bark() != ""
            }

            Console.WriteLine(Run(Dog{Name: "Rex"}))
            Console.WriteLine(Run(Cat{Name: "Whiskers"}))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nTrue\n", output);
    }

    [Fact]
    public void Or_NilGuard_PostIfLift_NarrowsToNonNullable()
    {
        // ADR-0069 + issue #712: the guard-style early-exit composes through
        // `||` so the post-if region observes both `s != nil` AND `!force`.
        // (We use the post-if lift form instead of an `else` block because the
        // existing nil-guard ELSE-branch IL emission has a pre-existing bug —
        // see ADR-0069 issue #735 follow-up — and that bug is unrelated to
        // the `||` composition exercised here.)
        var source = """
            package Test
            import System

            func Length(s string?, force bool) int32 {
                if s == nil || force {
                    return -1
                }
                return s.Length
            }

            Console.WriteLine(Length("hello", false))
            Console.WriteLine(Length("hello", true))
            Console.WriteLine(Length(nil, false))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n-1\n-1\n", output);
    }

    [Fact]
    public void Switch_TypePattern_CallsDerivedMethodViaDiscriminator()
    {
        var source = AnimalHierarchy + """
            func Run(a Animal) {
                switch a {
                    case d is Dog { Console.WriteLine(a.Bark()) }
                    case c is Cat { Console.WriteLine(a.Purr()) }
                    default { Console.WriteLine("other") }
                }
            }

            Run(Dog{Name: "Rex"})
            Run(Cat{Name: "Whiskers"})
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Rex:woof\nWhiskers:purr\n", output);
    }

    [Fact]
    public void Switch_PostSwitch_LiftsCommonNarrowing()
    {
        var source = AnimalHierarchy + """
            func Run(a Animal) {
                switch a {
                    case c is Cat {
                        return
                    }
                    case d is Dog {
                        Console.WriteLine("matched dog")
                    }
                    default {
                        return
                    }
                }
                Console.WriteLine(a.Bark())
            }

            Run(Dog{Name: "Rex"})
            Run(Cat{Name: "Whiskers"})
            """;

        var output = CompileAndRun(source);
        Assert.Equal("matched dog\nRex:woof\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue712_").FullName;
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
