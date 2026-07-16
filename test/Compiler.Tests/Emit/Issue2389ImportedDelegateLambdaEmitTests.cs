// <copyright file="Issue2389ImportedDelegateLambdaEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2389: an untyped arrow-lambda handler (<c>Event += (s, e) -&gt;
/// ...</c>) used against an IMPORTED CLR delegate/event failed target-type
/// inference with GS0304 ("cannot infer the type of lambda parameter")
/// even though a typed lambda (<c>(s object, e EventArgs) -&gt; ...</c>) or a
/// declaration initializer compiled fine. The root cause was that the
/// shared handler-binding helper (<c>ExpressionBinder.BindEventSubscriptionHandler</c>,
/// used by both <c>+=</c>/<c>-=</c> event subscription and, via
/// <c>BindAssignmentRhs</c>, plain <c>=</c> re-assignment) bound the lambda
/// syntax with no target type at all, rather than resolving the omitted
/// parameter/return types from the target delegate's shape up front. See
/// <c>Issue2389ImportedDelegateLambdaInferenceTests</c> (Core.Tests) for the
/// binder-level (diagnostics-only) coverage of the same fix; this file
/// exercises the fix end-to-end against a REAL imported sibling CLR
/// assembly — instance and static events, <c>EventHandler</c> and custom
/// delegates, zero/one/multiple parameters, inferred parameter and return
/// types, add/remove symmetry, and negative arity/signature controls —
/// compiled, run, and ILVerify'd.
/// </summary>
public class Issue2389ImportedDelegateLambdaEmitTests
{
    private const string CsLib = """
        using System;

        namespace ProbeRef2389
        {
            public delegate void ZeroParamHandler();

            public delegate void OneParamHandler(string message);

            public delegate int ComputeHandler(int a, int b);

            public class Publisher
            {
                public event EventHandler Notified;

                public event ZeroParamHandler Ticked;

                public event OneParamHandler Announced;

                public event ComputeHandler Computed;

                public static event EventHandler StaticNotified;

                public static event OneParamHandler StaticAnnounced;

                public void RaiseNotified() => Notified?.Invoke(this, EventArgs.Empty);

                public void RaiseTicked() => Ticked?.Invoke();

                public void RaiseAnnounced(string message) => Announced?.Invoke(message);

                public int RaiseComputed(int a, int b) => Computed != null ? Computed(a, b) : -1;

                public static void RaiseStaticNotified() => StaticNotified?.Invoke(null, EventArgs.Empty);

                public static void RaiseStaticAnnounced(string message) => StaticAnnounced?.Invoke(message);
            }
        }
        """;

    [Fact]
    public void InstanceEventHandler_UntypedLambda_CompilesRunsAndVerifies()
    {
        var gSource = """
            package Probe2389
            import System
            import ProbeRef2389

            var log string = ""

            var p = Publisher()
            p.Notified += (sender, e) -> {
                log = log + "N"
            }
            p.RaiseNotified()
            Console.WriteLine(log)
            """;

        Assert.Equal("N\n", CompileAndRunWithSiblingCs(CsLib, gSource, "ProbeRef2389a"));
    }

    [Fact]
    public void InstanceZeroParamCustomDelegate_UntypedLambda_CompilesRunsAndVerifies()
    {
        var gSource = """
            package Probe2389
            import System
            import ProbeRef2389

            var log string = ""

            var p = Publisher()
            p.Ticked += () -> {
                log = log + "T"
            }
            p.RaiseTicked()
            Console.WriteLine(log)
            """;

        Assert.Equal("T\n", CompileAndRunWithSiblingCs(CsLib, gSource, "ProbeRef2389b"));
    }

