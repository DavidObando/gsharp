// <copyright file="Issue524DefaultCtorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #524: a class declared without an explicit <c>init(...)</c>
/// constructor must still be constructible via <c>T()</c> (matching the CLR /
/// C# behaviour of synthesising a parameterless default constructor that
/// zero-initialises every field). The same applies to imported CLR value
/// types: every <c>struct</c> implicitly has a zero-initialising default
/// constructor that maps to <c>initobj</c> in IL even though
/// <see cref="Type.GetConstructors(BindingFlags)"/> does not surface it.
///
/// Each test compiles via <c>gsc</c>, ilverifies the produced PE, then
/// executes the assembly under <c>dotnet exec</c> and asserts on the
/// captured stdout.
/// </summary>
public class Issue524DefaultCtorEmitTests
{
    [Fact]
    public void GSharpClass_FieldsOnly_NoInit_DefaultConstructedAndFieldsRead()
    {
        // Repro 1 from the issue body, condensed to a runnable program: a
        // class with only fields and no explicit `init(...)` must be
        // constructible via `Holder()`, and the fields must be zero-init.
        var source = """
            package P
            import System

            type Holder class {
                Value int32
                Name  string
                Flag  bool
            }

            var h = Holder()
            Console.WriteLine(h.Value)
            Console.WriteLine(h.Name)
            Console.WriteLine(h.Flag)
            """;

        var output = CompileAndRun(source);
        // String fields default to CLR `null`, which Console.WriteLine
        // prints as an empty line.
        Assert.Equal("0\n\nFalse\n", output);
    }

    [Fact]
    public void GSharpClass_FieldsAndMethods_NoInit_DefaultConstructed()
    {
        // A class declaring both fields and methods (but still no `init`)
        // must round-trip: default-construct, mutate a field from outside,
        // observe via a method that closes over `this`.
        var source = """
            package P
            import System

            type Counter class {
                Count int32

                func Get() int32 {
                    return this.Count
                }
            }

            var c = Counter()
            c.Count = c.Count + 1
            c.Count = c.Count + 1
            c.Count = c.Count + 1
            Console.WriteLine(c.Get())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n", output);
    }

    [Fact]
    public void GSharpClass_NoMembersAtAll_DefaultConstructed()
    {
        // Degenerate case: a class with an empty body must still be
        // constructible. Mirrors C#'s `class Empty {}` semantics. Reaching
        // the println past the construction site proves the synthesised
        // ctor was both emitted and callable.
        var source = """
            package P
            import System

            type Empty class { }

            var e = Empty()
            Console.WriteLine("ok")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("ok\n", output);
    }

