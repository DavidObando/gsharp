// <copyright file="Issue700SmartCastEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #700 / ADR-0069 — Kotlin-style smart cast emit coverage. Each
/// test compiles via in-process <c>gsc</c>, IL-verifies the emitted PE
/// (so the inserted <c>castclass</c>/<c>unbox.any</c> for narrowed
/// reads is well-formed), and runs the assembly under <c>dotnet exec</c>,
/// asserting captured stdout.
/// </summary>
public class Issue700SmartCastEmitTests
{
    private const string AnimalHierarchy = """
        package Test
        import System

        open class Animal {
            var Name string
            open func Describe() string { return Name }
        }

        class Dog : Animal {
            override func Describe() string { return Name + " (dog)" }
            func Bark() string { return Name + ":woof" }
        }

        class Cat : Animal {
            override func Describe() string { return Name + " (cat)" }
            func Purr() string { return Name + ":purr" }
        }

        """;

    [Fact]
    public void SmartCast_If_IsTest_CallsDerivedMethodInThenBranch()
    {
        var source = AnimalHierarchy + """
            func Run(a Animal) {
                if a is Dog {
                    Console.WriteLine(a.Bark())
                } else {
                    Console.WriteLine("not dog")
                }
            }

            Run(Dog{Name: "Rex"})
            Run(Cat{Name: "Whiskers"})
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Rex:woof\nnot dog\n", output);
    }

    [Fact]
    public void SmartCast_If_NegatedIsTest_CallsDerivedMethodAfterEarlyExit()
    {
        var source = AnimalHierarchy + """
            func Run(a Animal) {
                if a !is Dog {
                    Console.WriteLine("skipped")
                    return
                }

                Console.WriteLine(a.Bark())
            }

            Run(Dog{Name: "Rex"})
            Run(Cat{Name: "Whiskers"})
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Rex:woof\nskipped\n", output);
    }

    [Fact]
    public void SmartCast_If_AndChain_NarrowsRhsAndThenBranch()
    {
        var source = AnimalHierarchy + """
            func IsRex(d Dog) bool {
                return d.Name == "Rex"
            }

            func Run(a Animal) {
                if a is Dog && IsRex(a) {
                    Console.WriteLine(a.Bark())
                } else {
                    Console.WriteLine("no")
                }
            }

            Run(Dog{Name: "Rex"})
            Run(Dog{Name: "Buddy"})
            Run(Cat{Name: "Whiskers"})
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Rex:woof\nno\nno\n", output);
    }

    [Fact]
    public void SmartCast_If_NestedIsTest_NarrowsFurtherInsideInnerBlock()
    {
        var source = """
            package Test
            import System

            open class A {
                var Tag string
                open func Kind() string { return "A" }
            }

            open class B : A {
                override open func Kind() string { return "B" }
                func OnB() string { return Tag + ":B" }
            }

            class C : B {
                override func Kind() string { return "C" }
                func OnC() string { return Tag + ":C" }
            }

            func Run(a A) {
                if a is B {
                    if a is C {
                        Console.WriteLine(a.OnC())
                    } else {
                        Console.WriteLine(a.OnB())
                    }
                }
            }

            Run(C{Tag: "x"})
            Run(B{Tag: "y"})
            """;

        var output = CompileAndRun(source);
        Assert.Equal("x:C\ny:B\n", output);
    }

    [Fact]
    public void SmartCast_If_EarlyExit_ThenIsTest_NarrowsAcrossStatements()
    {
        var source = AnimalHierarchy + """
            func Run(a Animal) {
                if a !is Dog {
                    Console.WriteLine("not a dog")
                    return
                }

                // `a` is now `Dog` for the rest of the function. Both
                // statements should narrow the same parameter.
                Console.WriteLine(a.Bark())
                Console.WriteLine(a.Describe())
            }

            Run(Dog{Name: "Rex"})
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Rex:woof\nRex (dog)\n", output);
    }

    [Fact]
    public void SmartCast_If_IsTest_OnInterfaceReceiver_DispatchesAtNarrowedType()
    {
        // Narrowing from interface to a concrete implementation: after
        // `if a is Dog`, the call goes through `Dog`'s vtable rather
        // than through the interface dispatch.
        var source = """
            package Test
            import System

            interface Speaker {
                func Describe() string;
            }

            open class Animal {
                var Name string
                open func Describe() string { return Name }
            }

            class Dog : Animal {
                override func Describe() string { return Name + " (dog)" }
                func Bark() string { return Name + ":woof" }
            }

            func Run(s Animal) {
                if s is Dog {
                    Console.WriteLine(s.Bark())
                }
            }

            Run(Dog{Name: "Rex"})
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Rex:woof\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue700_").FullName;
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