    [Fact]
    public void InstanceOneParamCustomDelegate_UntypedLambda_InfersParamTypeAndVerifies()
    {
        // The lambda parameter is inferred as `string` (OneParamHandler's
        // sole parameter type) with no explicit annotation, then used as a
        // string (string concatenation) to prove the inferred type is
        // correct, not merely `object`.
        var gSource = """
            package Probe2389
            import System
            import ProbeRef2389

            var log string = ""

            var p = Publisher()
            p.Announced += (message) -> {
                log = log + "[" + message + "]"
            }
            p.RaiseAnnounced("hi")
            Console.WriteLine(log)
            """;

        Assert.Equal("[hi]\n", CompileAndRunWithSiblingCs(CsLib, gSource, "ProbeRef2389c"));
    }

    [Fact]
    public void InstanceMultiParamCustomDelegate_UntypedLambda_InfersParamAndReturnTypesAndVerifies()
    {
        // ComputeHandler is `(int32, int32) -> int32` — both parameters AND
        // the non-void return type are inferred purely from the target
        // delegate shape.
        var gSource = """
            package Probe2389
            import System
            import ProbeRef2389

            var p = Publisher()
            p.Computed += (a, b) -> {
                return a + b
            }
            Console.WriteLine(p.RaiseComputed(2, 3))
            """;

        Assert.Equal("5\n", CompileAndRunWithSiblingCs(CsLib, gSource, "ProbeRef2389d"));
    }

    [Fact]
    public void StaticEventHandler_UntypedLambda_CompilesRunsAndVerifies()
    {
        var gSource = """
            package Probe2389
            import System
            import ProbeRef2389

            var log string = ""

            Publisher.StaticNotified += (sender, e) -> {
                log = log + "S"
            }
            Publisher.RaiseStaticNotified()
            Console.WriteLine(log)
            """;

        Assert.Equal("S\n", CompileAndRunWithSiblingCs(CsLib, gSource, "ProbeRef2389e"));
    }

    [Fact]
    public void StaticOneParamCustomDelegate_UntypedLambda_CompilesRunsAndVerifies()
    {
        var gSource = """
            package Probe2389
            import System
            import ProbeRef2389

            var log string = ""

            Publisher.StaticAnnounced += (message) -> {
                log = log + "A" + message
            }
            Publisher.RaiseStaticAnnounced("Y")
            Console.WriteLine(log)
            """;

        Assert.Equal("AY\n", CompileAndRunWithSiblingCs(CsLib, gSource, "ProbeRef2389f"));
    }

    [Fact]
    public void InstanceEventHandler_UntypedLambda_AddRemoveSymmetry_CompilesRunsAndVerifies()
    {
        // Subscribe with a lambda captured into a variable, raise (handler
        // fires once), unsubscribe the SAME variable, raise again (handler
        // must not fire a second time) — add/remove symmetry for the
        // now-target-typed untyped-lambda handler.
        var gSource = """
            package Probe2389
            import System
            import ProbeRef2389

            var hits int32 = 0
            var p = Publisher()
            var handler EventHandler = (sender, e) -> {
                hits = hits + 1
            }
            p.Notified += handler
            p.RaiseNotified()
            p.Notified -= handler
            p.RaiseNotified()
            Console.WriteLine(hits)
            """;

        Assert.Equal("1\n", CompileAndRunWithSiblingCs(CsLib, gSource, "ProbeRef2389g"));
    }

