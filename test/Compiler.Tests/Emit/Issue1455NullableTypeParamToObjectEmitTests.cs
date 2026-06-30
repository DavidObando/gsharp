// <copyright file="Issue1455NullableTypeParamToObjectEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1455 — a NULLABLE generic type-parameter value (<c>T?</c>) converting
/// to <c>object</c> (or an interface) crashed emit with GS9998
/// "Conversion from 'TOutput?' to 'object' is not yet supported by the emitter".
/// The bare type-parameter box branch only matched <c>T</c>, never the
/// <see cref="GSharp.Core.CodeAnalysis.Symbols.NullableTypeSymbol"/> wrapper, so
/// a <c>T?</c> source fell through to the unsupported-conversion throw — and a
/// closely related argument-position case silently emitted UNVERIFIABLE IL
/// (missing <c>box</c>). The fix boxes the underlying type-parameter token for a
/// nullable wrapper in both the box and unbox conversion branches, and adds the
/// matching implicit boxing classification so argument / return / interface
/// positions reach that branch instead of being rejected.
/// </summary>
public class Issue1455NullableTypeParamToObjectEmitTests
{
    [Fact]
    public void EndToEnd_NullableTypeParamArgumentToObjectList_BoxesAndRuns()
    {
        // The #1445-family argument-position case from the issue: a `T?` value
        // flows into a `List[object].Add(object)` slot. Before the fix this
        // compiled but produced unverifiable IL (no `box`); IlVerifier.Verify
        // inside the helper asserts the emitted body is now verifiable.
        var source = """
            package Probe1455Arg
            import System
            import System.Collections.Generic

            open class Holder[TOutput] {
                private var value TOutput
                init(v TOutput) { this.value = v }
                func GetMaybe() TOutput? { return this.value }
                func Stash() List[object] {
                    let lst = List[object]()
                    lst.Add(GetMaybe())
                    return lst
                }
            }

            func Main() {
                let h = Holder[int32](7)
                Console.WriteLine(h.Stash()[0]!!.ToString()!!)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void EndToEnd_NullableTypeParamReturnedAsObject_BoxesAndRuns()
    {
        // The actual GS9998 throw path: an implicit `T? -> object` widening
        // reaches MethodBodyEmitter.EmitConversion in a regular method body.
        // Before the fix the box branch only matched a bare `T`, so the
        // nullable wrapper fell through to the NotSupportedException throw.
        var source = """
            package Probe1455Ret
            import System

            open class Holder[TOutput] {
                private var value TOutput
                init(v TOutput) { this.value = v }
                func GetMaybe() TOutput? { return this.value }
                func AsObject() object -> GetMaybe()
            }

            func Main() {
                let h = Holder[int32](42)
                Console.WriteLine(h.AsObject()!!.ToString()!!)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void EndToEnd_NullableTypeParamToConstraintInterface_BoxesAndRuns()
    {
        // The interface-target variant: a `T?` over an `IComparable`-constrained
        // type parameter reference-converts to the interface. Scoped to targets
        // the type parameter actually satisfies (a bare `object` or an interface
        // in its constraint set), so unrelated interface targets stay rejected.
        var source = """
            package Probe1455Iface
            import System

            open class Holder[T IComparable] {
                private var value T
                init(v T) { this.value = v }
                func GetMaybe() T? -> this.value
                func AsComparable() IComparable -> GetMaybe()
            }

            func Main() {
                let h = Holder[int32](9)
                Console.WriteLine(h.AsComparable()!!.CompareTo(9).ToString()!!)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n", output);
    }

    [Fact]
    public void EndToEnd_NullableValueTypeParamToObject_BoxesNullableAndRuns()
    {
        // The value-type-constrained case: `T?` over `[T struct]` is stored as
        // `Nullable<T>`, so the emitter boxes the `Nullable<T>` token (which
        // yields a boxed `T` for a present value, a null reference otherwise).
        var source = """
            package Probe1455Struct
            import System

            open class Holder[T struct] {
                private var value T
                init(v T) { this.value = v }
                func GetMaybe() T? -> this.value
                func AsObject() object -> GetMaybe()
            }

            func Main() {
                let h = Holder[int32](5)
                Console.WriteLine(h.AsObject()!!.ToString()!!)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1455_exe_").FullName;
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
