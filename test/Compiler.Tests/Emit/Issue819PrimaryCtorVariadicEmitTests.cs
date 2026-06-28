// <copyright file="Issue819PrimaryCtorVariadicEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #819 — primary-constructor parameter lists (ADR-0078) accept a
/// trailing variadic <c>name ...T</c>; the variadic parameter promotes to
/// a <c>[]T</c> auto-field of the same name, and the synthesised
/// constructor's variadic slot carries <c>[ParamArrayAttribute]</c> so a
/// C# consumer can call it with <c>params</c> semantics.
///
/// End-to-end emit checks:
///   * CompileAndRun for pack/empty/pass-through over a class with a
///     primary-ctor variadic.
///   * Reflection assertion that the emitted ctor's last parameter has
///     <c>[ParamArrayAttribute]</c>.
///   * Cross-language: a C# sibling library calls
///     <c>new Tags("a", "b", "c")</c> through <c>params</c> lowering and
///     observes the packed slice on the auto-field.
///
/// ilverify is invoked on every emitted assembly via
/// <see cref="IlVerifier.Verify(string, string[], string[])"/>.
/// </summary>
public class Issue819PrimaryCtorVariadicEmitTests
{
    [Fact]
    public void PrimaryCtorVariadic_Class_PacksTrailingArgs()
    {
        var source = """
            package P
            import System

            class Tags(name string, tags ...string) { }

            var t = Tags("project", "a", "b", "c")
            Console.WriteLine(t.name)
            Console.WriteLine(t.tags.Length)
            Console.WriteLine(t.tags[0])
            Console.WriteLine(t.tags[2])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("project\n3\na\nc\n", output);
    }

    [Fact]
    public void PrimaryCtorVariadic_Class_EmptyTrailing_ProducesEmptySlice()
    {
        var source = """
            package P
            import System

            class Tags(name string, tags ...string) { }

            var t = Tags("only")
            Console.WriteLine(t.name)
            Console.WriteLine(t.tags.Length)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("only\n0\n", output);
    }

    [Fact]
    public void PrimaryCtorVariadic_Class_PassThrough_PreservesIdentity()
    {
        var source = """
            package P
            import System

            class Tags(name string, tags ...string) { }

            var arr = []string{"one", "two"}
            var t = Tags("x", arr)
            arr[0] = "ONE"
            Console.WriteLine(t.tags[0])
            Console.WriteLine(t.tags[1])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("ONE\ntwo\n", output);
    }

    [Fact]
    public void PrimaryCtorVariadic_Generic_InfersElementType()
    {
        var source = """
            package P
            import System

            class Box[T](first T, rest ...T) { }

            var b = Box[int32](1, 2, 3, 4)
            Console.WriteLine(b.first)
            Console.WriteLine(b.rest.Length)
            Console.WriteLine(b.rest[0])
            Console.WriteLine(b.rest[2])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n3\n2\n4\n", output);
    }

    [Fact]
    public void PrimaryCtorVariadic_DataClass_PacksTrailingArgs()
    {
        var source = """
            package P
            import System

            data class Tags(name string, tags ...string)

            var t = Tags("project", "a", "b")
            Console.WriteLine(t.name)
            Console.WriteLine(t.tags.Length)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("project\n2\n", output);
    }

    [Fact]
    public void PrimaryCtorVariadic_OnlyVariadic_PacksAll()
    {
        var source = """
            package P
            import System

            class Words(values ...string) { }

            var w = Words("a", "b", "c", "d")
            Console.WriteLine(w.values.Length)
            Console.WriteLine(w.values[3])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("4\nd\n", output);
    }

