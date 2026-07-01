// <copyright file="Issue1518NullableDelegateInferenceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1518 — a lambda whose parameter or return type is a NULLABLE value
/// type (<c>T?</c>) passed to a generic method (e.g.
/// <c>Enumerable.Select&lt;TSource,TResult&gt;</c>) made overload-resolution type
/// inference bind the method type parameter to the NON-NULLABLE underlying
/// <c>T</c> instead of <c>Nullable&lt;T&gt;</c>, while the emitter built the
/// delegate with the accurate <c>Func&lt;…,T?&gt;</c>. The instantiation/delegate
/// mismatch (<c>Select&lt;…,int32&gt;</c> vs <c>Func&lt;…,Nullable&lt;int32&gt;&gt;</c>)
/// failed ilverify with <c>StackUnexpected</c>.
/// <para>
/// Root cause: <c>FunctionTypeSymbol.BuildClrType</c> built the
/// <c>Func&lt;…&gt;</c>/<c>Action&lt;…&gt;</c> shape from the raw
/// <c>parameterTypes[i].ClrType</c> / <c>returnType.ClrType</c>, but
/// <c>NullableTypeSymbol.ClrType</c> is the bare underlying CLR type, so a
/// <c>T?</c> slot collapsed to <c>T</c>. The fix routes both the parameter and
/// the return CLR types through <c>NullableLifting.GetEffectiveClrType</c>, which
/// wraps a value-type underlying in <c>Nullable&lt;T&gt;</c> and is identity for
/// everything else, so the delegate shape matches the emitted delegate.
/// </para>
/// Each facet failed ilverify on current main and passes after the fix. Each
/// uses a UNIQUE package/type name because the in-process
/// <c>FunctionTypeSymbol</c> cache is name-keyed.
/// </summary>
public class Issue1518NullableDelegateInferenceEmitTests
{
    [Fact]
    public void EndToEnd_SelectNullableReturn_ThenOfTypeFilter_Runs()
    {
        // (a) Lambda RETURN is a nullable value type (int32?) into Select; the
        // resulting IEnumerable<int32?> is filtered by OfType<int32>() which
        // drops the nil entry, so the runtime count is 2 (1 and 3).
        const string source = """
            package i1518selectofint
            import System
            import System.Linq

            class S1518a { prop V int32? { get; init; } }

            func F(xs []S1518a) []int32 -> xs.Select((s S1518a) -> s.V).OfType[int32]().ToArray()

            func Main() {
                var xs = []S1518a{ S1518a{V: 1}, S1518a{V: nil}, S1518a{V: 3} }
                System.Console.WriteLine(F(xs).Length)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n", output);
    }

    [Fact]
    public void EndToEnd_NullableReturn_IntoUserGenericMethod_Runs()
    {
        // (b) Nullable value-type RETURN flowing into a USER generic method that
        // takes Func<A,T>; the type parameter T must bind to Nullable<int32>,
        // and the emitted delegate must agree (Func<int32,Nullable<int32>>).
        const string source = """
            package i1518usergeneric
            import System

            func Box(x int32) int32? -> x

            func Apply[A, T](v A, f Func[A, T]) T -> f(v)

            func Main() {
                var r = Apply[int32, int32?](5, (x int32) -> Box(x))
                System.Console.WriteLine(r!!)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n", output);
    }

    [Fact]
    public void EndToEnd_NullableParameter_WhereFilter_Runs()
    {
        // (c) Lambda PARAMETER is a nullable value type (int32?) -> Func<int32?,bool>
        // into Where; the type parameter must bind to Nullable<int32>.
        const string source = """
            package i1518whereparam
            import System
            import System.Linq
            import System.Collections.Generic

            func CountPositive(xs []int32?) int32 -> xs.Where((v int32?) -> v != nil && v!! > 0).Count()

            func Main() {
                var xs = []int32?{ 1, nil, -2, 3 }
                System.Console.WriteLine(CountPositive(xs))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n", output);
    }

    [Fact]
    public void EndToEnd_NullableBoolReturn_Select_Runs()
    {
        // Generalization: nullable of a different value type (bool?) as the
        // lambda RETURN into Select, filtered by OfType<bool>().
        const string source = """
            package i1518selectbool
            import System
            import System.Linq

            class S1518b { prop B bool? { get; init; } }

            func F(xs []S1518b) []bool -> xs.Select((s S1518b) -> s.B).OfType[bool]().ToArray()

            func Main() {
                var xs = []S1518b{ S1518b{B: true}, S1518b{B: nil}, S1518b{B: false} }
                System.Console.WriteLine(F(xs).Length)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n", output);
    }

    [Fact]
    public void EndToEnd_Control_NonNullableSelect_NoRegression_Runs()
    {
        // (d) Non-nullable control proving no regression: Select with a plain
        // int32 return still infers TResult = int32 and runs.
        const string source = """
            package i1518ctrlnonnull
            import System
            import System.Linq

            class S1518c { prop V int32 { get; init; } }

            func F(xs []S1518c) int32 -> xs.Select((s S1518c) -> s.V).Sum()

            func Main() {
                var xs = []S1518c{ S1518c{V: 1}, S1518c{V: 2}, S1518c{V: 3} }
                System.Console.WriteLine(F(xs))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("6\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1518_exe_").FullName;
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
