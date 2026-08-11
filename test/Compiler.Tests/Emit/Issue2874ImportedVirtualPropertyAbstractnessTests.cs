// <copyright file="Issue2874ImportedVirtualPropertyAbstractnessTests.cs" company="GSharp">
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
/// Issue #2874 — an imported <c>data class</c> carrying a property that is
/// virtual but NOT an override was classified as abstract, so any
/// cross-assembly construction reported
/// <c>GS0386: Cannot create an instance of the abstract type</c>.
/// <para>
/// <c>PropertySymbol.IsAbstract</c> inferred abstractness from declaration
/// shape (<c>IsVirtual &amp;&amp; !IsOverride &amp;&amp; !IsAutoProperty</c>
/// and no accessor body syntax). An imported property never carries body
/// syntax and is built with <c>isAutoProperty: false</c>, so every
/// <c>virtual newslot</c> imported property — which is what an <c>open prop</c>
/// with a body and what an interface implementation both emit — satisfied the
/// whole conjunction.
/// </para>
/// <para>
/// Issue #2870 had already fixed the <c>open override prop</c> half of this by
/// keeping overrides out of a new slot; this covers the remaining
/// non-override half. Abstractness for an imported property is now read
/// straight out of metadata instead of being inferred.
/// </para>
/// </summary>
public class Issue2874ImportedVirtualPropertyAbstractnessTests
{
    [Fact]
    public void ImportedDataClassWithOpenComputedProperty_IsConstructible()
    {
        const string library = """
            package i2874lib1

            open data class KEx(Id int32, Name string) {
                open prop Other string {
                    get -> "x"
                }
            }
            """;

        const string source = """
            package i2874a
            import i2874lib1

            func Main() {
                let k = KEx(1, "n")
                System.Console.WriteLine(k.Name + "," + k.Other)
            }
            """;

        Assert.Equal($"n,x{Environment.NewLine}", CompileAndRun(source, library, "i2874lib1"));
    }

    [Fact]
    public void ImportedDataClassImplementingAnInterfaceProperty_IsConstructible()
    {
        // The actual Oahu shape: `ProfileKeyEx` implements `IProfileKeyEx`, so
        // its accessors are emitted `virtual newslot` even though nothing in
        // the source says `open`.
        const string library = """
            package i2874lib2

            interface IKey {
                prop AccountName string {
                    get;
                }
            }

            data class ProfileKeyEx(AccountName string) : IKey
            """;

        const string source = """
            package i2874b
            import i2874lib2

            func Main() {
                let k = ProfileKeyEx("acct")
                System.Console.WriteLine(k.AccountName)
            }
            """;

        Assert.Equal($"acct{Environment.NewLine}", CompileAndRun(source, library, "i2874lib2"));
    }

    [Fact]
    public void ImportedDataClassWithSettableAndVirtualProperty_IsConstructible()
    {
        // Mixes a settable auto-property (which is emitted with an explicit
        // MethodImpl, not a new virtual slot) with an `open` computed property
        // (which IS `virtual newslot`), so both accessor shapes coexist on one
        // imported type.
        //
        // A settable interface property must be declared explicitly rather
        // than positionally; a positional member emits no setter at all
        // (issue #2875), which is a separate defect.
        const string library = """
            package i2874lib3

            interface IBox {
                prop Value int32 {
                    get;
                    set;
                }
            }

            open data class Box : IBox {
                prop Value int32 {
                    get;
                    set;
                }

                open prop Doubled int32 -> Value * 2
            }
            """;

        const string source = """
            package i2874c
            import i2874lib3

            func Main() {
                let b = Box()
                b.Value = 7
                System.Console.WriteLine(b.Value.ToString() + "," + b.Doubled.ToString())
            }
            """;

        Assert.Equal($"7,14{Environment.NewLine}", CompileAndRun(source, library, "i2874lib3"));
    }

