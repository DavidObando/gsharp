// <copyright file="Issue2863ImportedOverrideEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2863 — <c>ClrTypeUtilities.SafeIsOverride</c> probed
/// <c>MethodInfo.GetBaseDefinition()</c>, which <c>MetadataLoadContext</c> does
/// not implement: it throws <c>NotSupportedException</c> for EVERY method, and
/// <c>IsMetadataLoadFailure</c> classifies that as a load failure, so the
/// conservative "not an override" default was returned for every imported
/// member.
/// <para>
/// <c>PropertySymbol.IsAbstract</c> is
/// <c>IsVirtual &amp;&amp; !IsOverride &amp;&amp; !IsAutoProperty &amp;&amp; …</c>
/// and imported properties never carry body syntax, so an imported property
/// that OVERRIDES a base declaration looked abstract. That made
/// <c>StructSymbol.IsAbstract</c> mark the whole imported type abstract, and
/// every cross-assembly use site reported
/// <c>GS0386: Cannot create an instance of the abstract type</c>.
/// </para>
/// <para>
/// The override bit is now read straight out of metadata: a method that
/// introduces a new virtual slot is emitted <c>virtual newslot</c>, one that
/// overrides an inherited slot is not.
/// </para>
/// </summary>
public class Issue2863ImportedOverrideEmitTests
{
    [Fact]
    public void ImportedDataClassOverridingAbstractShapedBaseProperty_Runs()
    {
        // The exact Oahu shape: `public abstract record` translates to an
        // `open data class` with a no-body `open prop`, and the concrete
        // derived record overrides it.
        const string library = """
            package i2863lib

            open data class Base {
                open prop Kind string {
                    get;
                }
            }

            open data class Derived(Value int32) : Base {
                open override prop Kind string -> "derived"
            }
            """;

        const string source = """
            package i2863a
            import i2863lib

            func Main() {
                let d = Derived(7)
                System.Console.WriteLine(d.Kind + ":" + d.Value.ToString())
            }
            """;

        Assert.Equal($"derived:7{Environment.NewLine}", CompileAndRun(source, library, "i2863lib"));
    }

    [Fact]
    public void ImportedDataClassWithSeveralOverriddenProperties_Runs()
    {
        // Only the semantic-aggregate path (records / data classes) feeds
        // SafeIsOverride, so every load-bearing fact here uses a data class.
        const string library = """
            package i2863lib2

            open data class Shape {
                open prop Name string {
                    get;
                }

                open prop Sides int32 {
                    get;
                }
            }

            open data class Square : Shape {
                open override prop Name string -> "square"

                open override prop Sides int32 -> 4
            }
            """;

        const string source = """
            package i2863b
            import i2863lib2

            func Main() {
                let s = Square()
                System.Console.WriteLine(s.Name + ":" + s.Sides.ToString())
            }
            """;

        Assert.Equal($"square:4{Environment.NewLine}", CompileAndRun(source, library, "i2863lib2"));
    }

    [Fact]
    public void ImportedDataClassDerivedAssignedToBaseTypedLocal_DispatchesVirtually()
    {
        // The overriding property must still be virtual, so a base-typed
        // reference dispatches to the derived implementation.
        const string library = """
            package i2863lib3

            open data class Shape {
                open prop Name string {
                    get;
                }
            }

            open data class Square : Shape {
                open override prop Name string -> "square"
            }

            open data class Circle : Shape {
                open override prop Name string -> "circle"
            }
            """;

        const string source = """
            package i2863c
            import i2863lib3

            func Main() {
                let a Shape = Square()
                let b Shape = Circle()
                System.Console.WriteLine(a.Name + "," + b.Name)
            }
            """;

        Assert.Equal($"square,circle{Environment.NewLine}", CompileAndRun(source, library, "i2863lib3"));
    }

    [Fact]
    public void ImportedDataClassTwoLevelOverrideChain_UsesMostDerivedImplementation()
    {
        // A middle type that both overrides and is overridden exercises the
        // `virtual, no newslot` classification on BOTH ends of the chain.
        const string library = """
            package i2863lib4

            open data class Level0 {
                open prop Tag string {
                    get;
                }
            }

            open data class Level1 : Level0 {
                open override prop Tag string -> "one"
            }

            open data class Level2 : Level1 {
                open override prop Tag string -> "two"
            }
            """;

        const string source = """
            package i2863d
            import i2863lib4

            func Main() {
                let a Level0 = Level1()
                let b Level0 = Level2()
                System.Console.WriteLine(a.Tag + "," + b.Tag)
            }
            """;

        Assert.Equal($"one,two{Environment.NewLine}", CompileAndRun(source, library, "i2863lib4"));
    }

