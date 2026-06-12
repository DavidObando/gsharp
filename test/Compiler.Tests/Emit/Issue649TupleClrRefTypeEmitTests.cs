// <copyright file="Issue649TupleClrRefTypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #649: Any tuple containing a CLR reference type from a project
/// reference triggered <c>GS9998: NotSupportedException: TypeBuilder generic
/// instantiation does not support resolving members</c>. The root cause was
/// that <c>EmitTupleElementAccess</c> called <c>.GetField()</c> and
/// <c>EmitTupleLiteral</c> called <c>.GetConstructors()</c> on the closed
/// <c>ValueTuple&lt;...&gt;</c> generic — which throws when any type argument
/// is loaded via MetadataLoadContext. The fix resolves fields and constructors
/// from the open generic type definition instead.
/// </summary>
public class Issue649TupleClrRefTypeEmitTests
{
    private const string HolderSiblingCs = """
        namespace Probe.CSharp
        {
            public sealed class Holder
            {
                public string A { get; init; } = "";
            }

            public sealed class Holder2
            {
                public int X { get; init; }

                public sealed class Nested
                {
                    public string B { get; init; } = "";
                }
            }
        }
        """;

    [Fact]
    public void Tuple2_OneClrRefType_ReturnsAndDestructures()
    {
        // (Holder, string) — the exact shape from the issue.
        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            func make() (Holder, string) {
                return (Holder() { A = "x" }, "b")
            }

            let (h, s) = make()
            Console.Write(h.A)
            Console.Write("|")
            Console.Write(s)
            """;

        var output = CompileAndRunWithSiblingCs(HolderSiblingCs, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("x|b", output);
    }

    [Fact]
    public void Tuple2_TwoClrRefTypes_OneNested()
    {
        // (Holder, Holder2.Nested) — two CLR ref types, one nested.
        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            func make() (Holder, Holder2.Nested) {
                return (Holder() { A = "alpha" }, Holder2.Nested() { B = "beta" })
            }

            let (h, n) = make()
            Console.Write(h.A)
            Console.Write("|")
            Console.Write(n.B)
            """;

        var output = CompileAndRunWithSiblingCs(HolderSiblingCs, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("alpha|beta", output);
    }

    [Fact]
    public void Tuple4_ClrRefTypeWithPrimitives()
    {
        // (Holder, int32, string, string) — 4-element tuple with CLR ref type.
        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            func make() (Holder, int32, string, string) {
                return (Holder() { A = "val" }, 42, "c", "d")
            }

            let (h, i, s1, s2) = make()
            Console.Write(h.A)
            Console.Write("|")
            Console.Write(i.ToString())
            Console.Write("|")
            Console.Write(s1)
            Console.Write("|")
            Console.Write(s2)
            """;

        var output = CompileAndRunWithSiblingCs(HolderSiblingCs, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("val|42|c|d", output);
    }

    [Fact]
    public void Tuple_DirectItemAccess_WithoutDestructure()
    {
        // Use t.Item1, t.Item2 without destructure — tests the same ldfld path.
        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            func make() (Holder, string) {
                return (Holder() { A = "direct" }, "access")
            }

            let t = make()
            Console.Write(t.Item1.A)
            Console.Write("|")
            Console.Write(t.Item2)
            """;

        var output = CompileAndRunWithSiblingCs(HolderSiblingCs, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("direct|access", output);
    }

    [Fact]
    public void Tuple_WithGSharpDefinedRefType()
    {
        // A tuple containing a G#-defined class (TypeBuilder-backed) alongside
        // a CLR ref type from the sibling — tests both directions of the
        // mixed-arg generic instantiation.
        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class MyClass {
                var Name string
                init() {}
            }

            func make() (MyClass, Holder) {
                return (MyClass() { Name = "gs" }, Holder() { A = "cs" })
            }

            let (mc, h) = make()
            Console.Write(mc.Name)
            Console.Write("|")
            Console.Write(h.A)
            """;

        var output = CompileAndRunWithSiblingCs(HolderSiblingCs, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("gs|cs", output);
    }

    [Fact]
    public void Tuple_AsParameterType()
    {
        // Tuple containing CLR ref type passed as a function parameter.
        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            func consume(t (Holder, string)) string {
                return t.Item1.A + "|" + t.Item2
            }

            let t = (Holder() { A = "param" }, "test")
            Console.Write(consume(t))
            """;

        var output = CompileAndRunWithSiblingCs(HolderSiblingCs, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("param|test", output);
    }

    [Fact]
    public void Tuple_AsFieldType()
    {
        // Tuple containing CLR ref type stored as a field in a G# class.
        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class Container {
                var Data (Holder, int32)
                init() {
                    Data = (Holder() { A = "field" }, 99)
                }
            }

            var c = Container()
            Console.Write(c.Data.Item1.A)
            Console.Write("|")
            Console.Write(c.Data.Item2.ToString())
            """;

        var output = CompileAndRunWithSiblingCs(HolderSiblingCs, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("field|99", output);
    }

    [Fact]
    public void Tuple7_MaxWithoutRest_ClrRefType()
    {
        // 7-element tuple (max arity without TRest) containing a CLR ref type.
        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            func make() (Holder, int32, int32, int32, int32, int32, string) {
                return (Holder() { A = "seven" }, 1, 2, 3, 4, 5, "end")
            }

            let (h, a, b, c, d, e, s) = make()
            Console.Write(h.A)
            Console.Write("|")
            Console.Write(s)
            """;

        var output = CompileAndRunWithSiblingCs(HolderSiblingCs, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("seven|end", output);
    }

    [Fact]
    public void Tuple_PrimitivesOnly_StillWorks()
    {
        // Sanity check: primitives-only tuples (which worked before) still work.
        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            func make() (string, int32, string, int32) {
                return ("a", 1, "b", 2)
            }

            let (s1, i1, s2, i2) = make()
            Console.Write(s1)
            Console.Write(i1.ToString())
            Console.Write(s2)
            Console.Write(i2.ToString())
            """;

        var output = CompileAndRunWithSiblingCs(HolderSiblingCs, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("a1b2", output);
    }

    // --- Helpers ---

    private static string CompileAndRunWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue649_sib_").FullName;
        try
        {
            // Step 1: compile the sibling C# library.
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

            // Step 2: compile the G# code referencing the sibling.
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

            // Place the sibling next to the produced assembly so the
            // probing path resolves it at runtime.
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

    private static string BuildCsProject(string csDir, string siblingName)
    {
        RunDotnet(csDir, "restore");
        RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore");

        var dll = Path.Combine(csDir, "bin", "Release", "net10.0", siblingName + ".dll");
        Assert.True(File.Exists(dll), $"sibling assembly not found at {dll}");
        return dll;
    }

    private static void RunDotnet(string workingDir, params string[] args)
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
