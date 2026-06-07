// <copyright file="Issue529InheritedInterfaceMembersEmitTests.cs" company="GSharp">
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
/// Issue #529: member lookup on a CLR interface type must walk the
/// inherited interface chain. <c>IReadOnlyList&lt;T&gt;.Count</c> is
/// declared on <c>IReadOnlyCollection&lt;T&gt;</c> but must be
/// accessible through an <c>IReadOnlyList&lt;T&gt;</c>-typed receiver.
/// The same applies to methods (e.g. <c>GetEnumerator()</c> inherited
/// via <c>IEnumerable&lt;T&gt;</c>).
/// </summary>
public class Issue529InheritedInterfaceMembersEmitTests
{
    // ---------------------------------------------------------------
    // BCL interface hierarchy: IReadOnlyList<T>
    // ---------------------------------------------------------------

    [Fact]
    public void IReadOnlyList_Count_InheritedFromIReadOnlyCollection()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic

            var xs = List[string]()
            xs.Add("a")
            xs.Add("b")
            let items IReadOnlyList[string] = xs
            Console.WriteLine(items.Count)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n", output);
    }

    [Fact]
    public void IReadOnlyList_GetEnumerator_InheritedViaIEnumerable()
    {
        // GetEnumerator() is declared on IEnumerable<T> which
        // IReadOnlyList<T> inherits. The non-generic IEnumerable
        // version is hidden by C# interface hiding rules.
        var source = """
            package Probe
            import System
            import System.Collections.Generic

            var xs = List[string]()
            xs.Add("hello")
            let items IReadOnlyList[string] = xs
            let e = items.GetEnumerator()
            e.MoveNext()
            Console.WriteLine(e.Current)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hello\n", output);
    }

    // ---------------------------------------------------------------
    // Sibling C# probe: custom interface hierarchy (method)
    // ---------------------------------------------------------------

    [Fact]
    public void SiblingCSharp_MethodInherited_IA_CalledThroughIB()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IA
                {
                    string M();
                }

                public interface IB : IA
                {
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            type Impl class : IA, IB {
                func M() string { return "from IA via IB" }
            }

            let x IB = Impl{}
            Console.WriteLine(x.M())
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("from IA via IB\n", output);
    }

    // ---------------------------------------------------------------
    // Sibling C# probe: custom interface hierarchy (property)
    // ---------------------------------------------------------------

    [Fact]
    public void SiblingCSharp_PropertyInherited_IA_ReadThroughIB()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IA
                {
                    string Name { get; }
                }

                public interface IB : IA
                {
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            type Named class : IA, IB {
                prop Name string { get { return "hello" } }
            }

            let x IB = Named{}
            Console.WriteLine(x.Name)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("hello\n", output);
    }

    // ---------------------------------------------------------------
    // Three-level interface hierarchy
    // ---------------------------------------------------------------

    [Fact]
    public void SiblingCSharp_ThreeLevelHierarchy_MethodOnBaseReachable()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IBase
                {
                    string Root();
                }

                public interface IMid : IBase
                {
                }

                public interface ILeaf : IMid
                {
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            type Deep class : IBase, IMid, ILeaf {
                func Root() string { return "deep" }
            }

            let x ILeaf = Deep{}
            Console.WriteLine(x.Root())
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("deep\n", output);
    }

    // ---------------------------------------------------------------
    // Regression: members directly declared on the interface bind
    // ---------------------------------------------------------------

    [Fact]
    public void Regression_DirectMembersOnInterface_StillBind()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IDirect
                {
                    string DirectMethod();
                    string DirectProp { get; }
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            type DirectImpl class : IDirect {
                func DirectMethod() string { return "dm" }
                prop DirectProp string { get { return "dp" } }
            }

            let x IDirect = DirectImpl{}
            Console.WriteLine(x.DirectMethod())
            Console.WriteLine(x.DirectProp)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("dm\ndp\n", output);
    }

    // ---------------------------------------------------------------
    // Regression: concrete class member lookup unchanged
    // ---------------------------------------------------------------

    [Fact]
    public void Regression_ConcreteClassMemberLookup_Unchanged()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic

            var items = List[string]()
            items.Add("a")
            items.Add("b")
            items.Add("c")
            Console.WriteLine(items.Count)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n", output);
    }

    // ---------------------------------------------------------------
    // Sibling C# probe: IB extends IA, IB also declares own members
    // ---------------------------------------------------------------

    [Fact]
    public void SiblingCSharp_IBHasOwnAndInheritedMembers()
    {
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IA
                {
                    string FromA();
                }

                public interface IB : IA
                {
                    string FromB();
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            type Both class : IA, IB {
                func FromA() string { return "a" }
                func FromB() string { return "b" }
            }

            let x IB = Both{}
            Console.WriteLine(x.FromA())
            Console.WriteLine(x.FromB())
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("a\nb\n", output);
    }

    // ---------------------------------------------------------------
    // Helpers (mirror Issue525 pattern)
    // ---------------------------------------------------------------

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue529_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
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
                compileExit = Program.Main(args);
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

    private static string CompileAndRunWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue529_sib_").FullName;
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
