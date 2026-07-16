// <copyright file="Issue2381AsyncGenericCollectionReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2381: an async G# method returning a closed generic collection over
/// a same-compilation type (e.g. <c>List[UserClass]</c>,
/// <c>Dictionary[string,UserClass]</c>) was emitted as
/// <c>Task&lt;Collection&lt;object&gt;&gt;</c> /
/// <c>AsyncTaskMethodBuilder&lt;Collection&lt;object&gt;&gt;</c> even though
/// locals and the declared source return type use the real class, producing
/// unverifiable IL at any caller that observes the real element type.
/// <para>
/// Root cause and fix span TWO independent sites, both trusting an
/// object-erased <see cref="GSharp.Core.CodeAnalysis.Symbols.ImportedTypeSymbol.ClrType"/>
/// instead of reconstructing the true closed shape from the OPEN generic
/// definition plus the symbolic type arguments:
/// <list type="number">
/// <item><description><c>AsyncStateMachineTypeBuilder.ResolveAsyncReturnClrType</c>
/// (and its <c>builderFieldType</c> computation in <c>Build()</c>) drove the
/// async state machine's <c>Task&lt;T&gt;</c> / <c>AsyncTaskMethodBuilder&lt;T&gt;</c>
/// / <c>SetResult</c> / kickoff-return metadata off the erased
/// <c>kickoff.Type?.ClrType</c>. Generalized to route through the SAME
/// symbolic-encoding gate <c>ReflectionMetadataEmitter.ArgIsSymbolicUserDefined</c>
/// already used by <c>EncodeAsyncReturnType</c>'s Task-construction path for
/// #1785/#2030's gap1 (bare struct/interface/enum/type-parameter shapes) —
/// widened here to also recognize an <c>ImportedTypeSymbol</c> closed over a
/// same-compilation argument (recursively, so <c>List[List[UserClass]]</c>,
/// <c>Dictionary[string,UserClass]</c>, arrays and nullables of a
/// same-compilation element all match).</description></item>
/// <item><description><c>LambdaBinder.WrapAsTask</c> — which computes the
/// async function/lambda's OBSERVABLE <c>Task&lt;T&gt;</c> return type used
/// for binder-side call/delegate-target-typing (e.g. inferring
/// <c>Task.Run&lt;TResult&gt;(Func&lt;Task&lt;TResult&gt;&gt;)</c>'s
/// <c>TResult</c> for the <c>() -&gt; RunAsync()</c> lambda) — only recognized a
/// null <c>element.ClrType</c> (the bare struct/enum/tuple/type-parameter
/// shapes from #1785/#2026/#2232) as "not really closed yet". An imported
/// generic like <c>List&lt;&gt;</c> closed over a same-compilation argument
/// reports a NON-null but object-erased <c>ClrType</c>
/// (<c>List&lt;object&gt;</c>), so it fell through to the ordinary
/// reflection-based <c>Task&lt;T&gt;</c> construction and silently produced an
/// erased <c>Task&lt;List&lt;object&gt;&gt;</c> observable type. Generalized
/// the same-compilation detection to <c>TypeSymbol.ContainsSameCompilationUserType</c>
/// (which already recurses through array/slice/nullable/tuple/imported-generic
/// wrappers) OR'd with the emitter's <c>ArgIsSymbolicUserDefined</c>, checked
/// BEFORE the null-ClrType branch so it also catches the erased-but-non-null
/// shape. This also generalizes the pre-existing null-ClrType branch to
/// arrays/slices of a same-compilation element (<c>[]UserClass</c>), which had
/// the SAME gap (an array/slice's ClrType is computed once, at construction,
/// as <c>elementType.ClrType?.MakeArrayType()</c>, and previously matched none
/// of the hand-listed wrapper kinds).</description></item>
/// </list>
/// A third, narrower gap was found and fixed along the way:
/// <c>LambdaBinder.CreateErasedFunctionLiteralAdapter</c> (the adapter
/// synthesized when a lambda's own bound function type doesn't match its
/// target delegate shape — here, the <c>() -&gt; RunAsync()</c> lambda passed to
/// <c>Task.Run</c>) never propagated the original literal's
/// <c>LexicalEnclosingType</c> onto the adapter's synthesized
/// <see cref="GSharp.Core.CodeAnalysis.Symbols.FunctionSymbol"/>. Per the
/// #1335 closure-nesting rule, a capturing closure must be nested inside its
/// lexically enclosing user type to share its CLR accessibility domain; an
/// adapter with a null <c>LexicalEnclosingType</c> fell back to a top-level
/// placement, so an adapter closure that reads a <c>private</c>/<c>protected</c>
/// member of the enclosing type (as this repro's implicit <c>this.RunAsync()</c>
/// call does) produced an unverifiable <c>MethodAccess</c> IL site.
/// </para>
/// </summary>
public class Issue2381AsyncGenericCollectionReturnEmitTests
{
    [Fact]
    public void ListOfUserClass_ExactIssueRepro_CompilesAndRuns()
    {
        // Exact minimal repro from the issue body.
        var source = """
            package issue2381list
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            class DiagnosticCheck2381 {}

            class ExportCheck2381 {
                private async func RunAsync() List[DiagnosticCheck2381] {
                    let results = List[DiagnosticCheck2381]()
                    results.Add(DiagnosticCheck2381())
                    await Task.Delay(1)
                    return results
                }

                func Run() List[DiagnosticCheck2381] -> Task.Run(() -> RunAsync()).GetAwaiter().GetResult()
            }

            var c = ExportCheck2381()
            var r = c.Run()
            Console.WriteLine(r.Count)
            """;

        var output = CompileAndRun(source);

        Assert.Equal("1\n", output);
    }

