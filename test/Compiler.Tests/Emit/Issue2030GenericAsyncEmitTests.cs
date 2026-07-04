// <copyright file="Issue2030GenericAsyncEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2030: generic <c>async func</c>s could not be emitted/run due to
/// two separate emit-layer gaps:
/// <list type="number">
/// <item><description>Gap 1 — state-machine synthesis reported GS0190
/// whenever the declared inner return type was an open type parameter (e.g.
/// <c>async func Foo[U](x U) U</c>), because
/// <c>AsyncStateMachineTypeBuilder.ResolveAsyncReturnClrType</c> had no
/// branch to resolve a CLR type for a bare/nullable-wrapped
/// <c>TypeParameterSymbol</c>.</description></item>
/// <item><description>Gap 2 — even when the declared return type was
/// concrete, hoisting a parameter/local typed as the kickoff method's own
/// type parameter (e.g. <c>seed U</c>) into the state machine crashed at
/// runtime with <see cref="BadImageFormatException"/>, because (a) the
/// kickoff body's own references to the constructed state-machine type used
/// the SM struct's self-instantiation (<c>!0</c>, a class type-var) instead
/// of the kickoff's own type parameters (<c>!!0</c>, a method type-var, since
/// the kickoff is not itself a member of the SM struct), and (b)
/// <c>MoveNext</c>/<c>SetStateMachine</c> body emission did not push the same
/// outer-method-TP → SM-TP remap used for the SM's FieldDefs, so a hoisted
/// local typed as the kickoff's own type parameter (e.g. the state machine's
/// <c>retVal</c> temp) encoded as a dangling method type-var
/// instead.</description></item>
/// </list>
/// </summary>
public class Issue2030GenericAsyncEmitTests
{
    [Fact]
    public void OpenTypeParameterReturn_CompilesAndRuns()
    {
        // Gap 1 repro (issue body): declared inner return type is the bare
        // open type parameter U.
        var source = """
            package issue2030gap1
            import System
            async func Foo2030A[U](x U) U {
                return x
            }
            var t1 = Foo2030A(42)
            var t2 = Foo2030A("hello")
            Console.WriteLine(t1.Result)
            Console.WriteLine(t2.Result)
            """;

        var output = CompileAndRun(source);

        Assert.Equal("42\nhello\n", output);
    }

    [Fact]
    public void HoistedTypeParameterParameter_ConcreteReturn_CompilesAndRuns()
    {
        // Gap 2 repro (issue body): declared return type is concrete
        // (int32), but the kickoff's own parameter `seed U` must be hoisted
        // into the state machine.
        var source = """
            package issue2030gap2
            async func Answer2030B() int32 {
                return 42
            }
            async func Outer2030B[U](seed U) int32 {
                var r = Answer2030B()
                return await r
            }
            var t = Outer2030B("hi")
            t.Wait()
            Console.WriteLine(t.Result)
            """;

        var output = CompileAndRun(source);

        Assert.Equal("42\n", output);
    }

    [Fact]
    public void MultipleTypeParametersAndGenericInstanceMethod_CompileAndRun()
    {
        // Generalization: more than one method type parameter, plus a
        // generic async INSTANCE method (own type parameters come from the
        // enclosing class, not the method) hoisting a field typed after the
        // class's own type parameter.
        var source = """
            package issue2030gap3
            import System
            import System.Threading.Tasks

            class Box2030C[T] {
                var Value T
                public func init(v T) {
                    Value = v
                }
                public async func GetAsync() T {
                    await Task.Delay(1)
                    return Value
                }
            }

            async func Pair2030C[A, B](a A, b B) A {
                var x = a
                await Task.Delay(1)
                return x
            }

            var box = Box2030C[int32](7)
            var boxed = box.GetAsync()
            Console.WriteLine(boxed.Result)

            var t = Pair2030C[string, int32]("first", 99)
            Console.WriteLine(t.Result)
            """;

        var output = CompileAndRun(source);

        Assert.Equal("7\nfirst\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2030_").FullName;
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

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
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