    [Fact]
    public void ImportedAbstractShapedDataClassBase_IsStillNotConstructible()
    {
        // Non-vacuity guard in the other direction: reading the override bit
        // from metadata must NOT make genuinely abstract imported types look
        // concrete.
        const string library = """
            package i2863lib5

            open data class Shape {
                open prop Name string {
                    get;
                }
            }

            open data class Square : Shape {
                open override prop Name string -> "square"
            }
            """;

        const string source = """
            package i2863e
            import i2863lib5

            func Main() {
                let s = Shape()
                System.Console.WriteLine(s.Name)
            }
            """;

        var diagnostics = CompileExpectingFailure(source, library, "i2863lib5");
        Assert.Contains("GS0386", diagnostics);
    }

    [Fact]
    public void ImportedNonVirtualProperty_IsUnaffected()
    {
        // Control: an ordinary sealed-shaped imported property is neither
        // virtual nor an override, and keeps working.
        const string library = """
            package i2863lib6

            class Holder(Value int32) {
                prop Doubled int32 -> Value * 2
            }
            """;

        const string source = """
            package i2863f
            import i2863lib6

            func Main() {
                let h = Holder(21)
                System.Console.WriteLine(h.Doubled.ToString())
            }
            """;

        Assert.Equal($"42{Environment.NewLine}", CompileAndRun(source, library, "i2863lib6"));
    }

    private static string CompileAndRun(string source, string library = null, string libraryAssemblyName = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2863_exe_").FullName;
        try
        {
            var dllPath = BuildExecutable(tempDir, source, library, libraryAssemblyName, out var libDll);

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

            IlVerifier.Verify(dllPath, libDll != null ? new[] { libDll } : null);

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

            return stdout.ReplaceLineEndings(Environment.NewLine);
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

    private static string CompileExpectingFailure(string source, string library, string libraryAssemblyName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2863_err_").FullName;
        try
        {
            var libSrc = Path.Combine(tempDir, libraryAssemblyName + ".gs");
            var libDll = Path.Combine(tempDir, libraryAssemblyName + ".dll");
            File.WriteAllText(libSrc, library);
            Compile(new[]
            {
                "/out:" + libDll,
                "/target:library",
                "/targetframework:net10.0",
                libSrc,
            });

            var srcPath = Path.Combine(tempDir, "test.gs");
            File.WriteAllText(srcPath, source);

            return CompileCapturingOutput(new[]
            {
                "/out:" + Path.Combine(tempDir, "test.dll"),
                "/target:exe",
                "/targetframework:net10.0",
                "/r:" + libDll,
                srcPath,
            });
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

    private static string BuildExecutable(
        string tempDir,
        string source,
        string library,
        string libraryAssemblyName,
        out string libDll)
    {
        libDll = null;
        if (library != null)
        {
            // ilverify resolves `-r` references by FILE NAME, so the library
            // must be written out under its assembly identity.
            var libSrc = Path.Combine(tempDir, libraryAssemblyName + ".gs");
            libDll = Path.Combine(tempDir, libraryAssemblyName + ".dll");
            File.WriteAllText(libSrc, library);
            Compile(new[]
            {
                "/out:" + libDll,
                "/target:library",
                "/targetframework:net10.0",
                libSrc,
            });
            IlVerifier.Verify(libDll);
        }

        var srcPath = Path.Combine(tempDir, "test.gs");
        var dllPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new List<string>
        {
            "/out:" + dllPath,
            "/target:exe",
            "/targetframework:net10.0",
        };
        if (libDll != null)
        {
            args.Add("/r:" + libDll);
        }

        args.Add(srcPath);
        Compile(args.ToArray());
        return dllPath;
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

    private static string CompileCapturingOutput(string[] args)
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

        Assert.True(compileExit != 0, "expected gsc to fail but it succeeded");
        return stdoutWriter + stderrWriter.ToString();
    }
}
