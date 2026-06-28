// <copyright file="Issue525ClassImplementsClrInterfaceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #525: a G# class declaring <c>class X : ISomething { ... }</c>
/// against a reachable CLR interface must (1) bind without GS0157, (2) emit
/// real <c>InterfaceImpl</c> metadata so the produced TypeDef is a CLR
/// implementer of the interface, and (3) dispatch through an interface
/// receiver to the G# class's implementation at runtime.
///
/// Each happy-path test compiles via <c>gsc</c>, runs <c>ilverify</c> on the
/// produced assembly, then either reflects the emitted metadata or runs the
/// assembly under <c>dotnet exec</c> to assert end-to-end behavior.
/// </summary>
public class Issue525ClassImplementsClrInterfaceEmitTests
{
    [Fact]
    public void GSharpClass_ImplementsBclInterface_RunsAndIlVerifies()
    {
        // Canonical happy-path: G# class declares it implements a CLR
        // single-method interface (IDisposable), provides the method, and
        // dispatch through an interface-typed local hits the G# body.
        var source = """
            package Probe
            import System

            class MyDisposable : IDisposable {
                func Dispose() {
                    Console.WriteLine("disposed")
                }
            }

            var d IDisposable = MyDisposable{}
            d.Dispose()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("disposed\n", output);
    }

    [Fact]
    public void GSharpClass_ImplementsConstructedClrGenericInterface_RunsAndIlVerifies()
    {
        var source = """
            package Probe
            import System

            class MyStringComparable : IComparable[string] {
                func CompareTo(other string) int32 {
                    return 0
                }
            }

            var c IComparable[string] = MyStringComparable{}
            Console.WriteLine(c.CompareTo("x"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n", output);
    }

    [Fact]
    public void GSharpClass_MetadataDeclaresInterfaceImpl()
    {
        // Reflect over the emitted assembly with a MetadataLoadContext to
        // confirm the resulting TypeDef carries an InterfaceImpl row for
        // System.IDisposable (so consumers see a real CLR implementer).
        var source = """
            package Probe
            import System

            class MyDisposable : IDisposable {
                func Dispose() {
                    Console.WriteLine("disposed")
                }
            }
            """;

        var dllPath = CompileLibrary(source);
        try
        {
            // Use a MetadataLoadContext so we can introspect the emitted
            // type without locking the assembly or polluting the test
            // process's AppDomain.
            var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
            var resolver = new PathAssemblyResolver(
                Directory.GetFiles(runtimeDir, "*.dll")
                    .Concat(new[] { dllPath }));
            using var mlc = new MetadataLoadContext(resolver, "System.Private.CoreLib");
            var asm = mlc.LoadFromAssemblyPath(dllPath);
            var type = asm.GetType("Probe.MyDisposable")
                ?? throw new InvalidOperationException("type not found");

            var interfaces = type.GetInterfaces().Select(i => i.FullName).ToArray();
            Assert.Contains("System.IDisposable", interfaces);

            // The method must be virtual+newslot so the CLR vtable wires it
            // to IDisposable.Dispose for interface dispatch.
            var method = type.GetMethod("Dispose")
                ?? throw new InvalidOperationException("Dispose not found");
            Assert.True(method.IsVirtual, "Dispose() must be virtual to implement the interface");
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    [Fact]
    public void GSharpClass_ImplementsMultipleClrInterfaces_BothReachable()
    {
        // The base-type clause carries TWO CLR interfaces: IDisposable and
        // ICloneable. Both must be wired as InterfaceImpl rows so dispatch
        // works through either contract.
        var source = """
            package Probe
            import System

            class Box : IDisposable, ICloneable {
                func Dispose() {
                    Console.WriteLine("gone")
                }
                func Clone() object {
                    return "clone"
                }
            }

            var b = Box{}
            var c ICloneable = b
            Console.WriteLine(c.Clone())
            var d IDisposable = b
            d.Dispose()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("clone\ngone\n", output);
    }

    [Fact]
    public void GSharpClass_ImplementsClrInterfaceWithReadOnlyProperty_DispatchesGetter()
    {
        // IPropertyShape exposes a single readable property. The G# class
        // declares an auto-property of the matching name and type; the
        // emitter must promote the getter to virtual+newslot so the
        // property accessor satisfies the interface slot.
        //
        // We can't easily synthesise a custom property-only BCL interface,
        // so cover the "has a property" shape with a sibling C# library
        // and have the G# code implement it.
        var sibling = """
            namespace ProbeRef
            {
                public interface ILabel
                {
                    string Label { get; }
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import ProbeRef

            class Boxed : ILabel {
                prop Label string { get { return "hello" } }
            }

            var b = Boxed{}
            var l ILabel = b
            Console.WriteLine(l.Label)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "ProbeRef");
        Assert.Equal("hello\n", output);
    }

    [Fact]
    public void GSharpClass_ImplementsSiblingCSharpInterface_IssueRepro()
    {
        // Exact shape from the issue body: a sibling C# library exposes
        // IGreeter; the G# class implements it and is consumed through
        // the interface receiver.
        var sibling = """
            namespace Probe.CSharp
            {
                public interface IGreeter
                {
                    string Greet(string name);
                }
            }
            """;

        var gsource = """
            package Probe
            import System
            import Probe.CSharp

            class MyGreeter : IGreeter {
                func Greet(name string) string { return "hi " + name }
            }

            var g IGreeter = MyGreeter{}
            Console.WriteLine(g.Greet("world"))
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("hi world\n", output);
    }

    [Fact]
    public void ClrInterface_FromNonImportedNamespace_StillErrors()
    {
        // A typo / non-existent identifier in the base clause must still
        // produce a binding error — generic base-type support must not
        // silently swallow unknown base names.
        var source = """
            package Probe

            class Oops : INotAnInterfaceThatExistsAnywhere {
                func Foo() {}
            }
            """;

        var diagnostics = CompileExpectingErrors(source);
        Assert.Contains(
            diagnostics,
            d => d.Contains("INotAnInterfaceThatExistsAnywhere"));
    }

    [Fact]
    public void GSharpClassHierarchy_StillCompiles_RegressionGuard()
    {
        // Regression guard: a G#-only class hierarchy (no CLR interfaces)
        // must continue to work exactly as before — the new CLR-interface
        // resolution must not break the existing base-clause behavior.
        var source = """
            package Probe
            import System

            open class Animal {
                func Sound() string { return "generic" }
            }

            class Dog : Animal {
                func Bark() string { return "woof" }
            }

            var d = Dog{}
            Console.WriteLine(d.Bark())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("woof\n", output);
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue525_lib_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new[]
        {
            "/out:" + outPath,
            "/target:library",
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
        return outPath;
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue525_").FullName;
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

    private static List<string> CompileExpectingErrors(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue525_err_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + outPath,
                "/target:library",
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

            Assert.True(compileExit != 0, "expected gsc to report errors but it succeeded");

            // gsc writes diagnostics to stdout in this repo; surface both
            // streams so a brittle test failure is easy to diagnose.
            var combined = compileOut.ToString() + compileErr.ToString();
            return combined.Split('\n').Where(l => !string.IsNullOrWhiteSpace(l)).ToList();
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string CompileAndRunWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue525_sib_").FullName;
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
                    <Nullable>enable</Nullable>
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

            // Passing /reference: switches gsc to closed-world reference mode
            // (only explicit refs are loaded), so the full BCL closure from
            // the host's TPA must be enumerated as well. Matches the pattern
            // in Issue520ClrArrayForRangeTests.
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
        // Restore + build the sibling C# library and return the produced
        // assembly path. Done in two `dotnet` invocations so failures
        // surface a clean error message.
        RunDotnet(csDir, "restore");

        var stdout = RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore");
        _ = stdout; // unused; kept for diagnostics on failure

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

    private static void TryCleanup(string dllPath)
    {
        try
        {
            var dir = Path.GetDirectoryName(dllPath);
            if (dir != null && Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch
        {
        }
    }
}
