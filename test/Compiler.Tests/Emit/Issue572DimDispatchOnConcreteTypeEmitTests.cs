// <copyright file="Issue572DimDispatchOnConcreteTypeEmitTests.cs" company="GSharp">
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
/// Issue #572: calling a default interface method (DIM) on a concrete CLR
/// class that does not override the DIM was rejected with GS0159 because
/// <c>ClrTypeUtilities.SafeGetMethodsIncludingInterfaces</c> only walked
/// interfaces when the receiver was itself an interface type. The fix
/// removes the <c>!type.IsInterface</c> guard so interface methods (DIMs)
/// are surfaced on concrete class receivers as well.
/// </summary>
public class Issue572DimDispatchOnConcreteTypeEmitTests
{
    // ---------------------------------------------------------------
    // Core DIM resolution on concrete type
    // ---------------------------------------------------------------

    [Fact]
    public void DimDispatch_ConcreteType_NoArgMethod()
    {
        var sibling = """
            namespace ProbeRef
            {
                public interface IWithDIM
                {
                    string Name { get; }
                    string Greeting() => "Hello, " + Name + "!";
                }

                public class WithDIMImpl : IWithDIM
                {
                    public string Name { get; }
                    public WithDIMImpl(string name) { Name = name; }
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import ProbeRef

            var obj = WithDIMImpl("world")
            Console.WriteLine(obj.Greeting())
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef");
        Assert.Equal("Hello, world!\n", output);
    }

    // ---------------------------------------------------------------
    // Regression: through-interface still works
    // ---------------------------------------------------------------

    [Fact]
    public void DimDispatch_ThroughInterface_StillWorks()
    {
        var sibling = """
            namespace ProbeRef
            {
                public interface IWithDIM
                {
                    string Name { get; }
                    string Greeting() => "Hello, " + Name + "!";
                }

                public class WithDIMImpl : IWithDIM
                {
                    public string Name { get; }
                    public WithDIMImpl(string name) { Name = name; }
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import ProbeRef

            var obj = WithDIMImpl("world")
            var iface IWithDIM = obj
            Console.WriteLine(iface.Greeting())
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef");
        Assert.Equal("Hello, world!\n", output);
    }

    // ---------------------------------------------------------------
    // DIM with parameters
    // ---------------------------------------------------------------

    [Fact]
    public void DimDispatch_WithParameters()
    {
        var sibling = """
            namespace ProbeRef
            {
                public interface IGreeter
                {
                    string Greet(string name, int times) => name + "x" + times.ToString();
                }

                public class SimpleGreeter : IGreeter { }
            }
            """;

        var gsource = """
            package Probe
            import System
            import ProbeRef

            var g = SimpleGreeter()
            Console.WriteLine(g.Greet("hi", 3))
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef");
        Assert.Equal("hix3\n", output);
    }

    // ---------------------------------------------------------------
    // DIM with overloads: M() and M(int)
    // ---------------------------------------------------------------

    [Fact]
    public void DimDispatch_Overloaded()
    {
        var sibling = """
            namespace ProbeRef
            {
                public interface IOverloaded
                {
                    string M() => "noarg";
                    string M(int n) => "arg:" + n.ToString();
                }

                public class OverloadedImpl : IOverloaded { }
            }
            """;

        var gsource = """
            package Probe
            import System
            import ProbeRef

            var o = OverloadedImpl()
            Console.WriteLine(o.M())
            Console.WriteLine(o.M(42))
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef");
        Assert.Equal("noarg\narg:42\n", output);
    }

    // ---------------------------------------------------------------
    // Class explicitly overrides DIM — class version wins
    // ---------------------------------------------------------------

    [Fact]
    public void DimDispatch_OverriddenDim_PrefersConcrete()
    {
        var sibling = """
            namespace ProbeRef
            {
                public interface IWithDIM
                {
                    string Name { get; }
                    string Greeting() => "Hello, " + Name + "!";
                }

                public class WithOverride : IWithDIM
                {
                    public string Name { get; }
                    public WithOverride(string name) { Name = name; }
                    public string Greeting() => "Overridden: " + Name;
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import ProbeRef

            var obj = WithOverride("world")
            Console.WriteLine(obj.Greeting())
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef");
        Assert.Equal("Overridden: world\n", output);
    }

    // ---------------------------------------------------------------
    // DIM inherited from grandparent interface (I3 : I2, I2 : I1, DIM on I1)
    // ---------------------------------------------------------------

    [Fact]
    public void DimDispatch_TransitiveInheritance()
    {
        var sibling = """
            namespace ProbeRef
            {
                public interface IGrandparent
                {
                    string Deep() => "deep-dim";
                }

                public interface IParent : IGrandparent { }
                public interface IChild : IParent { }

                public class DeepImpl : IChild { }
            }
            """;

        var gsource = """
            package Probe
            import System
            import ProbeRef

            var d = DeepImpl()
            Console.WriteLine(d.Deep())
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef");
        Assert.Equal("deep-dim\n", output);
    }

    // ---------------------------------------------------------------
    // DIM on a sealed class
    // ---------------------------------------------------------------

    [Fact]
    public void DimDispatch_SealedClass()
    {
        var sibling = """
            namespace ProbeRef
            {
                public interface ISealable
                {
                    string Tag() => "sealed-dim";
                }

                public sealed class SealedImpl : ISealable { }
            }
            """;

        var gsource = """
            package Probe
            import System
            import ProbeRef

            var s = SealedImpl()
            Console.WriteLine(s.Tag())
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef");
        Assert.Equal("sealed-dim\n", output);
    }

    // ---------------------------------------------------------------
    // DIM property (default interface property with body)
    // ---------------------------------------------------------------

    [Fact]
    public void DimDispatch_Property()
    {
        var sibling = """
            namespace ProbeRef
            {
                public interface IHasDefaultProp
                {
                    string Label => "default-label";
                }

                public class PropImpl : IHasDefaultProp { }
            }
            """;

        var gsource = """
            package Probe
            import System
            import ProbeRef

            var p = PropImpl()
            Console.WriteLine(p.Label)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef");
        Assert.Equal("default-label\n", output);
    }

    // ---------------------------------------------------------------
    // Multiple interfaces each with a DIM — both resolvable
    // ---------------------------------------------------------------

    [Fact]
    public void DimDispatch_MultipleInterfaces()
    {
        var sibling = """
            namespace ProbeRef
            {
                public interface IFoo
                {
                    string Foo() => "foo-dim";
                }

                public interface IBar
                {
                    string Bar() => "bar-dim";
                }

                public class MultImpl : IFoo, IBar { }
            }
            """;

        var gsource = """
            package Probe
            import System
            import ProbeRef

            var m = MultImpl()
            Console.WriteLine(m.Foo())
            Console.WriteLine(m.Bar())
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef");
        Assert.Equal("foo-dim\nbar-dim\n", output);
    }

    // ---------------------------------------------------------------
    // Generic interface with DIM
    // ---------------------------------------------------------------

    [Fact]
    public void DimDispatch_GenericInterface()
    {
        var sibling = """
            namespace ProbeRef
            {
                public interface IGen<T>
                {
                    string Describe() => typeof(T).Name;
                }

                public class GenImpl : IGen<int> { }
            }
            """;

        var gsource = """
            package Probe
            import System
            import ProbeRef

            var g = GenImpl()
            Console.WriteLine(g.Describe())
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef");
        Assert.Equal("Int32\n", output);
    }

    private static string CompileAndRunWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue572_sib_").FullName;
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
                    <Nullable>enable</Nullable>
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
