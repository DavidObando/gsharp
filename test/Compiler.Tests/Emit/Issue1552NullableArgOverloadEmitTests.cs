// <copyright file="Issue1552NullableArgOverloadEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1552 — when an argument has a nullable REFERENCE type <c>S?</c> and
/// two overloads differ only in a parameter that is a base type (<c>object</c>
/// or a base class/interface) versus the more-derived <c>S</c>, overload
/// resolution failed to pick the more-specific <c>S</c> overload and instead
/// reported GS0266 (ambiguous). The non-nullable <c>S</c> argument already
/// resolved correctly because the derived parameter scored an exact-type match;
/// a nullable <c>S?</c> argument never equals a non-nullable parameter, so both
/// candidates tied.
/// <para>
/// The fix has two coupled parts: (1) <c>Conversion.Classify</c> now narrows a
/// nullable reference source <c>S?</c> to its underlying reference type for
/// classification, so a user-declared <c>Dog? -&gt; Dog</c>/<c>Dog? -&gt; Animal</c>
/// converts implicitly exactly as an imported <c>Type? -&gt; Type</c> already
/// did; and (2) the user-function overload resolver breaks a score tie by C#
/// §7.5.3.2's "more specific reference parameter" rule when the argument is a
/// nullable reference type, so the most-derived applicable parameter wins.
/// Genuinely non-orderable ties (two unrelated interfaces) stay ambiguous, and
/// value-type nullables (<c>int32?</c>) are untouched.
/// </para>
/// Each test uses a UNIQUE package name and UNIQUE user-type names because the
/// in-process <c>FunctionTypeSymbol</c> cache is name-keyed for user types.
/// </summary>
public class Issue1552NullableArgOverloadEmitTests
{
    [Fact]
    public void EndToEnd_ImportedBase_NullableTypeArg_SelectsDerivedType()
    {
        const string source = """
            package i1552imported
            import System

            func F(caller object) int32 -> 1
            func F(caller Type) int32 -> 2

            func UseNull(t Type?) int32 -> F(t)

            func Main() { System.Console.WriteLine(UseNull(typeof(int32))) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n", output);
    }

    [Fact]
    public void EndToEnd_ImportedBase_NonNullTypeArg_SelectsDerivedType_Regression()
    {
        const string source = """
            package i1552importednn
            import System

            func F(caller object) int32 -> 1
            func F(caller Type) int32 -> 2

            func UseNN(t Type) int32 -> F(t)

            func Main() { System.Console.WriteLine(UseNN(typeof(int32))) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n", output);
    }

    [Fact]
    public void EndToEnd_UserBaseDerived_NullableArg_SelectsDerivedClass()
    {
        const string source = """
            package i1552userclass
            import System

            open class Wolf1552 {}
            class Husky1552 : Wolf1552 {}

            func G(a Wolf1552) int32 -> 1
            func G(d Husky1552) int32 -> 2

            func Use(d Husky1552?) int32 -> G(d)

            func Main() { System.Console.WriteLine(Use(Husky1552())) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n", output);
    }

    [Fact]
    public void EndToEnd_UserBaseDerived_NonNullArg_SelectsDerivedClass_Regression()
    {
        const string source = """
            package i1552userclassnn
            import System

            open class Cat1552 {}
            class Lion1552 : Cat1552 {}

            func G(a Cat1552) int32 -> 1
            func G(d Lion1552) int32 -> 2

            func Use(d Lion1552) int32 -> G(d)

            func Main() { System.Console.WriteLine(Use(Lion1552())) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n", output);
    }

    [Fact]
    public void EndToEnd_DeepHierarchy_NullableArg_SelectsMostDerived()
    {
        const string source = """
            package i1552deep
            import System

            open class RootA1552 {}
            open class MidB1552 : RootA1552 {}
            class LeafC1552 : MidB1552 {}

            func K(a RootA1552) int32 -> 1
            func K(c LeafC1552) int32 -> 3

            func Use(c LeafC1552?) int32 -> K(c)

            func Main() { System.Console.WriteLine(Use(LeafC1552())) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n", output);
    }

    [Fact]
    public void EndToEnd_DifferingParameterNotFirst_NullableArg_SelectsDerivedType()
    {
        const string source = """
            package i1552position
            import System

            func H(n int32, c object) int32 -> 1
            func H(n int32, c Type) int32 -> 2

            func Use(t Type?) int32 -> H(3, t)

            func Main() { System.Console.WriteLine(Use(typeof(int32))) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n", output);
    }

    [Fact]
    public void EndToEnd_InterfaceVersusImplementingClass_NullableArg_SelectsClass()
    {
        const string source = """
            package i1552iface
            import System

            interface IFoo1552 { func Foo() int32; }
            class Bar1552 : IFoo1552 { func Foo() int32 -> 5 }

            func P2(x IFoo1552) int32 -> 1
            func P2(x Bar1552) int32 -> 2

            func Use(b Bar1552?) int32 -> P2(b)

            func Main() { System.Console.WriteLine(Use(Bar1552())) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n", output);
    }

    [Fact]
    public void CompileOnly_TwoUnrelatedInterfaces_NullableArg_StaysAmbiguous()
    {
        const string source = """
            package i1552ambiguous
            import System

            interface IA1552 { func A() int32; }
            interface IB1552 { func B() int32; }
            class Baz1552 : IA1552, IB1552 {
              func A() int32 -> 1
              func B() int32 -> 2
            }

            func M(x IA1552) int32 -> 1
            func M(x IB1552) int32 -> 2

            func Use(b Baz1552?) int32 -> M(b)

            func Main() { System.Console.WriteLine(0) }
            """;

        var (exit, output) = CompileOnly(source);
        Assert.NotEqual(0, exit);
        Assert.Contains("GS0266", output);
    }

    [Fact]
    public void CompileOnly_ValueTypeNullable_NarrowingStaysExplicitError()
    {
        // Regression guard: the #1552 nullable-source narrowing is scoped to
        // REFERENCE underlyings, so a value-type `int32?` argument still does
        // NOT implicitly convert to a non-nullable `int32` parameter. If this
        // ever compiles the reference-only gate has leaked into value types.
        const string source = """
            package i1552value
            import System

            func Take(x int32) int32 -> x

            func Use(v int32?) int32 -> Take(v)

            func Main() { System.Console.WriteLine(0) }
            """;

        var (exit, output) = CompileOnly(source);
        Assert.NotEqual(0, exit);
        Assert.Contains("GS0154", output);
    }

    private static (int Exit, string Output) CompileOnly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1552_neg_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
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

            return (compileExit, stdoutWriter + stderrWriter.ToString());
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1552_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
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
                $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            IlVerifier.Verify(dllPath);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
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
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

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
}
