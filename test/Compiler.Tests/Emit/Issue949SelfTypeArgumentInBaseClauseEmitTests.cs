// <copyright file="Issue949SelfTypeArgumentInBaseClauseEmitTests.cs" company="GSharp">
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
/// Issue #949: a G# class must be allowed to name itself as a generic type
/// ARGUMENT in its own base/implements clause — the common C# pattern
/// <c>class Shape : IEquatable&lt;Shape&gt;</c>. Previously this was rejected
/// with <c>GS0113</c> ("Type 'Shape' doesn't exist") because the enclosing
/// type was not yet in scope when its base clause was bound.
///
/// The fix registers the in-progress type before its base clause is bound, so
/// the self type argument resolves; binds and emits the constructed CLR
/// generic interface (<c>IEquatable&lt;Shape&gt;</c>) against the real
/// (non-erased) type argument; and adds a narrow self-inheritance guard
/// (<c>GS0378</c>) so genuine <c>class A : A</c> stays rejected.
///
/// Each happy-path test compiles via <c>gsc</c>, runs <c>ilverify</c> on the
/// produced assembly, then runs or reflects it to assert end-to-end behavior.
/// </summary>
public class Issue949SelfTypeArgumentInBaseClauseEmitTests
{
    [Fact]
    public void Class_NamesItselfAsTypeArgument_InClrInterface_RunsAndIlVerifies()
    {
        // Canonical issue: `class Shape : IEquatable[Shape]` implementing
        // `Equals(Shape) bool`. The method must be callable directly AND via
        // an `IEquatable[Shape]`-typed interface receiver.
        // A primary constructor is used so the field is assigned inside the
        // synthesized .ctor (a struct/class literal `Shape{X: 5}` would write
        // the readonly `let` field outside any .ctor, which ilverify rejects
        // with InitOnly — an unrelated, pre-existing emit limitation).
        var source = """
            package Probe
            import System

            open class Shape(X int32) : IEquatable[Shape] {
                func Equals(other Shape) bool {
                    return X == other.X
                }
            }

            var a = Shape(5)
            var b = Shape(5)
            var c = Shape(7)
            Console.WriteLine(a.Equals(b))
            Console.WriteLine(a.Equals(c))
            var e IEquatable[Shape] = a
            Console.WriteLine(e.Equals(b))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\nTrue\n", output);
    }

    [Fact]
    public void Class_NamesItselfAsTypeArgument_MetadataDeclaresConstructedInterfaceImpl()
    {
        // Reflect over the emitted assembly: the TypeDef must carry an
        // InterfaceImpl for the CONSTRUCTED `IEquatable<Shape>` (not the
        // type-erased `IEquatable<object>`), and `Equals` must be virtual so
        // the CLR vtable wires it to the interface slot.
        var source = """
            package Probe
            import System

            open class Shape : IEquatable[Shape] {
                let X int32
                func Equals(other Shape) bool {
                    return X == other.X
                }
            }
            """;

        var dllPath = CompileLibrary(source);
        try
        {
            var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
            var resolver = new System.Reflection.PathAssemblyResolver(
                Directory.GetFiles(runtimeDir, "*.dll").Concat(new[] { dllPath }));
            using var mlc = new MetadataLoadContext(resolver, "System.Private.CoreLib");
            var asm = mlc.LoadFromAssemblyPath(dllPath);
            var shape = asm.GetType("Probe.Shape")
                ?? throw new InvalidOperationException("Probe.Shape not found");

            var implemented = shape.GetInterfaces();
            var equatable = implemented.SingleOrDefault(i =>
                i.IsGenericType
                && i.GetGenericTypeDefinition().FullName == "System.IEquatable`1");
            Assert.NotNull(equatable);

            // The single type argument must be Probe.Shape itself — proving the
            // self type argument survived erasure into the metadata.
            var arg = equatable!.GetGenericArguments().Single();
            Assert.Equal("Probe.Shape", arg.FullName);

            var equals = shape.GetMethod("Equals", new[] { shape })
                ?? throw new InvalidOperationException("Equals(Shape) not found");
            Assert.True(equals.IsVirtual, "Equals(Shape) must be virtual to implement IEquatable<Shape>");
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    [Fact]
    public void GenericClass_NamesItselfAsTypeArgument_BindsEmitsAndIlVerifies()
    {
        // `class Node[T] : IEquatable[Node[T]]` — the enclosing GENERIC type
        // (closed over its own type parameter) appears as the interface's type
        // argument. This must bind, emit IL-verifiable metadata, and the
        // InterfaceImpl must reference the constructed `IEquatable<Node<T>>`.
        var source = """
            package Probe
            import System

            class Node[T] : IEquatable[Node[T]] {
                let Value T
                func Equals(other Node[T]) bool {
                    return true
                }
            }
            """;

        var dllPath = CompileLibrary(source);
        try
        {
            var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
            var resolver = new System.Reflection.PathAssemblyResolver(
                Directory.GetFiles(runtimeDir, "*.dll").Concat(new[] { dllPath }));
            using var mlc = new MetadataLoadContext(resolver, "System.Private.CoreLib");
            var asm = mlc.LoadFromAssemblyPath(dllPath);
            var node = asm.GetType("Probe.Node`1")
                ?? throw new InvalidOperationException("Probe.Node`1 not found");

            var equatable = node.GetInterfaces().SingleOrDefault(i =>
                i.IsGenericType
                && i.GetGenericTypeDefinition().FullName == "System.IEquatable`1");
            Assert.NotNull(equatable);

            // The interface argument must be the constructed Node<T>, i.e. its
            // generic definition is Probe.Node`1.
            var arg = equatable!.GetGenericArguments().Single();
            Assert.True(arg.IsGenericType, "interface argument should be the constructed Node<T>");
            Assert.Equal("Probe.Node`1", arg.GetGenericTypeDefinition().FullName);
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    [Fact]
    public void Class_NamesItselfInBaseClass_TypeArgument_RunsAndIlVerifies()
    {
        // A BASE CLASS that references Self as a type argument:
        // `class C : Base[C]`. The base class is the constructed `Base<C>`,
        // not C itself, so this is legal (distinct from self-inheritance).
        var source = """
            package Probe
            import System

            open class Base[T] {
                let Tag int32
            }

            open class C(V int32) : Base[C] {
                func Describe() string {
                    return "c"
                }
            }

            var c = C(1)
            Console.WriteLine(c.Describe())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("c\n", output);
    }

