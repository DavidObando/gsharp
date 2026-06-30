// <copyright file="Issue1502DelegateUserTypeArgEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1502 — converting a G# lambda (or method group) to a CLR generic
/// delegate (<c>System.Func&lt;…&gt;</c>/<c>System.Action&lt;…&gt;</c>) erased a
/// SOURCE-DEFINED user type (or type-parameter) delegate type argument to
/// <c>System.Object</c>. The lambda emitted as <c>Func&lt;object&gt;</c> where
/// <c>Func&lt;UserType&gt;</c> was required, so the <c>newobj</c> at the delegate
/// construction site failed ilverify
/// (<c>StackUnexpected [found Func`1&lt;object&gt;][expected Func`1&lt;Foo&gt;]</c>).
/// <para>
/// The fix has two parts: (1) the binder now recovers the symbolic delegate
/// target (<c>() -&gt; Foo</c>) from the OPEN constructor parameter substituted
/// with the real symbolic type arguments, so the synthesized lambda method
/// returns <c>Foo</c> rather than boxed <c>object</c>; and (2) the emitter routes
/// the delegate ctor / on-stack delegate type through the symbolic
/// <c>FunctionTypeSymbol</c> path whenever the function type carries a
/// type-parameter or same-compilation user type, so the reified
/// <c>Func&lt;Foo&gt;</c>/<c>Action&lt;Foo&gt;</c> is emitted.
/// </para>
/// Every facet failed ilverify (or threw <c>InvalidProgramException</c>) on
/// current main and passes after the fix. Each uses a UNIQUE package/type name
/// because the in-process <c>FunctionTypeSymbol</c> cache is name-keyed.
/// </summary>
public class Issue1502DelegateUserTypeArgEmitTests
{
    [Fact]
    public void EndToEnd_FuncUserClass_LazyLambda_Runs()
    {
        const string source = """
            package i1502funcclass
            import System

            class Foo { prop N int32 { get; init; } init(n int32) { N = n } }

            class C { shared { func Make() Lazy[Foo] -> Lazy[Foo](() -> Foo(42)) } }

            func Main() { System.Console.WriteLine(C.Make().Value.N) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void EndToEnd_FuncUserStruct_LazyLambda_Runs()
    {
        const string source = """
            package i1502funcstruct
            import System

            struct Bar(V int32) { }

            class C { shared { func Make() Lazy[Bar] -> Lazy[Bar](() -> Bar(7)) } }

            func Main() { System.Console.WriteLine(C.Make().Value.V) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void EndToEnd_ActionUserClass_ForEachLambda_Runs()
    {
        const string source = """
            package i1502actionclass
            import System
            import System.Collections.Generic

            class Foo { prop N int32 { get; init; } init(n int32) { N = n } }

            func Main() {
                var lst = List[Foo]()
                lst.Add(Foo(5))
                lst.ForEach((x Foo) -> System.Console.WriteLine(x.N))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n", output);
    }

    [Fact]
    public void EndToEnd_FuncUserEnum_LazyLambda_Runs()
    {
        const string source = """
            package i1502funcenum
            import System

            enum Color { Red, Green, Blue }

            class C { shared { func Make() Lazy[Color] -> Lazy[Color](() -> Color.Green) } }

            func Main() { System.Console.WriteLine(C.Make().Value) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n", output);
    }

    [Fact]
    public void EndToEnd_FuncNestedGenericUserClass_LazyLambda_Runs()
    {
        const string source = """
            package i1502nested
            import System
            import System.Collections.Generic

            class Foo { prop N int32 { get; init; } init(n int32) { N = n } }

            class C { shared { func Make() int32 {
                let lz = Lazy[List[Foo]](() -> {
                    var l = List[Foo]()
                    l.Add(Foo(9))
                    return l
                })
                return lz.Value.Count
            } } }

            func Main() { System.Console.WriteLine(C.Make()) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n", output);
    }

    [Fact]
    public void EndToEnd_FuncUserClass_LazyMethodGroup_Runs()
    {
        const string source = """
            package i1502methodgroup
            import System

            class Foo { prop N int32 { get; init; } init(n int32) { N = n } }

            func MakeFoo() Foo -> Foo(11)

            class C { shared { func Make() Lazy[Foo] -> Lazy[Foo](MakeFoo) } }

            func Main() { System.Console.WriteLine(C.Make().Value.N) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("11\n", output);
    }

    [Fact]
    public void EndToEnd_FuncTypeParameter_LazyLambda_Runs()
    {
        const string source = """
            package i1502typeparam
            import System

            func Wrap[T](v T) T {
                let lz = Lazy[T](() -> v)
                return lz.Value
            }

            func Main() { System.Console.WriteLine(Wrap[int32](7)) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void EndToEnd_Control_FuncInt32_LazyLambda_Runs()
    {
        const string source = """
            package i1502ctrlint
            import System

            class C { shared { func Make() Lazy[int32] -> Lazy[int32](() -> 42) } }

            func Main() { System.Console.WriteLine(C.Make().Value) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void EndToEnd_Control_FuncString_LazyLambda_Runs()
    {
        const string source = """
            package i1502ctrlstr
            import System

            class C { shared { func Make() Lazy[string] -> Lazy[string](() -> "x") } }

            func Main() { System.Console.WriteLine(C.Make().Value) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("x\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1502_exe_").FullName;
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
