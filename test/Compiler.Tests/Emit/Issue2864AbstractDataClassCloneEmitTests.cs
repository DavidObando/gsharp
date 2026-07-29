// <copyright file="Issue2864AbstractDataClassCloneEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2864 — <c>DataStructSynthesizer.EmitDataClassClone</c> gave every
/// data class a <c>&lt;Clone&gt;$</c> whose body is
/// <c>ldarg.0; newobj &lt;copy ctor&gt;; ret</c>. A data class is ABSTRACT when
/// its effective member set still contains a no-body <c>open</c> member
/// (<c>StructSymbol.IsAbstract</c>, #987), and <c>newobj</c> of an abstract
/// type is rejected by ilverify with <c>NewobjAbstractClass</c>.
/// <para>
/// <c>&lt;Clone&gt;$</c> exists purely for C# record shape compatibility and
/// has no consumer inside gsc (G# has no <c>with</c> expression), so it is now
/// omitted on an abstract data class. The matching MethodDef row reservation in
/// <c>ReflectionMetadataEmitter.PlanClassMethods</c> must skip the same row —
/// these facts pin that alignment, since a stale reservation silently shifts
/// every later method token in the type.
/// </para>
/// </summary>
public class Issue2864AbstractDataClassCloneEmitTests
{
    [Fact]
    public void AbstractDataClassWithConcreteDerived_VerifiesAndRuns()
    {
        const string source = """
            package i2864a

            open data class Base {
                open prop Kind string {
                    get;
                }
            }

            open data class Derived(Value int32) : Base {
                open override prop Kind string -> "derived"
            }

            func Main() {
                let d = Derived(7)
                System.Console.WriteLine(d.Kind + ":" + d.Value.ToString())
            }
            """;

        Assert.Equal("derived:7\n", CompileAndRun(source));
    }

    [Fact]
    public void AbstractDataClassWithUserMethods_KeepsMethodTokensAligned()
    {
        // The reservation fix is the risky half: omitting the `<Clone>$` row
        // without shrinking PlanClassMethods' reservation shifts every later
        // MethodDef token in the type, which corrupts unrelated call sites
        // rather than failing loudly.
        const string source = """
            package i2864b

            open data class Shape {
                open prop Name string {
                    get;
                }

                func Describe() string -> "shape:" + this.Name

                func Twice() string -> this.Describe() + "/" + this.Describe()
            }

            open data class Square(Side int32) : Shape {
                open override prop Name string -> "square"

                func Area() int32 -> this.Side * this.Side
            }

            func Main() {
                let s = Square(4)
                System.Console.WriteLine(s.Twice() + "|" + s.Area().ToString())
            }
            """;

        Assert.Equal("shape:square/shape:square|16\n", CompileAndRun(source));
    }

    [Fact]
    public void AbstractDataClassWithUserToStringOverride_ComposesWithExistingSkips()
    {
        // Issue #2361 already removes one reserved row for a hand-written
        // ToString; the new abstract skip must compose with it rather than
        // replace it.
        const string source = """
            package i2864c

            open data class Base {
                open prop Kind string {
                    get;
                }

                func Describe() string -> "kind=" + this.Kind

                open override func ToString() string -> "base<" + this.Kind + ">"

                func Shout() string -> this.Describe() + "!"
            }

            open data class Leaf(Id int32) : Base {
                open override prop Kind string -> "leaf"
            }

            func Main() {
                let l = Leaf(3)
                System.Console.WriteLine(l.Shout() + "|" + l.ToString() + "|" + l.Id.ToString())
            }
            """;

        // `Leaf` synthesizes its OWN ToString, which overrides the base's
        // hand-written one — that is ordinary data-class behaviour. What
        // matters here is that `Base` reserves 10 - 1 (ToString) - 1 (Clone)
        // rows, so `Describe` and `Shout` still resolve to the right tokens.
        Assert.Equal("kind=leaf!|Leaf(Id=3)|3\n", CompileAndRun(source));
    }

    [Fact]
    public void ConcreteDataClass_StillEmitsWorkingSynthesizedMembers()
    {
        // Control: a data class that is NOT abstract keeps every synthesized
        // member, including `<Clone>$`, and its rows stay aligned.
        const string source = """
            package i2864d

            open data class Point(X int32, Y int32) {
                func Sum() int32 -> this.X + this.Y
            }

            func Main() {
                let p = Point(2, 5)
                System.Console.WriteLine(p.Sum().ToString() + "|" + p.ToString())
            }
            """;

        var output = CompileAndRun(source);
        Assert.StartsWith("7|", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2864_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            Compile(new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            });

            IlVerifier.Verify(dllPath);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
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
            catch (IOException)
            {
            }
        }
    }

    private static void Compile(string[] args)
    {
        using var stdoutWriter = new StringWriter();
        using var stderrWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(stdoutWriter);
        Console.SetError(stderrWriter);
        int compileExit;
        try
        {
            compileExit = Program.Main(args);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");
    }
}