    [Fact]
    public void Class_WithMultipleInterfaces_OneReferencingSelf_RunsAndIlVerifies()
    {
        // The base-type clause lists several interfaces where one references
        // Self (`IEquatable[Money]`). All must be wired and dispatchable.
        var source = """
            package Probe
            import System

            open class Money(Amount int32) : IDisposable, IEquatable[Money] {
                func Dispose() {
                    Console.WriteLine("disposed")
                }
                func Equals(other Money) bool {
                    return Amount == other.Amount
                }
            }

            var m1 = Money(3)
            var m2 = Money(3)
            Console.WriteLine(m1.Equals(m2))
            var e IEquatable[Money] = m1
            Console.WriteLine(e.Equals(m2))
            m1.Dispose()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nTrue\ndisposed\n", output);
    }

    [Fact]
    public void GenuineSelfInheritance_IsStillRejected()
    {
        // The narrowed guard must still reject a class naming itself as its
        // own BASE CLASS (not merely a type argument).
        var diagnostics = CompileExpectingErrors("""
            package Probe

            open class A : A {
                let V int32
            }
            """);

        Assert.Contains(diagnostics, d => d.Contains("GS0378"));
    }

    [Fact]
    public void GenuineGenericSelfInheritance_IsStillRejected()
    {
        // `class A[T] : A[T]` is genuine self-inheritance (the base class is
        // the constructed self) and must remain rejected.
        var diagnostics = CompileExpectingErrors("""
            package Probe

            open class A[T] : A[T] {
                let V T
            }
            """);

        Assert.Contains(diagnostics, d => d.Contains("GS0378"));
    }

    [Fact]
    public void TwoTypeInheritanceCycle_IsStillRejected()
    {
        // A two-type base-class cycle (B : C, C : B) must remain rejected so
        // the inheritance cycle detection is not weakened by the fix.
        var diagnostics = CompileExpectingErrors("""
            package Probe

            open class B : C {
                let V int32
            }

            open class C : B {
                let W int32
            }
            """);

        Assert.True(diagnostics.Count > 0, "expected an inheritance-cycle diagnostic");
    }

    [Fact]
    public void ThreeTypeInheritanceCycle_IsRejected()
    {
        // A transitive base-class cycle spanning three types (A : B, B : C,
        // C : A) must be rejected. This guards the multi-hop chain walk in the
        // post-bind cycle detector (#973), not just the two-type case.
        var diagnostics = CompileExpectingErrors("""
            package Probe

            open class A : B {
                let U int32
            }

            open class B : C {
                let V int32
            }

            open class C : A {
                let W int32
            }
            """);

        Assert.Contains(diagnostics, d => d.Contains("GS0381"));
    }

    [Fact]
    public void TwoTypeInheritanceCycle_ReportsGS0381()
    {
        // The two-type cycle must surface the dedicated inheritance-cycle
        // diagnostic (GS0381), distinct from direct self-inheritance (GS0378).
        var diagnostics = CompileExpectingErrors("""
            package Probe

            open class B : C {
                let V int32
            }

            open class C : B {
                let W int32
            }
            """);

        Assert.Contains(diagnostics, d => d.Contains("GS0381"));
    }

    [Fact]
    public void ForwardBaseClassReference_IsAccepted()
    {
        // A class deriving from a base declared later in source is a legitimate
        // forward reference (enabled by the #973 two-phase split) and must NOT
        // be misreported as an inheritance cycle.
        var path = CompileLibrary("""
            package Probe

            class Derived : Base {
                let V int32
            }

            open class Base {
                let W int32
            }
            """);

        Assert.True(File.Exists(path));
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue949_lib_").FullName;
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

        var compileExit = RunCompiler(args, out var compileOut, out var compileErr);
        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

        IlVerifier.Verify(outPath);
        return outPath;
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue949_").FullName;
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

            var compileExit = RunCompiler(args, out var compileOut, out var compileErr);
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue949_err_").FullName;
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

            var compileExit = RunCompiler(args, out var compileOut, out var compileErr);
            Assert.True(compileExit != 0, "expected gsc to report errors but it succeeded");

            var combined = compileOut + compileErr;
            return combined.Split('\n').Where(l => !string.IsNullOrWhiteSpace(l)).ToList();
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static int RunCompiler(string[] args, out string stdout, out string stderr)
    {
        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        try
        {
            var exit = Program.Main(args);
            stdout = compileOut.ToString();
            stderr = compileErr.ToString();
            return exit;
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }
    }

    private static void TryCleanup(string dllPath)
    {
        try
        {
            var dir = Path.GetDirectoryName(dllPath);
            if (dir != null)
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch
        {
            // best effort
        }
    }
}