    [Fact]
    public void MultipleEventsOnSameInstance_UntypedLambdas_CompileRunAndVerifyTogether()
    {
        // Full matrix in one program: EventHandler + all three custom
        // delegate shapes (zero/one/multi-param), instance AND static, in a
        // single compilation/emit/ILVerify pass.
        var gSource = """
            package Probe2389
            import System
            import ProbeRef2389

            var log string = ""

            var p = Publisher()
            p.Notified += (sender, e) -> {
                log = log + "N"
            }
            p.Ticked += () -> {
                log = log + "T"
            }
            p.Announced += (message) -> {
                log = log + message
            }
            p.Computed += (a, b) -> {
                return a + b
            }

            Publisher.StaticNotified += (sender, e) -> {
                log = log + "S"
            }
            Publisher.StaticAnnounced += (message) -> {
                log = log + "A" + message
            }

            p.RaiseNotified()
            p.RaiseTicked()
            p.RaiseAnnounced("X")
            var sum = p.RaiseComputed(2, 3)
            Publisher.RaiseStaticNotified()
            Publisher.RaiseStaticAnnounced("Y")

            Console.WriteLine(log)
            Console.WriteLine(sum)
            """;

        Assert.Equal("NTXSAY\n5\n", CompileAndRunWithSiblingCs(CsLib, gSource, "ProbeRef2389h"));
    }

    [Fact]
    public void ArityMismatch_UntypedLambda_AgainstImportedCustomDelegate_ReportsDiagnosticNotCrash()
    {
        // Negative / invalid-signature control: a one-parameter lambda
        // cannot satisfy the two-parameter ComputeHandler shape. Must fail
        // cleanly with the pre-existing diagnostics (GS0304 / GS0155), not
        // crash the compiler or silently accept the wrong arity.
        var gSource = """
            package Probe2389
            import System
            import ProbeRef2389

            var p = Publisher()
            p.Computed += (onlyOne) -> {
                return onlyOne
            }
            """;

        var diagnostics = CompileExpectingErrorsWithSiblingCs(CsLib, gSource, "ProbeRef2389i");
        Assert.Contains(diagnostics, d => d.Contains("GS0304", StringComparison.Ordinal));
        Assert.Contains(diagnostics, d => d.Contains("GS0155", StringComparison.Ordinal));
    }

    [Fact]
    public void ZeroArityLambda_AgainstTwoParamImportedDelegate_ReportsDiagnosticNotCrash()
    {
        var gSource = """
            package Probe2389
            import System
            import ProbeRef2389

            var p = Publisher()
            p.Notified += () -> {
                var x = 1
            }
            """;

        var diagnostics = CompileExpectingErrorsWithSiblingCs(CsLib, gSource, "ProbeRef2389j");
        Assert.Contains(diagnostics, d => d.Contains("GS0155", StringComparison.Ordinal));
    }

    [Fact]
    public void ExplicitlyMistypedLambdaParameter_AgainstImportedCustomDelegate_ReportsDiagnosticNotCrash()
    {
        // Invalid-SIGNATURE control (as opposed to invalid-arity): an
        // explicitly-typed parameter that disagrees with the target
        // delegate's parameter type must still be rejected — the
        // target-typed inference fix must not silently coerce or ignore an
        // explicit (wrong) annotation.
        var gSource = """
            package Probe2389
            import System
            import ProbeRef2389

            var p = Publisher()
            p.Announced += (message int32) -> {
                var x = message
            }
            """;

        var diagnostics = CompileExpectingErrorsWithSiblingCs(CsLib, gSource, "ProbeRef2389k");
        Assert.Contains(diagnostics, d => d.Contains("GS0155", StringComparison.Ordinal));
    }