    [Fact]
    public void ImportedDataClassBuiltFromAReferenceAssembly_IsConstructible()
    {
        // MSBuild hands downstream compilations the `/refout` reference
        // assembly, not the implementation, so the import path must agree on
        // both. This is the shape that actually broke the Oahu build.
        const string library = """
            package i2874lib4

            open data class Challenge(Id int32) {
                open prop Kind string {
                    get -> "captcha"
                }
            }
            """;

        const string source = """
            package i2874d
            import i2874lib4

            func Main() {
                let c = Challenge(3)
                System.Console.WriteLine(c.Kind)
            }
            """;

        Assert.Equal($"captcha{Environment.NewLine}", CompileAndRunAgainstReferenceAssembly(source, library, "i2874lib4"));
    }

    [Fact]
    public void ImportedGenuinelyAbstractDataClass_IsStillNotConstructible()
    {
        // Control: reading abstractness from metadata must not make a truly
        // abstract imported type look concrete. A no-body `open prop` on an
        // `open data class` emits an abstract accessor.
        const string library = """
            package i2874lib5

            open data class Shape {
                open prop Name string {
                    get;
                }
            }

            data class Square : Shape {
                override prop Name string -> "square"
            }
            """;

        const string source = """
            package i2874e
            import i2874lib5

            func Main() {
                let s = Shape()
                System.Console.WriteLine(s.Name)
            }
            """;

        var diagnostics = CompileExpectingFailure(source, library, "i2874lib5");
        Assert.Contains("GS0386", diagnostics);
    }

    [Fact]
    public void LocallyDeclaredAbstractShapedDataClass_IsStillNotConstructible()
    {
        // Control: the source-shape inference is still the authority for a
        // property declared in the current compilation.
        const string source = """
            package i2874f

            open data class Local {
                open prop Tag string {
                    get;
                }
            }

            func Main() {
                let l = Local()
                System.Console.WriteLine(l.Tag)
            }
            """;

        var diagnostics = CompileExpectingFailure(source, library: null, libraryAssemblyName: null);
        Assert.Contains("GS0386", diagnostics);
    }

    private static string CompileAndRun(string source, string library = null, string libraryAssemblyName = null)
    {
        return RunBuilt(source, library, libraryAssemblyName, useReferenceAssembly: false);
    }

    private static string CompileAndRunAgainstReferenceAssembly(string source, string library, string libraryAssemblyName)
    {
        return RunBuilt(source, library, libraryAssemblyName, useReferenceAssembly: true);
    }

    private static string RunBuilt(string source, string library, string libraryAssemblyName, bool useReferenceAssembly)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2874_").FullName;
        try
        {
            var dllPath = BuildExecutable(tempDir, source, library, libraryAssemblyName, useReferenceAssembly, out var libDll);

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
        var tempDir = Directory.CreateTempSubdirectory("gs_2874_err_").FullName;
        try
        {
            var args = new List<string>
            {
                "/out:" + Path.Combine(tempDir, "test.dll"),
                "/target:exe",
                "/targetframework:net10.0",
            };

            if (library != null)
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
                args.Add("/r:" + libDll);
            }

            var srcPath = Path.Combine(tempDir, "test.gs");
            File.WriteAllText(srcPath, source);
            args.Add(srcPath);

            return CompileCapturingOutput(args.ToArray());
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
        bool useReferenceAssembly,
        out string libDll)
    {
        libDll = null;
        string referencePath = null;
        if (library != null)
        {
            // ilverify resolves `-r` references by FILE NAME, so the library
            // must be written out under its assembly identity.
            var libSrc = Path.Combine(tempDir, libraryAssemblyName + ".gs");
            libDll = Path.Combine(tempDir, libraryAssemblyName + ".dll");
            File.WriteAllText(libSrc, library);

            var libArgs = new List<string>
            {
                "/out:" + libDll,
                "/target:library",
                "/targetframework:net10.0",
            };

            if (useReferenceAssembly)
            {
                // The reference assembly must live in its own directory: it
                // shares the library's assembly identity, and the runtime must
                // still load the IMPLEMENTATION next to the executable.
                var refDir = Path.Combine(tempDir, "ref");
                Directory.CreateDirectory(refDir);
                referencePath = Path.Combine(refDir, libraryAssemblyName + ".dll");
                libArgs.Add("/refout:" + referencePath);
            }

            libArgs.Add(libSrc);
            Compile(libArgs.ToArray());
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
            args.Add("/r:" + (referencePath ?? libDll));
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
