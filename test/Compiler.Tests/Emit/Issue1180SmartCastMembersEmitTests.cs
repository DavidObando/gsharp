// <copyright file="Issue1180SmartCastMembersEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1180 / ADR-0069 — Kotlin-style smart cast emit coverage for
/// stable member-access paths. Each test compiles via in-process
/// <c>gsc</c>, IL-verifies the emitted PE (so the inserted
/// <c>castclass</c>/<c>unbox.any</c> for narrowed member reads is
/// well-formed), and runs the assembly under <c>dotnet exec</c>,
/// asserting captured stdout.
/// </summary>
public class Issue1180SmartCastMembersEmitTests
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
    public void SmartCast_StableInitOnlyProperty_NarrowsMemberReadInThenBranch()
    {
        var source = AnimalHierarchy + """
            class Box {
                prop Pet Animal { get; init; }
            }

            func Run(b Box) {
                if b.Pet is Dog {
                    Console.WriteLine(b.Pet.Bark())
                } else {
                    Console.WriteLine("not dog")
                }
            }

            Run(Box() { Pet = Dog{Name: "Rex"} })
            Run(Box() { Pet = Cat{Name: "Whiskers"} })
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Rex:woof\nnot dog\n", output);
    }

    [Fact]
    public void SmartCast_DeepStableChain_NarrowsNestedMemberRead()
    {
        var source = AnimalHierarchy + """
            class Inner {
                prop Pet Animal { get; init; }
            }

            class Outer {
                prop Box Inner { get; init; }
            }

            func Run(o Outer) {
                if o.Box.Pet is Dog {
                    Console.WriteLine(o.Box.Pet.Bark())
                } else {
                    Console.WriteLine("not dog")
                }
            }

            Run(Outer() { Box = Inner() { Pet = Dog{Name: "Rex"} } })
            Run(Outer() { Box = Inner() { Pet = Cat{Name: "Whiskers"} } })
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Rex:woof\nnot dog\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1180_").FullName;
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