    [Fact]
    public void NestedListOfUserClass_CompilesAndRuns()
    {
        // Coverage: nested imported generics — List[List[UserClass]] — must
        // recurse the symbolic reconstruction through both generic layers.
        var source = """
            package issue2381nested
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            class DiagnosticCheckNested {}

            class ExportCheckNested {
                private async func RunAsync() List[List[DiagnosticCheckNested]] {
                    let inner = List[DiagnosticCheckNested]()
                    inner.Add(DiagnosticCheckNested())
                    let outer = List[List[DiagnosticCheckNested]]()
                    outer.Add(inner)
                    await Task.Delay(1)
                    return outer
                }

                func Run() List[List[DiagnosticCheckNested]] -> Task.Run(() -> RunAsync()).GetAwaiter().GetResult()
            }

            var c = ExportCheckNested()
            var r = c.Run()
            Console.WriteLine(r.Count)
            Console.WriteLine(r[0].Count)
            """;

        var output = CompileAndRun(source);

        Assert.Equal("1\n1\n", output);
    }

    [Fact]
    public void DictionaryOfStringToUserClass_CompilesAndRuns()
    {
        // Coverage: Dictionary<string, UserClass> — a two-argument imported
        // generic where only the SECOND argument is same-compilation.
        var source = """
            package issue2381dict
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            class DiagnosticCheckDict {}

            class ExportCheckDict {
                private async func RunAsync() Dictionary[string, DiagnosticCheckDict] {
                    let results = Dictionary[string, DiagnosticCheckDict]()
                    results["a"] = DiagnosticCheckDict()
                    await Task.Delay(1)
                    return results
                }

                func Run() Dictionary[string, DiagnosticCheckDict] -> Task.Run(() -> RunAsync()).GetAwaiter().GetResult()
            }

            var c = ExportCheckDict()
            var r = c.Run()
            Console.WriteLine(r.Count)
            """;

        var output = CompileAndRun(source);

        Assert.Equal("1\n", output);
    }

    [Fact]
    public void ArrayOfUserClass_CompilesAndRuns()
    {
        // Coverage: a slice/array of a same-compilation class. Unlike
        // List<>/Dictionary<> (imported generics whose erasure surfaces as a
        // non-null but object-erased ClrType), a slice/array's ClrType is
        // computed ONCE at construction as `elementType.ClrType?.
        // MakeArrayType()` and stays genuinely null forever once captured
        // before the element's TypeBuilder closes — a distinct shape that
        // needed its own generalization in the null-ClrType branch.
        var source = """
            package issue2381arr
            import System
            import System.Threading.Tasks

            class DiagnosticCheckArr {}

            class ExportCheckArr {
                private async func RunAsync() []DiagnosticCheckArr {
                    let results = []DiagnosticCheckArr{DiagnosticCheckArr(), DiagnosticCheckArr()}
                    await Task.Delay(1)
                    return results
                }

                func Run() []DiagnosticCheckArr -> Task.Run(() -> RunAsync()).GetAwaiter().GetResult()
            }

            var c = ExportCheckArr()
            var r = c.Run()
            Console.WriteLine(r.Length)
            """;

        var output = CompileAndRun(source);

        Assert.Equal("2\n", output);
    }

    [Fact]
    public void ListOfValueTypeStruct_CompilesAndRuns()
    {
        // Coverage: a same-compilation VALUE type (struct) element, not a
        // class — ArgIsSymbolicUserDefined/ContainsSameCompilationUserType
        // must recognize StructSymbol arguments identically to class
        // (StructSymbol-backed) arguments.
        var source = """
            package issue2381vt
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            struct Point2381(X int32, Y int32) { }

            class ExportCheckVt {
                private async func RunAsync() List[Point2381] {
                    let results = List[Point2381]()
                    results.Add(Point2381(1, 2))
                    results.Add(Point2381(3, 4))
                    await Task.Delay(1)
                    return results
                }

                func Run() List[Point2381] -> Task.Run(() -> RunAsync()).GetAwaiter().GetResult()
            }

            var c = ExportCheckVt()
            var r = c.Run()
            Console.WriteLine(r.Count)
            Console.WriteLine(r[0].X)
            Console.WriteLine(r[1].Y)
            """;

        var output = CompileAndRun(source);

        Assert.Equal("2\n1\n4\n", output);
    }