    [Fact]
    public void GSharpClass_ExplicitInit_StillWorks_RegressionGuard()
    {
        // Regression guard: classes that DO declare an explicit `init(...)`
        // must continue to be bound against that constructor's parameter
        // list. The fix for #524 must not short-circuit user-declared
        // constructors.
        var source = """
            package P
            import System

            type Point class {
                X int32
                Y int32

                init(x int32, y int32) {
                    X = x
                    Y = y
                }
            }

            var p = Point(3, 4)
            Console.WriteLine(p.X)
            Console.WriteLine(p.Y)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n4\n", output);
    }

    [Fact]
    public void GSharpClass_PrimaryConstructor_StillWorks_RegressionGuard()
    {
        // Regression guard: primary-ctor classes must keep working after
        // the binder's `IsClass`-and-no-ctor relaxation.
        var source = """
            package P
            import System

            type Box class(value int32) { }

            var b = Box(42)
            Console.WriteLine(b.value)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void GSharpClass_NoInit_WrongArgCount_ReportsDiagnostic()
    {
        // The synthesised default ctor takes zero arguments. Calling the
        // class with a positional argument must report a wrong-argument-
        // count diagnostic against the class — not a misleading conversion
        // error or "function doesn't exist".
        var source = """
            package P
            import System

            type Holder class { Value int32 }

            var h = Holder(1)
            Console.WriteLine(h.Value)
            """;

        var (exit, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exit);
        // gsc emits diagnostics through Console.Out, which our test
        // harness captures into `stdout`.
        Assert.Contains("Holder", stdout + stderr);
    }

    [Fact]
    public void ImportedClrStruct_NoExplicitCtors_DefaultConstructed_HashCode()
    {
        // System.HashCode is a public BCL struct with no explicit
        // constructors. `HashCode()` must zero-initialise it (the CLR
        // default) and the resulting instance must be usable.
        var source = """
            package P
            import System

            var h = HashCode()
            h.Add("alpha")
            h.Add("beta")
            var code int32 = h.ToHashCode()
            Console.WriteLine(code != 0)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void ImportedClrStruct_NoExplicitCtors_FromProbeAssembly()
    {
        // The exact shape from Repro 2 in the issue body: a user-authored
        // C# struct with no explicit constructors, imported into G# and
        // default-constructed via `CallbackBag()`. The probe assembly is
        // produced by Reflection.Emit (mirroring the issue #519 pattern).
        var source = """
            package P
            import System
            import Probe.CSharp

            var bag = CallbackBag()
            Console.WriteLine(bag.Counter)
            Console.WriteLine(bag.Label)
            """;

        var output = CompileAndRunWithProbe(source);
        // Label is a reference-type field on a freshly zero-initialised
        // value type, so it reads back as CLR `null` and prints empty.
        Assert.Equal("0\n\n", output);
    }

    [Fact]
    public void ImportedClrStruct_WithExplicitCtor_DefaultConstructorStillWorks()
    {
        // Regression guard for #524: a CLR struct that DOES declare an
        // explicit constructor must still also be constructible via the
        // implicit zero-init default constructor (this matches C# where
        // `new TimeSpan()` and `new TimeSpan(1, 0, 0)` both compile).
        var source = """
            package P
            import System

            var zero = TimeSpan()
            Console.WriteLine(zero.Ticks)
            var oneHour = TimeSpan(1, 0, 0)
            Console.WriteLine(oneHour.TotalMinutes)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n60\n", output);
    }

    [Fact]
    public void ImportedClrClass_WithDefaultCtor_RegressionGuard()
    {
        // Regression guard: a CLR class with a public parameterless
        // constructor must continue to be callable as `T()` — the issue
        // #524 fallback only triggers for value types, so reference-type
        // resolution must be unchanged.
        var source = """
            package P
            import System
            import System.Text

            var sb = StringBuilder()
            sb.Append("ok")
            Console.WriteLine(sb.ToString())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("ok\n", output);
    }

    [Fact]
    public void GSharpGenericClass_NoInit_DefaultConstructed_ReferenceTypeArg()
    {
        // The fix also applies to generic class definitions: `Box[string]()`
        // must work when `Box[T]` declares neither a primary ctor nor an
        // explicit `init(...)`. (Note: G# uses type-erased generics, so a
        // value-type type argument would leave the erased `object` field
        // null — same pre-existing limitation as `Box[int32]{}` literals.
        // We test only the reference-T case here, which round-trips
        // cleanly through the erased representation.)
        var source = """
            package P
            import System

            type Box[T] class {
                Value T
            }

            var bs = Box[string]()
            Console.WriteLine(bs.Value)
            """;

        var output = CompileAndRun(source);
        // Default-string is CLR null, which Console.WriteLine prints as
        // an empty line.
        Assert.Equal("\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var (exit, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: true);
        Assert.True(
            exit == 0,
            $"exited {exit}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static string CompileAndRunWithProbe(string source)
    {
        var (exit, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: true, withProbe: true);
        Assert.True(
            exit == 0,
            $"exited {exit}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(
        string source,
        bool expectSuccess,
        bool withProbe = false)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue524_").FullName;
        try
        {
            string probeDllPath = null;
            if (withProbe)
            {
                probeDllPath = Path.Combine(tempDir, "ProbeCSharp.dll");
                BuildProbeLibrary(probeDllPath);
            }

            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };
            if (probeDllPath != null)
            {
                args.Add("/r:" + probeDllPath);
            }

            foreach (var bcl in BclReferences.Value)
            {
                args.Add("/r:" + bcl);
            }

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

            if (!expectSuccess)
            {
                return (compileExit, compileOut.ToString(), compileErr.ToString());
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            var verifyRefs = probeDllPath != null ? new[] { probeDllPath } : null;
            IlVerifier.Verify(outPath, additionalReferences: verifyRefs);

            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(
                runtimeConfigPath,
                """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(runtimeConfigPath);
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            return (proc.ExitCode, stdout.Replace("\r\n", "\n"), stderr.Replace("\r\n", "\n"));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    /// <summary>
    /// Builds a small probe assembly containing a public struct
    /// <c>Probe.CSharp.CallbackBag</c> with two instance fields and no
    /// explicit constructors. Mirrors Repro 2 from issue #524 — and the
    /// exact shape that fails on <c>main</c> prior to the fix.
    /// </summary>
    private static void BuildProbeLibrary(string dllPath)
    {
        var coreAssembly = typeof(object).Assembly;

        var asmName = new AssemblyName("ProbeCSharp") { Version = new Version(1, 0, 0, 0) };
        var asmBuilder = new PersistedAssemblyBuilder(asmName, coreAssembly);
        var moduleBuilder = asmBuilder.DefineDynamicModule("ProbeCSharp");

        var typeBuilder = moduleBuilder.DefineType(
            "Probe.CSharp.CallbackBag",
            TypeAttributes.Public
                | TypeAttributes.SequentialLayout
                | TypeAttributes.Sealed
                | TypeAttributes.BeforeFieldInit
                | TypeAttributes.AnsiClass,
            parent: typeof(ValueType));

        typeBuilder.DefineField("Counter", typeof(int), FieldAttributes.Public);
        typeBuilder.DefineField("Label", typeof(string), FieldAttributes.Public);

        // Intentionally do NOT define any constructors — the whole point of
        // the probe is to exercise the implicit value-type default
        // constructor that Type.GetConstructors does not surface.
        typeBuilder.CreateType();
        asmBuilder.Save(dllPath);
    }

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(() =>
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir))
        {
            return Array.Empty<string>();
        }

        return Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
            .Where(p =>
            {
                var name = Path.GetFileName(p);
                return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "mscorlib.dll", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase);
            })
            .ToList();
    });
}
