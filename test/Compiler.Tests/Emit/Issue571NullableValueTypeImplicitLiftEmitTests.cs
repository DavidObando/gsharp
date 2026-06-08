// <copyright file="Issue571NullableValueTypeImplicitLiftEmitTests.cs" company="GSharp">
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
/// Issue #571: passing a value-type <c>T</c> (e.g. <c>System.TimeSpan</c>) to a
/// CLR constructor or method parameter typed <c>T?</c> (e.g. <c>TimeSpan?</c>)
/// triggered an emit-time ICE — <c>GS9998 TypeBuilder generic instantiation
/// does not support resolving members</c> — with a bogus <c>(1,1,1,1)</c>
/// location in an unrelated source file.
///
/// <para>
/// Root cause: every Nullable&lt;T&gt; construction in the emit pipeline used
/// host-runtime <c>typeof(System.Nullable&lt;&gt;).MakeGenericType(innerClr)</c>.
/// When <c>innerClr</c> was MLC-backed (an imported value type like
/// <c>TimeSpan</c>), the constructed <c>Nullable&lt;TimeSpan&gt;</c> mixed the
/// host-side <c>Nullable&lt;&gt;</c> open generic with an MLC-backed
/// <c>TimeSpan</c> argument. Encoding the resulting ctor / member reference
/// then failed inside <c>TypeBuilder</c>/<c>MetadataBuilder</c>.
/// </para>
///
/// <para>
/// PR N-2 reroutes every Nullable&lt;T&gt; construction in the emit pipeline
/// through <see cref="GSharp.Core.CodeAnalysis.Symbols.NullableLifting.TryConstructNullable"/>,
/// which resolves <c>System.Nullable`1</c> from the <c>ReferenceResolver</c>
/// and projects the inner value type onto the same load context.
/// </para>
/// </summary>
public class Issue571NullableValueTypeImplicitLiftEmitTests
{
    [Fact]
    public void TimeSpan_Implicit_Lift_To_Nullable_TimeSpan_Sibling_Ctor()
    {
        // Exact repro from the issue body: a sibling C# class whose ctor
        // accepts `TimeSpan?`, invoked from G# with a bare `TimeSpan` value.
        // Before the fix this emitted GS9998 with a bogus `(1,1,1,1)`
        // location pointing at an unrelated file.
        var sibling = """
            namespace Probe.CSharp
            {
                public sealed class TimespanCtor
                {
                    public TimespanCtor(System.TimeSpan? delay = null) { Delay = delay; }
                    public System.TimeSpan? Delay { get; }
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            var c = TimespanCtor(TimeSpan.FromSeconds(2.0))
            Console.WriteLine(c.Delay.HasValue)
            Console.WriteLine(c.Delay.Value.TotalSeconds)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("True\n2\n", output);
    }

    [Fact]
    public void TimeSpan_Implicit_Lift_To_Nullable_TimeSpan_Sibling_Method()
    {
        // Same lift but at an instance-method call site rather than a ctor.
        // Exercises the MethodBodyEmitter.Conversions path for arguments to
        // CLR methods on imported sibling types.
        var sibling = """
            namespace Probe.CSharp
            {
                public sealed class DelayBag
                {
                    public System.TimeSpan? Last { get; private set; }
                    public void Record(System.TimeSpan? delay) { Last = delay; }
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            var bag = DelayBag()
            bag.Record(TimeSpan.FromSeconds(5.0))
            Console.WriteLine(bag.Last.HasValue)
            Console.WriteLine(bag.Last.Value.TotalSeconds)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("True\n5\n", output);
    }

    [Fact]
    public void TimeSpan_Implicit_Lift_To_Nullable_TimeSpan_Local()
    {
        // A purely local lift `var d TimeSpan? = TimeSpan.FromSeconds(...)`
        // exercises the same emit path without an intervening sibling type;
        // it guards against host-runtime regressions in the same site.
        var sibling = """
            namespace Probe.CSharp
            {
                public static class Sink
                {
                    public static void Take(System.TimeSpan? t) { System.Console.WriteLine(t.HasValue); }
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            var d = TimeSpan.FromSeconds(3.0)
            Sink.Take(d)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("True\n", output);
    }

    private static string CompileAndRunWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue571_sib_").FullName;
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
        _ = RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore");

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
}
