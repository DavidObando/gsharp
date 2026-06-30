// <copyright file="Issue1445TypeParamToNullableEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1445 — converting a <b>local / call-result value of a bare generic
/// type parameter <c>T</c></b> into its nullable form <c>T?</c> emitted
/// unverifiable IL when <c>T</c> is constrained only to an interface (so it is
/// not statically a reference type).
/// <para>
/// Root cause: a LINQ-style call whose open return is a bare method type
/// parameter (<c>First&lt;TSource&gt;() -&gt; TSource</c>), closed over an
/// in-scope generic type parameter <c>T</c>, encodes a symbolic MethodSpec
/// <c>First&lt;!!T&gt;</c> that already leaves a <c>!!T</c> value on the stack.
/// The erasure-widening skip guard
/// (<c>TryGetSymbolicSubstitutedImportedCallReturn</c>) only fired for
/// same-compilation user-type arguments, never a bare type parameter, so the
/// emitter fed the placeholder-closed (erased <c>object</c>) return into the
/// widening and produced a spurious <c>unbox.any !!T</c> against a stack slot
/// already holding <c>!!T</c> (ilverify <c>StackObjRef</c>). The fix broadens
/// the guard to also skip when the symbolic return surfaces an in-scope type
/// parameter, mirroring the instance-method variant — so every value source
/// (call result, local, switch/if arm) leaves a clean <c>!!T</c> on the stack.
/// </para>
/// Each test below compiles, IL-verifies (inside <see cref="CompileAndRun"/>),
/// and runs.
/// </summary>
public class Issue1445TypeParamToNullableEmitTests
{
    [Fact]
    public void EndToEnd_CallResultTypeParamReturnedAsNullable_VerifiesAndRuns()
    {
        // The headline repro: a `T` call-result returned directly as `T?`.
        var source = """
            package Probe1445Call
            import System
            import System.Collections.Generic
            import System.Linq

            interface IThing1445Call {}
            open class Thing1445Call : IThing1445Call {}

            func Pick[T IThing1445Call](items IEnumerable[T]) T? {
                return items.First()
            }

            func Main() {
                let l = List[Thing1445Call]()
                l.Add(Thing1445Call())
                Console.WriteLine(Pick[Thing1445Call](l) != nil)
            }
            """;

        Assert.Equal("True\n", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_LocalTypeParamReturnedAsNullable_VerifiesAndRuns()
    {
        // The same value flowing through an explicit local of type `T`.
        var source = """
            package Probe1445Local
            import System
            import System.Collections.Generic
            import System.Linq

            interface IThing1445Local {}
            open class Thing1445Local : IThing1445Local {}

            func Pick[T IThing1445Local](items IEnumerable[T]) T? {
                let v T = items.First()
                return v
            }

            func Main() {
                let l = List[Thing1445Local]()
                l.Add(Thing1445Local())
                Console.WriteLine(Pick[Thing1445Local](l) != nil)
            }
            """;

        Assert.Equal("True\n", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_SwitchArmTypeParamAsNullable_VerifiesAndRuns()
    {
        // The same value as a `switch`-expression arm targeting `T?`.
        var source = """
            package Probe1445Switch
            import System
            import System.Collections.Generic
            import System.Linq

            interface IThing1445Switch {}
            open class Thing1445Switch : IThing1445Switch {}

            func Pick[T IThing1445Switch](items IEnumerable[T]) T? {
                return switch items.Count() {
                    case 1: items.First()
                    default: nil
                }
            }

            func Main() {
                let l = List[Thing1445Switch]()
                l.Add(Thing1445Switch())
                Console.WriteLine(Pick[Thing1445Switch](l) != nil)
            }
            """;

        Assert.Equal("True\n", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_GenericClassAccessorReturnsNullable_VerifiesAndRuns()
    {
        // The Oahu `Box.GetChild<T>()`-style accessor: a generic class method
        // returning `T?` from a collection lookup, via both an inferred local
        // and a direct call result.
        var source = """
            package Probe1445Box
            import System
            import System.Collections.Generic
            import System.Linq

            interface INode1445 {}
            open class Node1445 : INode1445 {}

            open class Box1445[T INode1445] {
                private var items List[T] = List[T]()
                func Add(x T) { this.items.Add(x) }
                func GetChild() T? {
                    let found = this.items.First()
                    return found
                }
                func GetChildDirect() T? -> this.items.First()
            }

            func Main() {
                let b = Box1445[Node1445]()
                b.Add(Node1445())
                Console.WriteLine(b.GetChild() != nil)
                Console.WriteLine(b.GetChildDirect() != nil)
            }
            """;

        Assert.Equal("True\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_ValueTypeConstrainedTypeParamLiftsToNullable_VerifiesAndRuns()
    {
        // Control for the value-type path: a `[T struct]` call-result lifts to
        // a real `Nullable<T>` (`newobj`), unaffected by the box/unbox-skip
        // generalization above.
        var source = """
            package Probe1445Struct
            import System
            import System.Collections.Generic
            import System.Linq

            func PickV[T struct](items IEnumerable[T]) T? {
                return items.First()
            }

            func Main() {
                let l = List[int32]()
                l.Add(42)
                Console.WriteLine(PickV[int32](l)!!)
            }
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_ParameterTypeParamAsNullable_StaysVerifiable()
    {
        // The pre-existing control that already verified clean: a `T`
        // parameter widened to `T?` is a representation-preserving no-op
        // (the return signature erases to `!!T`); it must remain clean.
        var source = """
            package Probe1445Param
            import System

            interface IThing1445Param {}
            open class Thing1445Param : IThing1445Param {}

            func Id[T IThing1445Param](x T) T? { return x }

            func Main() {
                Console.WriteLine(Id[Thing1445Param](Thing1445Param()) != nil)
            }
            """;

        Assert.Equal("True\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1445_exe_").FullName;
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
