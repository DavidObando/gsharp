// <copyright file="Issue527StructDelegateFieldEmitTests.cs" company="GSharp">
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
/// Issue #527: public fields on a CLR <c>struct</c> imported through a sibling
/// assembly were unreachable from G#. Reading the field reported
/// <c>GS0158: Cannot find member</c>; assigning to it likewise reported
/// <c>GS0158</c>; and an invocation on a delegate-typed field
/// (<c>bag.OnAsk()</c>) reported <c>GS0159: Cannot find function</c>. After
/// the fix, public fields on CLR structs behave like public fields on CLR
/// classes: they are readable, writable, and (when delegate-typed) invokable.
/// The emitter must produce verifiable IL for all three forms.
/// </summary>
public class Issue527StructDelegateFieldEmitTests
{
    [Fact]
    public void ClrStruct_Int32Field_ReadWrite_RoundTrips()
    {
        // The simplest case: a public int field on a CLR struct. Before the
        // fix, even this failed because the binder/emitter took a
        // value-typed receiver path that lost track of public fields.
        var sibling = """
            namespace Probe.CSharp
            {
                public struct CounterBag
                {
                    public int Counter;
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            var bag = CounterBag()
            bag.Counter = 42
            Console.WriteLine(bag.Counter)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void ClrStruct_StringField_ReadWrite_RoundTrips()
    {
        // A reference-typed field still needs to round-trip; the field
        // store/load IL must use the right `stfld`/`ldfld` rather than a
        // boxed surrogate.
        var sibling = """
            namespace Probe.CSharp
            {
                public struct NameBag
                {
                    public string Name;
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            var bag = NameBag()
            bag.Name = "hello"
            Console.WriteLine(bag.Name)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("hello\n", output);
    }

    [Fact]
    public void ClrStruct_DelegateField_AssignReadInvoke_Works()
    {
        // The exact issue-body repro plus a read of the delegate value: the
        // field is assigned a function literal, read back into a local
        // (`var f = bag.OnAsk`), invoked through the local, and invoked
        // through the field directly. All three steps must compile and
        // produce verifiable IL.
        var sibling = """
            namespace Probe.CSharp
            {
                public struct CallbackBag
                {
                    public System.Func<string> OnAsk;
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            var bag = CallbackBag()
            bag.OnAsk = func() string { return "hello" }
            var f = bag.OnAsk
            Console.WriteLine(f())
            Console.WriteLine(bag.OnAsk())
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("hello\nhello\n", output);
    }

    [Fact]
    public void ClrStruct_PassedByValue_MutationsDoNotEscape()
    {
        // CLR semantics: passing a struct by value copies it, so any
        // mutations made inside the callee must not be visible to the
        // caller. This is a behavioral regression guard — the emitter must
        // not accidentally pass the struct by reference.
        var sibling = """
            namespace Probe.CSharp
            {
                public struct CounterBag
                {
                    public int Counter;
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            func Bump(b CounterBag) {
                b.Counter = b.Counter + 100
            }

            var bag = CounterBag()
            bag.Counter = 1
            Bump(bag)
            Console.WriteLine(bag.Counter)
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("1\n", output);
    }

    [Fact]
    public void ClrStruct_DelegateField_InsideMethodBody_AssignReadInvoke_Works()
    {
        // The exact issue-body repro: a G# class method body invokes the
        // delegate field on a local CLR-struct value. This mirrors the
        // shape from the bug report (GS0158 on the assignment, GS0159 on
        // the invocation). Confirms that the fix carries through to
        // method-body binding (Stream A's accessor chain) just like the
        // top-level binding path.
        var sibling = """
            namespace Probe.CSharp
            {
                public struct CallbackBag
                {
                    public System.Func<string> OnAsk;
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            class StructFieldProbe {
                func Test() string {
                    var bag = CallbackBag()
                    bag.OnAsk = func() string { return "hello" }
                    return bag.OnAsk()
                }
            }

            var probe = StructFieldProbe{}
            Console.WriteLine(probe.Test())
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("hello\n", output);
    }

    [Fact]
    public void ClrClass_DelegateField_AssignReadInvoke_Works_RegressionGuard()
    {
        // Regression guard: the same scenario on a CLR class (not a struct)
        // already worked before the fix and must keep working after it. If
        // the fix accidentally re-routes class field access, this catches it.
        var sibling = """
            namespace Probe.CSharp
            {
                public class CallbackHolder
                {
                    public System.Func<string> OnAsk;
                }
            }
            """;

        var gsource = """
            package Probe.Tests
            import System
            import Probe.CSharp

            var holder = CallbackHolder()
            holder.OnAsk = func() string { return "world" }
            Console.WriteLine(holder.OnAsk())
            """;

        var output = CompileAndRunWithSiblingCs(sibling, gsource, siblingName: "Probe.CSharp");
        Assert.Equal("world\n", output);
    }

    [Fact]
    public void GSharpStruct_DelegateField_AssignReadInvoke_Works()
    {
        // G#-defined struct with a delegate-typed field exercises the same
        // call-as-field path through the binder/emitter without crossing the
        // import boundary. The struct is value-typed, so the field load
        // emits `ldloca; ldfld` (the by-ref-receiver path for value types).
        var source = """
            package Probe.Tests
            import System

            struct CallbackBag {
                var OnAsk func() string
            }

            var bag = CallbackBag{ OnAsk: func() string { return "hi" } }
            Console.WriteLine(bag.OnAsk())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hi\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue527_").FullName;
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue527_sib_").FullName;
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

        var stdout = RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore");
        _ = stdout;

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
