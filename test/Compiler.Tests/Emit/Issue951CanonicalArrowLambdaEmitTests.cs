// <copyright file="Issue951CanonicalArrowLambdaEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #951 / ADR-0119 — the inferred-type arrow lambda is the canonical
/// lambda form in G#. These end-to-end CompileAndRun tests lock in
/// parameter-type and return-type inference for arrow lambdas across the
/// canonical contexts: passing a lambda to a method/function whose parameter
/// is a delegate type (CLR <c>Func</c>/<c>Action</c>/<c>Predicate</c> or a G#
/// <c>(T) -&gt; R</c> function type), single and multi-parameter, the bare
/// single-parameter form, block bodies, return-type inference, user instance /
/// interface / static methods, typed-local bindings, and collection methods.
/// </summary>
public class Issue951CanonicalArrowLambdaEmitTests
{
    [Fact]
    public void FreeFunction_FuncParam_SingleParen_Inferred()
    {
        var source = """
            package P
            import System

            func Apply(f Func[int32, int32], x int32) int32 { return f(x) }
            Console.WriteLine(Apply((x) -> x * 2, 5))
            """;

        Assert.Equal("10\n", CompileAndRun(source));
    }

    [Fact]
    public void FreeFunction_FuncParam_BareSingleParam_Inferred()
    {
        var source = """
            package P
            import System

            func Apply(f Func[int32, int32], x int32) int32 { return f(x) }
            Console.WriteLine(Apply(x -> x + 1, 41))
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void FreeFunction_GSharpFunctionTypeParam_Inferred()
    {
        var source = """
            package P
            import System

            func Apply(f (int32) -> int32, x int32) int32 { return f(x) }
            Console.WriteLine(Apply((x) -> x * 3, 5))
            """;

        Assert.Equal("15\n", CompileAndRun(source));
    }

    [Fact]
    public void FreeFunction_ActionParam_Inferred()
    {
        var source = """
            package P
            import System

            func Run(a Action[int32], x int32) { a(x) }
            Run((x) -> Console.WriteLine(x * 3), 4)
            Run(x -> Console.WriteLine(x), 7)
            """;

        Assert.Equal("12\n7\n", CompileAndRun(source));
    }

    [Fact]
    public void FreeFunction_PredicateParam_Inferred()
    {
        var source = """
            package P
            import System

            func Test(p Predicate[int32], x int32) bool { return p(x) }
            Console.WriteLine(Test((x) -> x > 0, 5))
            Console.WriteLine(Test(x -> x > 10, 5))
            """;

        Assert.Equal("True\nFalse\n", CompileAndRun(source));
    }

    [Fact]
    public void FreeFunction_MultiParamFunc_Inferred()
    {
        var source = """
            package P
            import System

            func Apply2(f Func[int32, int32, int32], a int32, b int32) int32 { return f(a, b) }
            Console.WriteLine(Apply2((a, b) -> a + b, 3, 4))
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    [Fact]
    public void FreeFunction_FuncParam_BlockBody_Inferred()
    {
        var source = """
            package P
            import System

            func Apply(f Func[int32, int32], x int32) int32 { return f(x) }
            let r = Apply((x) -> {
              let y = x * 2
              y + 1
            }, 5)
            Console.WriteLine(r)
            """;

        Assert.Equal("11\n", CompileAndRun(source));
    }

    [Fact]
    public void FreeFunction_ReturnTypeInference_FlowsFromExpression()
    {
        var source = """
            package P
            import System

            func Apply(f Func[int32, string], x int32) string { return f(x) }
            Console.WriteLine(Apply((x) -> x.ToString(), 7))
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    [Fact]
    public void TypedLocal_ClrDelegate_Inferred()
    {
        var source = """
            package P
            import System

            let f Func[int32, int32] = (x) -> x * 2
            Console.WriteLine(f(21))
            let g Func[int32, int32] = x -> x + 1
            Console.WriteLine(g(41))
            """;

        Assert.Equal("42\n42\n", CompileAndRun(source));
    }

    [Fact]
    public void UserInstanceMethod_FuncParam_Inferred()
    {
        var source = """
            package P
            import System

            class Calc {
              func Apply(f Func[int32, int32], x int32) int32 { return f(x) }
            }
            let c = Calc()
            Console.WriteLine(c.Apply((x) -> x * 2, 5))
            Console.WriteLine(c.Apply(x -> x + 1, 9))
            """;

        Assert.Equal("10\n10\n", CompileAndRun(source));
    }

    [Fact]
    public void InterfaceMethod_FuncParam_Inferred()
    {
        var source = """
            package P
            import System

            interface IRunner { func Run(f Func[int32, int32], x int32) int32; }
            class R : IRunner { func Run(f Func[int32, int32], x int32) int32 { return f(x) } }
            let r IRunner = R()
            Console.WriteLine(r.Run((x) -> x * 2, 6))
            """;

        Assert.Equal("12\n", CompileAndRun(source));
    }

    [Fact]
    public void StaticUserMethod_FuncParam_Inferred()
    {
        var source = """
            package P
            import System

            class Calc {
              shared {
                func Apply(f Func[int32, int32], x int32) int32 { return f(x) }
              }
            }
            Console.WriteLine(Calc.Apply((x) -> x * 2, 5))
            """;

        Assert.Equal("10\n", CompileAndRun(source));
    }

    [Fact]
    public void CollectionMethods_WhereSelect_Inferred()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic
            import System.Linq

            let xs = List[int32]{ 1, 2, 3, 4 }
            for e in xs.Where((x) -> x % 2 == 0) { Console.WriteLine(e) }
            for d in xs.Select(x -> x * 2) { Console.WriteLine(d) }
            """;

        Assert.Equal("2\n4\n2\n4\n6\n8\n", CompileAndRun(source));
    }

    [Fact]
    public void ListExists_PredicateInferred()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            let xs = List[int32]{ 1, 2, 3 }
            Console.WriteLine(xs.Exists((x) -> x > 2))
            Console.WriteLine(xs.Exists(x -> x > 10))
            """;

        Assert.Equal("True\nFalse\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_lambda951_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

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

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
            IlVerifier.Verify(outPath);

            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + outPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = Process.Start(psi)!;
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
