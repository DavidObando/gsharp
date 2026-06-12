// <copyright file="Issue521ReferenceUpcastTests.cs" company="GSharp">
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
/// Comprehensive regression tests for GitHub issue #521: "Binder: concrete
/// class cannot be upcast to an implemented interface (GS0155 on both user
/// and BCL types)".
///
/// The underlying fixes live in:
///   • 6.4 (PR #609): <c>MemberLookup.SafeGet*IncludingSelfAndInterfaces</c>
///     — interface member resolution now walks the full inheritance chain
///     instead of probing only the declared type, which unblocked dispatch
///     through upcast receivers.
///   • 6.5 (PR #612): <c>ClrTypeUtilities.ImplementsInterfaceByName</c> —
///     cross-MetadataLoadContext type identity comparison for interface
///     satisfaction (used by the general #521 reference-upcast arm in
///     <c>Conversion.Classify</c>).
///
/// Each test compiles via the in-process <c>gsc</c> entry point, IL-verifies
/// the produced PE via <c>dotnet-ilverify</c>, then runs the assembly under
/// <c>dotnet exec</c> and asserts on captured stdout. The IL verification
/// catches spurious <c>castclass</c> / stack-type mismatches; the execution
/// proves the upcast dispatches correctly at runtime.
/// </summary>
public class Issue521ReferenceUpcastTests
{
    // ─────────────────────────────────────────────────────────────────────
    // Positive: User-defined class → user-defined interface (sibling C#)
    // ─────────────────────────────────────────────────────────────────────

    private const string GreetingSiblingCs = """
        namespace Greeting
        {
            public interface IGreeter
            {
                string Greet(string name);
            }

            public class HelloGreeter : IGreeter
            {
                public string Greet(string name)
                {
                    return "Hello, " + name;
                }
            }
        }
        """;

    [Fact]
    public void UserClass_ToUserInterface_ImplicitUpcast_CompilesAndRuns()
    {
        // Issue body repro: `let g IGreeter = HelloGreeter()` where
        // IGreeter + HelloGreeter are defined in a sibling C# assembly.
        var gSource = """
            package P
            import System
            import Greeting

            var g IGreeter = HelloGreeter()
            Console.WriteLine(g.Greet("world"))
            """;

        var output = CompileAndRunWithSiblingCs(GreetingSiblingCs, gSource, siblingName: "Greeting");
        Assert.Equal("Hello, world\n", output);
    }

