// <copyright file="Issue659DimOutParamEmitTests.cs" company="GSharp">
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
/// Issue #659: a G# class cannot implement a CLR interface that contains a
/// Default Interface Method (DIM) when the interface also has methods using
/// out/ref parameters. Two root causes:
///   1) <c>DeclarationBinder.VerifyClrInterfaceImplementations</c> did not skip
///      DIM (non-abstract) methods — so it demanded implementations for them.
///   2) <c>MemberLookup.HasMatchingMethodForClrSignature</c> compared
///      <c>callable[i].Type</c> against the CLR by-ref parameter type without
///      unwrapping the ByRef envelope or checking RefKind, so out/ref params
///      never matched.
/// </summary>
public class Issue659DimOutParamEmitTests
{
    [Fact]
    public void DimWithOutParam_AbstractMethodImplemented_CompilesAndRuns()
    {
        // Exact repro from the issue: interface with an abstract method taking
        // an out parameter and a DIM (non-abstract) overload.
        var sibling = """
            using System;
            namespace Probe.CSharp
            {
                public interface IKeyReader
                {
                    bool TryReadKey(int millisecondsTimeout, out ConsoleKeyInfo key);
                    bool TryReadKey(out ConsoleKeyInfo key) => TryReadKey(0, out key);
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            type MyReader class : IKeyReader {
                func TryReadKey(millisecondsTimeout int32, out key ConsoleKeyInfo) bool {
                    key = ConsoleKeyInfo('A', ConsoleKey.A, false, false, false)
                    return true
                }
            }

            var r = MyReader{}
            var k ConsoleKeyInfo
            var result = r.TryReadKey(100, out k)
            if result {
                Console.WriteLine(k.KeyChar)
            }
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("A\n", output);
    }

    [Fact]
    public void DimOnly_NoAbstractMembers_ClassNotRequiredToImplementAnything()
    {
        // Interface with ONLY a DIM (no abstract members) — the implementing
        // class should compile without providing any method body.
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IOptional
                {
                    int GetValue() => 42;
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            type Empty class : IOptional {
            }

            var o IOptional = Empty{}
            Console.WriteLine(o.GetValue())
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void DimExplicitlyOverridden_StillMatches()
    {
        // A G# class explicitly provides a body for a method that also has a
        // DIM. The class's implementation should take precedence.
        var sibling = """
            using System;
            namespace Probe.CSharp
            {
                public interface IKeyReader2
                {
                    bool TryReadKey(int millisecondsTimeout, out ConsoleKeyInfo key);
                    bool TryReadKey(out ConsoleKeyInfo key) => TryReadKey(0, out key);
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            type FullReader class : IKeyReader2 {
                func TryReadKey(millisecondsTimeout int32, out key ConsoleKeyInfo) bool {
                    key = ConsoleKeyInfo('B', ConsoleKey.B, false, false, false)
                    return true
                }
                func TryReadKey(out key ConsoleKeyInfo) bool {
                    key = ConsoleKeyInfo('C', ConsoleKey.C, false, false, false)
                    return true
                }
            }

            var r = FullReader{}
            var k ConsoleKeyInfo
            var result = r.TryReadKey(out k)
            if result {
                Console.WriteLine(k.KeyChar)
            }
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("C\n", output);
    }

    [Fact]
    public void RefParam_MatchesCorrectly()
    {
        // Interface with a ref parameter — should compile and run correctly.
        var sibling = """
            namespace Probe.CSharp
            {
                public interface ISwapper
                {
                    void Swap(ref int a, ref int b);
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            type MySwapper class : ISwapper {
                func Swap(ref a int32, ref b int32) {
                    var tmp = a
                    a = b
                    b = tmp
                }
            }

            var s ISwapper = MySwapper{}
            var x = 1
            var y = 2
            s.Swap(ref x, ref y)
            Console.WriteLine(x)
            Console.WriteLine(y)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("2\n1\n", output);
    }

    [Fact]
    public void MissingImplementation_StillRaisesGS0187()
    {
        // Regression guard: a genuine missing interface method must still
        // produce GS0187 after the DIM fix.
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IRequired
                {
                    void DoWork();
                    int GetCount();
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            type Incomplete class : IRequired {
                func DoWork() {
                }
            }
            """;

        var diagnostics = CompileExpectingErrorsWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Contains(diagnostics, d => d.Contains("GetCount"));
    }

    [Fact]
    public void OutParam_WithoutDim_MatchesCorrectly()
    {
        // Interface with only an out parameter (no DIM) — verifies the
        // by-ref matching fix in isolation from the DIM fix.
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IParser
                {
                    bool TryParse(string input, out int result);
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            type MyParser class : IParser {
                func TryParse(input string, out result int32) bool {
                    result = 42
                    return true
                }
            }

            var p = MyParser{}
            var v int32
            var ok = p.TryParse("hello", out v)
            if ok {
                Console.WriteLine(v)
            }
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("42\n", output);
    }

    #region Harness

    private static string CompileAndRunWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue659_sib_").FullName;
        try
        {
            var csDir = Path.Combine(tempDir, "csref");
            Directory.CreateDirectory(csDir);
            File.WriteAllText(Path.Combine(csDir, "Lib.cs"), csSource);
            File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), $"""
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <OutputType>Library</OutputType>
                    <TargetFramework>net10.0</TargetFramework>
                    <AssemblyName>{siblingName}</AssemblyName>
                    <RootNamespace>{siblingName}</RootNamespace>
                  </PropertyGroup>
                </Project>
                """);

            var siblingDll = BuildCsProject(csDir, siblingName);

            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, gSource);

            var gscArgs = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/reference:" + siblingDll,
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

            File.Copy(siblingDll, Path.Combine(tempDir, Path.GetFileName(siblingDll)), overwrite: true);

            IlVerifier.Verify(outPath, additionalReferences: new[] { siblingDll });

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

    private static List<string> CompileExpectingErrorsWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue659_err_").FullName;
        try
        {
            var csDir = Path.Combine(tempDir, "csref");
            Directory.CreateDirectory(csDir);
            File.WriteAllText(Path.Combine(csDir, "Lib.cs"), csSource);
            File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), $"""
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <OutputType>Library</OutputType>
                    <TargetFramework>net10.0</TargetFramework>
                    <AssemblyName>{siblingName}</AssemblyName>
                    <RootNamespace>{siblingName}</RootNamespace>
                  </PropertyGroup>
                </Project>
                """);

            var siblingDll = BuildCsProject(csDir, siblingName);

            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, gSource);

            var gscArgs = new List<string>
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                "/reference:" + siblingDll,
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

            Assert.True(compileExit != 0, "expected gsc to report errors but it succeeded");

            var combined = compileOut.ToString() + compileErr.ToString();
            return combined.Split('\n').Where(l => !string.IsNullOrWhiteSpace(l)).ToList();
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string BuildCsProject(string csDir, string siblingName)
    {
        RunDotnet(csDir, "restore");
        RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore");

        var dll = Path.Combine(csDir, "bin", "Release", "net10.0", siblingName + ".dll");
        Assert.True(File.Exists(dll), $"sibling assembly not found at {dll}");
        return dll;
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

    #endregion
}