    private static string CompileAndRunWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var workDir = CreateWorkDir("issue2389_");
        try
        {
            var siblingDll = BuildCsLibrary(workDir, csSource, siblingName);
            File.Copy(siblingDll, Path.Combine(workDir, Path.GetFileName(siblingDll)), overwrite: true);
            return CompileAndRun(gSource, new[] { siblingDll }, workDir);
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    private static List<string> CompileExpectingErrorsWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var workDir = CreateWorkDir("issue2389_err_");
        try
        {
            var siblingDll = BuildCsLibrary(workDir, csSource, siblingName);
            return CompileExpectingErrors(gSource, new[] { siblingDll }, workDir);
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    private static string CompileAndRun(string source, IReadOnlyCollection<string> references, string workDir)
    {
        var srcPath = Path.Combine(workDir, "test.gs");
        var outPath = Path.Combine(workDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = GscArgs(outPath, "exe", references, srcPath);
        var (exitCode, diagnostics) = RunCompiler(args);
        Assert.True(exitCode == 0, diagnostics);

        IlVerifier.Verify(outPath, additionalReferences: references);

        var runtimeConfig = Path.ChangeExtension(outPath, ".runtimeconfig.json");
        if (!File.Exists(runtimeConfig))
        {
            File.WriteAllText(runtimeConfig, """
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
            WorkingDirectory = workDir,
        };
        psi.ArgumentList.Add("exec");
        psi.ArgumentList.Add("--runtimeconfig");
        psi.ArgumentList.Add(runtimeConfig);
        psi.ArgumentList.Add(outPath);

        using var proc = Process.Start(psi) ?? throw new InvalidOperationException("failed to start dotnet exec");
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
        Assert.True(proc.ExitCode == 0, $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.Replace("\r\n", "\n");
    }

    private static List<string> CompileExpectingErrors(string source, IReadOnlyCollection<string> references, string workDir)
    {
        var srcPath = Path.Combine(workDir, "test.gs");
        var outPath = Path.Combine(workDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var (exitCode, diagnostics) = RunCompiler(GscArgs(outPath, "exe", references, srcPath));
        Assert.True(exitCode != 0, "expected gsc to report errors but it succeeded");
        return diagnostics.Split('\n', StringSplitOptions.RemoveEmptyEntries).ToList();
    }

    private static string[] GscArgs(string outPath, string target, IReadOnlyCollection<string> references, string srcPath)
    {
        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:" + target,
            "/targetframework:net10.0",
            "/nowarn:GS9100",
        };
        foreach (var reference in references.Concat(TrustedPlatformAssemblies()))
        {
            args.Add("/reference:" + reference);
        }

        args.Add(srcPath);
        return args.ToArray();
    }

    private static (int ExitCode, string Diagnostics) RunCompiler(string[] args)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousErr = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            return (Program.Main(args), stdout.ToString() + stderr);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousErr);
        }
    }

    private static string BuildCsLibrary(string workDir, string source, string assemblyName)
    {
        var csDir = Path.Combine(workDir, "csref");
        Directory.CreateDirectory(csDir);
        File.WriteAllText(Path.Combine(csDir, "Lib.cs"), source);
        File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), $"""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <OutputType>Library</OutputType>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
                <LangVersion>latest</LangVersion>
                <NoWarn>1591;SA1649;SA1518;SA1516;SA1122;SA1201;CS8618</NoWarn>
                <RunAnalyzers>false</RunAnalyzers>
                <AssemblyName>{assemblyName}</AssemblyName>
                <RootNamespace>{assemblyName}</RootNamespace>
              </PropertyGroup>
            </Project>
            """);

        RunDotnet(csDir, "restore");
        var outDir = Path.Combine(csDir, "out");
        RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore", "-o", outDir);

        var dll = Path.Combine(outDir, assemblyName + ".dll");
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
        foreach (var arg in args)
        {
            psi.ArgumentList.Add(arg);
        }

        using var proc = Process.Start(psi) ?? throw new InvalidOperationException($"failed to start dotnet {string.Join(" ", args)}");
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        Assert.True(proc.WaitForExit(120_000), $"dotnet {args[0]} timed out");
        Assert.True(proc.ExitCode == 0, $"dotnet {string.Join(" ", args)} failed ({proc.ExitCode})\nstdout:\n{stdout}\nstderr:\n{stderr}");
    }

    private static string CreateWorkDir(string prefix)
    {
        var root = Path.Combine(Environment.CurrentDirectory, "TestArtifacts");
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, prefix + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
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

    private static void TryDelete(string path)
    {
        try
        {
            if (Directory.Exists(path))
            {
                Directory.Delete(path, recursive: true);
            }
        }
        catch
        {
        }
    }
}
