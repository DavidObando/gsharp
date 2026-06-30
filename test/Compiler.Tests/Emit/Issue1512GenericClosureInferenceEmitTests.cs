// <copyright file="Issue1512GenericClosureInferenceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1512 — two independent emit bugs that both surface when a generic
/// class passes a lambda returning (or parameterized by) a type parameter to a
/// generic method.
/// <para>
/// Facet A — generic-method type-argument inference erased a type-parameter
/// lambda return to <c>object</c>. <c>Task.ContinueWith&lt;TResult&gt;</c> (and
/// any generic CLR/imported method inferring a type argument from a lambda whose
/// parameter/return is a type parameter) selected <c>ContinueWith&lt;object&gt;</c>
/// instead of <c>ContinueWith&lt;T&gt;</c>, producing <c>Task&lt;object&gt;</c>
/// where <c>Task&lt;T&gt;</c> was required and failing ilverify with
/// <c>StackUnexpected [found Task`1&lt;object&gt;][expected Task`1&lt;T0&gt;]</c>.
/// </para>
/// <para>
/// Facet B — a lambda lowered into a generic closure class (reified over its
/// enclosing type parameters) was emitted as a top-level type, so its
/// synthesized <c>Invoke</c> could not access the enclosing generic class's
/// <c>private</c> captured field, failing ilverify with
/// <c>FieldAccess … Field is not visible</c>. Nesting the reified closure inside
/// its enclosing type (matching the non-generic closure path) grants the CLR
/// nested-type access to the encloser's private members.
/// </para>
/// Every test uses a UNIQUE package/type name because the in-process
/// <c>FunctionTypeSymbol</c> cache is name-keyed. The <c>CompileAndRun</c> helper
/// runs <c>IlVerifier.Verify</c> and then executes the program, so each test
/// asserts both ilverify-cleanliness and a real runtime value.
/// </summary>
public class Issue1512GenericClosureInferenceEmitTests
{
    [Fact]
    public void FacetA_TaskContinueWith_ReturnsTypeParameter_Runs()
    {
        const string source = """
            package i1512facetataskcw
            import System
            import System.Threading.Tasks

            class Op[T] {
                var cont Task[T]?
                init() { }
                func SetIt(readerTask Task, v T) Task[T] {
                    let r = readerTask.ContinueWith((t Task) -> v)
                    cont = r
                    return r
                }
            }

            func Main() {
                var o = Op[int32]()
                var r = o.SetIt(Task.CompletedTask, 42)
                System.Console.WriteLine(r.Result)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void FacetA_EnumerableSelect_ReturnsTypeParameter_Runs()
    {
        // A non-Task generic-method inference shape: `Enumerable.Select`'s
        // TResult is inferred from a lambda whose return is the enclosing type
        // parameter T (here bound to string).
        const string source = """
            package i1512facetaselect
            import System
            import System.Collections.Generic
            import System.Linq

            class Box[T] {
                func Mapped(src List[int32], f (int32) -> T) IEnumerable[T] {
                    return src.Select(f)
                }
            }

            func Main() {
                var b = Box[string]()
                var lst = List[int32]()
                lst.Add(3)
                lst.Add(4)
                var sum = 0
                for v in b.Mapped(lst, (x int32) -> "v" + x.ToString()) {
                    System.Console.WriteLine(v)
                }
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("v3\nv4\n", output);
    }

    [Fact]
    public void FacetB_GenericClosure_CapturesPrivateField_Int_Runs()
    {
        const string source = """
            package i1512facetbint
            import System

            class Op[T] {
                private let fn (int32) -> T
                init(fn (int32) -> T) { this.fn = fn }
                func Use() (int32) -> T {
                    let g = (x int32) -> fn(x)
                    return g
                }
            }

            func Main() {
                var o = Op[int32]((x int32) -> x + 1)
                let h = o.Use()
                System.Console.WriteLine(h(5))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("6\n", output);
    }

    [Fact]
    public void FacetB_GenericClosure_CapturesPrivateField_StructTypeArg_Runs()
    {
        // Generalizes Facet B to a user struct type argument (not int32): the
        // reified closure is constructed over `Pt` and still reaches the
        // enclosing generic class's private captured field.
        const string source = """
            package i1512facetbstruct
            import System

            struct Pt(x int32) { }

            class Holder[T] {
                private let make (int32) -> T
                init(make (int32) -> T) { this.make = make }
                func Build() (int32) -> T {
                    let g = (n int32) -> make(n)
                    return g
                }
            }

            func Main() {
                var h = Holder[Pt]((n int32) -> Pt(n * 2))
                let f = h.Build()
                var p = f(21)
                System.Console.WriteLine(p.x)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void Combined_FacetA_And_FacetB_TogetherInOneType_Runs()
    {
        // Both root causes in one generic type: the captured private field `fn`
        // (Facet B) is invoked inside a lambda passed to `Task.ContinueWith`
        // whose TResult must infer to T (Facet A).
        const string source = """
            package i1512combined
            import System
            import System.Threading.Tasks

            class Op[T] {
                private let fn (Task) -> T
                var cont Task[T]?
                init(fn (Task) -> T) { this.fn = fn }
                func SetContinuation(readerTask Task) Task[T] {
                    let r = readerTask.ContinueWith((t Task) -> fn(t))
                    cont = r
                    return r
                }
            }

            func Main() {
                var o = Op[int32]((t Task) -> 7)
                var r = o.SetContinuation(Task.CompletedTask)
                System.Console.WriteLine(r.Result)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1512_exe_").FullName;
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