    [Fact]
    public void UserClass_ToUserInterface_ExplicitCast_CompilesAndRuns()
    {
        // Issue comment repro: `IGreeter(HelloGreeter())` explicit-cast form.
        var gSource = """
            package P
            import System
            import Greeting

            var g = IGreeter(HelloGreeter())
            Console.WriteLine(g.Greet("cast"))
            """;

        var output = CompileAndRunWithSiblingCs(GreetingSiblingCs, gSource, siblingName: "Greeting");
        Assert.Equal("Hello, cast\n", output);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Positive: BCL class → BCL interface
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void BclClass_ToBclInterface_ImplicitUpcast_CompilesAndRuns()
    {
        // Issue body repro: `let l IReadOnlyList[string] = List[string]()`
        var source = """
            package P
            import System
            import System.Collections.Generic

            var mut = List[string]()
            mut.Add("alpha")
            mut.Add("beta")
            var r IReadOnlyList[string] = mut
            Console.WriteLine(r[0])
            Console.WriteLine(r[1])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("alpha\nbeta\n", output);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Positive: BCL class → BCL abstract base class
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void BclClass_ToBclAbstractBase_ImplicitUpcast_CompilesAndRuns()
    {
        // Issue comment repro: `let tw TextWriter = StringWriter()`
        var source = """
            package P
            import System
            import System.IO

            var tw TextWriter = StringWriter()
            tw.Write("hello")
            tw.Write(" upcast")
            Console.WriteLine(tw.ToString())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hello upcast\n", output);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Positive: Lambda/function return-type widening
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void LambdaReturn_WidensConcreteToInterface_CompilesAndRuns()
    {
        // Returning a concrete type where the function return type is an
        // interface exercises the upcast at the return-value site.
        var gSource = """
            package P
            import System
            import Greeting

            func MakeGreeter() IGreeter {
                return HelloGreeter()
            }

            Console.WriteLine(MakeGreeter().Greet("lambda"))
            """;

        var output = CompileAndRunWithSiblingCs(GreetingSiblingCs, gSource, siblingName: "Greeting");
        Assert.Equal("Hello, lambda\n", output);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Positive: Method-argument widening (interface + abstract base)
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void MethodArgument_WidensConcreteToInterface_CompilesAndRuns()
    {
        // Passing a concrete class to a method parameter typed as an
        // interface — the argument-slot conversion must widen.
        var gSource = """
            package P
            import System
            import Greeting

            func Run(g IGreeter, name string) {
                Console.WriteLine(g.Greet(name))
            }

            Run(HelloGreeter(), "arg")
            """;

        var output = CompileAndRunWithSiblingCs(GreetingSiblingCs, gSource, siblingName: "Greeting");
        Assert.Equal("Hello, arg\n", output);
    }

    [Fact]
    public void MethodArgument_WidensConcreteToAbstractBase_CompilesAndRuns()
    {
        // Passing a StringWriter where the parameter is typed TextWriter.
        var source = """
            package P
            import System
            import System.IO

            func Scribble(tw TextWriter) {
                tw.Write("scribbled")
            }

            var sw = StringWriter()
            Scribble(sw)
            Console.WriteLine(sw.ToString())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("scribbled\n", output);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Positive: Generic IEnumerable with concrete List
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void Generic_IEnumerable_AcceptsConcreteList()
    {
        // Passing a List<string> where IEnumerable<string> is expected.
        var source = """
            package P
            import System
            import System.Collections.Generic

            func CountItems(items IEnumerable[string]) int32 {
                var count = 0
                for x in items {
                    count = count + 1
                }
                return count
            }

            var list = List[string]()
            list.Add("one")
            list.Add("two")
            list.Add("three")
            Console.WriteLine(CountItems(list))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n", output);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Negative: Unrelated types still produce GS0155
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void UnrelatedTypes_ConcreteToInterface_StillErrorsGS0155()
    {
        // A concrete class that does NOT implement the target interface
        // must still fail with GS0155 — the upcast should not be a blanket
        // pass-through.
        var sibling = """
            namespace Neg
            {
                public interface IUnrelated
                {
                    void DoStuff();
                }

                public class NotImplementing
                {
                }
            }
            """;

        var gSource = """
            package P
            import System
            import Neg

            var x IUnrelated = NotImplementing()
            """;

        var diagnostics = CompileExpectingErrorsWithSiblingCs(sibling, gSource, siblingName: "Neg");
        Assert.Contains(diagnostics, d => d.Contains("GS0155") || d.Contains("Cannot convert"));
    }

    // ─────────────────────────────────────────────────────────────────────
    // Negative: Slice covariance — []Derived → interface IEnumerable<Base>
    //           is blocked by the invariance guard (Conversion.cs §570).
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void Slice_Invariant_DoesNotAllowSliceToCovariantInterface()
    {
        // G# slices are invariant with respect to interface generic args
        // (Conversion.cs lines 438-447): []string must NOT implicitly
        // convert to IEnumerable[object] even though CLR arrays are
        // covariant. This pins the invariance guard.
        var source = """
            package P
            import System.Collections.Generic

            var s = []string{"hello"}
            var e IEnumerable[object] = s
            """;

        var diagnostics = CompileExpectingErrors(source);
        Assert.Contains(diagnostics, d => d.Contains("GS0155") || d.Contains("Cannot convert"));
    }

    // ─────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue521_ref_").FullName;
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
            };
            args.Add(srcPath);

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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue521_sib_").FullName;
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

    private static List<string> CompileExpectingErrors(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue521_neg_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };
            args.Add(srcPath);

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
                compileExit != 0,
                $"expected gsc to report errors but it succeeded\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            var combined = compileOut.ToString() + compileErr.ToString();
            return combined.Split('\n').Where(l => !string.IsNullOrWhiteSpace(l)).ToList();
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static List<string> CompileExpectingErrorsWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue521_neg_sib_").FullName;
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
                "/nowarn:GS9100",
            };

            foreach (var reference in TrustedPlatformAssemblies())
            {
                gscArgs.Add("/reference:" + reference);
            }

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
                compileExit != 0,
                $"expected gsc to report errors but it succeeded\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

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
