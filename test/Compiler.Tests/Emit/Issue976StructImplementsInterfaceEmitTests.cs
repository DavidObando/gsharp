// <copyright file="Issue976StructImplementsInterfaceEmitTests.cs" company="GSharp">
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
/// Issue #976: a G# <c>struct</c> (CLR value type) may declare an
/// implemented-interface clause (<c>struct Money : IEquatable[Money] { … }</c>),
/// mirroring a <c>class</c>. The struct's clause may list interfaces only — a
/// base class or base struct is rejected with GS0382. Each happy-path test
/// compiles via <c>gsc</c>, runs <c>ilverify</c> on the produced assembly, then
/// either reflects the emitted metadata or runs the assembly under
/// <c>dotnet exec</c> to assert end-to-end behavior (including boxing through
/// the interface receiver).
/// </summary>
public class Issue976StructImplementsInterfaceEmitTests
{
    [Fact]
    public void Struct_ImplementsIEquatable_DirectAndThroughInterface_RunsAndIlVerifies()
    {
        // Canonical issue repro: a value-type struct implements
        // IEquatable[Money], calling Equals directly AND through the
        // IEquatable[Money] interface (which boxes the struct).
        var source = """
            package Probe
            import System

            struct Money : IEquatable[Money] {
                var Cents int32
                func Equals(other Money) bool { return Cents == other.Cents }
            }

            var a = Money{ Cents: 100 }
            var b = Money{ Cents: 100 }
            var c = Money{ Cents: 200 }
            Console.WriteLine(a.Equals(b))
            Console.WriteLine(a.Equals(c))
            var ie IEquatable[Money] = a
            Console.WriteLine(ie.Equals(b))
            Console.WriteLine(ie.Equals(c))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\nTrue\nFalse\n", output);
    }

    [Fact]
    public void Struct_MetadataDeclaresInterfaceImpl_AndEqualsIsVirtual()
    {
        // Reflect over the emitted assembly with a MetadataLoadContext to
        // confirm the struct TypeDef carries an InterfaceImpl row for
        // System.IEquatable<Money> and the satisfying method is virtual so the
        // value type correctly fills the interface slot.
        var source = """
            package Probe
            import System

            struct Money : IEquatable[Money] {
                var Cents int32
                func Equals(other Money) bool { return Cents == other.Cents }
            }
            """;

        var dllPath = CompileLibrary(source);
        try
        {
            var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
            var resolver = new System.Reflection.PathAssemblyResolver(
                Directory.GetFiles(runtimeDir, "*.dll")
                    .Concat(new[] { dllPath }));
            using var mlc = new MetadataLoadContext(resolver, "System.Private.CoreLib");
            var asm = mlc.LoadFromAssemblyPath(dllPath);
            var type = asm.GetType("Probe.Money")
                ?? throw new InvalidOperationException("type not found");

            Assert.True(type.IsValueType, "Money must be a value type (struct)");

            var interfaces = type.GetInterfaces().Select(i => i.Name).ToArray();
            Assert.Contains(interfaces, i => i.StartsWith("IEquatable", StringComparison.Ordinal));

            var method = type.GetMethod("Equals", new[] { type })
                ?? throw new InvalidOperationException("Equals(Money) not found");
            Assert.True(method.IsVirtual, "Equals(Money) must be virtual to implement the interface");
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    [Fact]
    public void Struct_ImplementsIComparable_DispatchesThroughInterface()
    {
        var source = """
            package Probe
            import System

            struct Money : IComparable[Money] {
                var Cents int32
                func CompareTo(other Money) int32 { return Cents - other.Cents }
            }

            var a = Money{ Cents: 100 }
            var b = Money{ Cents: 200 }
            var ic IComparable[Money] = a
            Console.WriteLine(ic.CompareTo(b))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("-100\n", output);
    }

    [Fact]
    public void DataStruct_ImplementsCustomInterface_DispatchesThroughInterface()
    {
        // A `data struct` (value type with a primary constructor) implements a
        // user-declared G# interface and is consumed through the interface
        // receiver (which boxes).
        var source = """
            package Probe
            import System

            interface IShape {
                func Area() float64;
            }

            data struct Rect(Width float64, Height float64) : IShape {
                func Area() float64 { return Width * Height }
            }

            var r = Rect{ Width: 3.0, Height: 4.0 }
            var s IShape = r
            Console.WriteLine(s.Area())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("12\n", output);
    }

    [Fact]
    public void GenericStruct_ImplementsGenericInterface_DispatchesThroughInterface()
    {
        // Ties into #974: a generic struct implements a generic interface whose
        // member returns the constructed generic type argument. Dispatch
        // through the constructed interface must reach the struct's body.
        var source = """
            package Probe
            import System

            interface IBox[T] {
                func Get() T;
            }

            struct Box[T] : IBox[T] {
                var Value T
                func Get() T { return Value }
            }

            var b = Box[int32]{ Value: 42 }
            var ib IBox[int32] = b
            Console.WriteLine(ib.Get())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void Struct_NamingClassAsBase_IsRejected()
    {
        // A struct (value type) cannot declare a user class as a base type.
        var source = """
            package Probe

            class Base { var X int32 }

            struct S : Base { var Y int32 }
            """;

        var diagnostics = CompileExpectingErrors(source);
        Assert.Contains(diagnostics, d => d.Contains("GS0382"));
    }

    [Fact]
    public void Struct_FailingToImplementInterfaceMember_IsRejected()
    {
        // A struct that declares an interface but does not provide the
        // required member is rejected with the GS0187 channel.
        var source = """
            package Probe
            import System

            struct Money : IComparable[Money] {
                var Cents int32
            }
            """;

        var diagnostics = CompileExpectingErrors(source);
        Assert.Contains(diagnostics, d => d.Contains("GS0187"));
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue976_lib_").FullName;
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue976_").FullName;
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue976_err_").FullName;
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

            var combined = compileOut.ToString() + compileErr.ToString();
            return combined.Split('\n').Where(l => !string.IsNullOrWhiteSpace(l)).ToList();
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
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