    [Fact]
    public void PrimaryCtorVariadic_CtorParameter_HasParamArrayAttribute_ForCSharpInterop()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue819_paramarray_").FullName;
        try
        {
            var gsSrc = Path.Combine(tempDir, "lib.gs");
            var gsDll = Path.Combine(tempDir, "GsPrimaryCtorVariadicLib.dll");
            File.WriteAllText(gsSrc, """
                package GsPrimaryCtorVariadicLib

                public class Tags(name string, tags ...string) { }

                public data class Names(prefix string, items ...string)
                """);

            CompileLibrary(gsSrc, gsDll);
            IlVerifier.Verify(gsDll);

            var asm = System.Reflection.Assembly.LoadFrom(gsDll);
            var flags = System.Reflection.BindingFlags.Public
                | System.Reflection.BindingFlags.NonPublic
                | System.Reflection.BindingFlags.Instance;

            // class Tags(name string, tags ...string)
            var tagsType = asm.GetTypes().Single(t => t.Name == "Tags");
            var tagsCtor = tagsType.GetConstructors(flags).Single(c => c.GetParameters().Length == 2);
            var tagsParams = tagsCtor.GetParameters();
            Assert.False(HasParamArray(tagsParams[0]), "Primary-ctor fixed leading param must NOT carry [ParamArrayAttribute].");
            Assert.True(HasParamArray(tagsParams[1]), "Primary-ctor variadic param must carry [ParamArrayAttribute].");
            Assert.Equal("System.String[]", tagsParams[1].ParameterType.FullName);

            // Auto-field is the same []T type.
            var tagsField = tagsType.GetField("tags", flags);
            Assert.NotNull(tagsField);
            Assert.Equal("System.String[]", tagsField!.FieldType.FullName);

            // data class Names(prefix string, items ...string)
            var namesType = asm.GetTypes().Single(t => t.Name == "Names");
            var namesCtor = namesType.GetConstructors(flags).Single(c => c.GetParameters().Length == 2);
            var namesParams = namesCtor.GetParameters();
            Assert.False(HasParamArray(namesParams[0]), "Data-class primary-ctor fixed leading param must NOT carry [ParamArrayAttribute].");
            Assert.True(HasParamArray(namesParams[1]), "Data-class primary-ctor variadic param must carry [ParamArrayAttribute].");
            Assert.Equal("System.String[]", namesParams[1].ParameterType.FullName);

            // Sanity: invoke the synthesised ctor with the C#-style expanded array.
            var instance = tagsCtor.Invoke(new object[] { "p", new string[] { "a", "b", "c" } });
            var observed = (string[])tagsField.GetValue(instance)!;
            Assert.Equal(new[] { "a", "b", "c" }, observed);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    [Fact]
    public void PrimaryCtorVariadic_CSharpConsumer_UsesParamsLowering()
    {
        // C# sibling calls `new Tags("a", "b", "c")` -- depends on
        // [ParamArrayAttribute] being emitted on the trailing primary-ctor
        // param of the generated class.
        var sibling = """
            using GsPrimaryCtorVariadicLib;

            namespace Probe.CSharp
            {
                public static class Probe
                {
                    public static int CountTags(Tags t) => t.tags.Length;
                    public static string FirstTag(Tags t) => t.tags[0];

                    public static Tags MakeViaParams()
                    {
                        // params lowering: caller writes individual args.
                        return new Tags("x", "alpha", "beta", "gamma");
                    }
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import Probe.CSharp
            import System

            var t = Probe.MakeViaParams()
            Console.WriteLine(t.name)
            Console.WriteLine(Probe.CountTags(t))
            Console.WriteLine(Probe.FirstTag(t))
            """;

        var output = CompileAndRunWithGsLibAndSiblingCs(
            gsLibName: "GsPrimaryCtorVariadicLib",
            gsLibSource: """
                package GsPrimaryCtorVariadicLib

                public class Tags(name string, tags ...string) { }
                """,
            csSiblingSource: sibling,
            csSiblingName: "Probe.CSharp",
            gsSource: gsource);

        Assert.Equal("x\n3\nalpha\n", output);
    }

    private static bool HasParamArray(System.Reflection.ParameterInfo p) =>
        p.GetCustomAttributesData().Any(a => a.AttributeType.FullName == "System.ParamArrayAttribute");

    private static void CompileLibrary(string gsSrc, string gsDll)
    {
        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + gsDll,
                "/target:library",
                "/targetframework:net10.0",
                gsSrc,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue819_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
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
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string CompileAndRunWithGsLibAndSiblingCs(
        string gsLibName,
        string gsLibSource,
        string csSiblingSource,
        string csSiblingName,
        string gsSource)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue819_xlang_").FullName;
        try
        {
            // (1) Compile G# library that declares the primary-ctor variadic
            //     type the C# sibling will consume.
            var gsLibSrc = Path.Combine(tempDir, "lib.gs");
            var gsLibDll = Path.Combine(tempDir, gsLibName + ".dll");
            File.WriteAllText(gsLibSrc, gsLibSource);
            CompileLibrary(gsLibSrc, gsLibDll);
            IlVerifier.Verify(gsLibDll);

            // (2) Build the C# sibling project that references the G# library
            //     and calls the synthesised ctor via params lowering.
            var csDir = Path.Combine(tempDir, "csref");
            Directory.CreateDirectory(csDir);
            File.WriteAllText(Path.Combine(csDir, "Lib.cs"), csSiblingSource);
            File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), $"""
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <OutputType>Library</OutputType>
                    <TargetFramework>net10.0</TargetFramework>
                    <Nullable>enable</Nullable>
                    <AssemblyName>{csSiblingName}</AssemblyName>
                    <Nullable>enable</Nullable>
                    <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
                    <EnforceCodeStyleInBuild>false</EnforceCodeStyleInBuild>
                    <NoWarn>$(NoWarn);CS1591</NoWarn>
                    <DocumentationFile></DocumentationFile>
                  </PropertyGroup>
                  <ItemGroup>
                    <Reference Include="{gsLibName}">
                      <HintPath>{gsLibDll}</HintPath>
                    </Reference>
                  </ItemGroup>
                </Project>
                """);

            RunDotnet(csDir, "restore");
            RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore");
            var csDll = Path.Combine(csDir, "bin", "Release", "net10.0", csSiblingName + ".dll");
            Assert.True(File.Exists(csDll), $"sibling assembly not found at {csDll}");

            // (3) Compile a G# executable that references both libraries.
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, gsSource);

            var gscArgs = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/reference:" + csDll,
                "/reference:" + gsLibDll,
            };
            foreach (var reference in TrustedPlatformAssemblies())
            {
                gscArgs.Add("/reference:" + reference);
            }

            gscArgs.Add("/nowarn:GS9100");
            gscArgs.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(gscArgs.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            File.Copy(csDll, Path.Combine(tempDir, Path.GetFileName(csDll)), overwrite: true);

            IlVerifier.Verify(outPath, additionalReferences: new[] { csDll, gsLibDll });

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
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string RunDotnet(string workingDir, params string[] args)
    {
        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDir,
        };
        foreach (var a in args)
        {
            psi.ArgumentList.Add(a);
        }

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException($"failed to start dotnet {string.Join(" ", args)}");
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        Assert.True(proc.WaitForExit(120_000), $"dotnet {args[0]} timed out");
        Assert.True(
            proc.ExitCode == 0,
            $"dotnet {string.Join(" ", args)} failed (exit {proc.ExitCode})\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            yield break;
        }

        foreach (var path in tpa.Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
            {
                yield return path;
            }
        }
    }
}