    [Fact]
    public void GenericAsyncMethodReturningListOfInferredUserType_CompilesAndRuns()
    {
        // Control: a GENERIC async method (its own method type parameter,
        // #2030's shape) whose return is ALSO an imported generic collection
        // over that type parameter (#2381's shape) — both generalizations
        // must compose when T is inferred as a same-compilation class at the
        // call site.
        var source = """
            package issue2381generic
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            class DiagnosticCheckGeneric {}

            async func WrapAsync2381[T](v T) List[T] {
                let results = List[T]()
                results.Add(v)
                await Task.Delay(1)
                return results
            }

            func RunGeneric() List[DiagnosticCheckGeneric] -> Task.Run(() -> WrapAsync2381(DiagnosticCheckGeneric())).GetAwaiter().GetResult()

            var r = RunGeneric()
            Console.WriteLine(r.Count)
            """;

        var output = CompileAndRun(source);

        Assert.Equal("1\n", output);
    }

    [Fact]
    public void ListOfPrimitive_ControlUnaffected()
    {
        // Negative control: a collection over a BUILT-IN (non-same-compilation)
        // element type must keep taking the ordinary reflection-based Task<T>
        // path unaffected by the new same-compilation detection — no
        // behavior change for the common case.
        var source = """
            package issue2381prim
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            class ExportCheckPrim {
                private async func RunAsync() List[int32] {
                    let results = List[int32]()
                    results.Add(1)
                    results.Add(2)
                    await Task.Delay(1)
                    return results
                }

                func Run() List[int32] -> Task.Run(() -> RunAsync()).GetAwaiter().GetResult()
            }

            var c = ExportCheckPrim()
            var r = c.Run()
            Console.WriteLine(r.Count)
            """;

        var output = CompileAndRun(source);

        Assert.Equal("2\n", output);
    }

    [Fact]
    public void ListOfUserClass_MetadataReturnTypeIsClosedOverRealClass()
    {
        // Metadata assertion: reflect over the emitted kickoff method and
        // async state machine builder field to confirm the CLR signature is
        // truly closed over the real user class (List<DiagnosticCheckMeta>),
        // not List<object>.
        var source = """
            package issue2381meta
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            class DiagnosticCheckMeta {}

            class ExportCheckMeta {
                async func RunAsync() List[DiagnosticCheckMeta] {
                    let results = List[DiagnosticCheckMeta]()
                    results.Add(DiagnosticCheckMeta())
                    await Task.Delay(1)
                    return results
                }
            }
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_issue2381_meta_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var compileExit = CompileQuiet(srcPath, outPath, out var stdout, out var stderr);
            Assert.True(compileExit == 0, $"gsc failed:\nstdout:\n{stdout}\nstderr:\n{stderr}");

            IlVerifier.Verify(outPath);

            var asm = Assembly.LoadFrom(outPath);
            var exportType = asm.GetType("issue2381meta.ExportCheckMeta", throwOnError: true)!;
            var runAsync = exportType.GetMethod("RunAsync", BindingFlags.Public | BindingFlags.Instance)!;

            var returnType = runAsync.ReturnType;
            Assert.True(returnType.IsGenericType);
            Assert.Equal("Task`1", returnType.Name);

            var taskArg = returnType.GetGenericArguments()[0];
            Assert.True(taskArg.IsGenericType);
            Assert.Equal("List`1", taskArg.Name);

            var listArg = taskArg.GetGenericArguments()[0];
            Assert.Equal("DiagnosticCheckMeta", listArg.Name);
            Assert.NotEqual(typeof(object), listArg);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static int CompileQuiet(string srcPath, string outPath, out string stdout, out string stderr)
    {
        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        stdout = compileOut.ToString();
        stderr = compileErr.ToString();
        return compileExit;
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2381_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var compileExit = CompileQuiet(srcPath, outPath, out var stdout, out var stderr);

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{stdout}\nstderr:\n{stderr}");
            IlVerifier.Verify(outPath);
            Assert.True(File.Exists(outPath), $"expected emitted assembly at {outPath}");

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

            using var proc = Process.Start(psi);
            var stdoutRun = proc!.StandardOutput.ReadToEnd();
            var stderrRun = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdoutRun}\nstderr:\n{stderrRun}");

            return stdoutRun.Replace("\r\n", "\n");
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }
}
