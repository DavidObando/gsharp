// <copyright file="Issue3465CompilerInferenceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue3465CompilerInferenceEmitTests
{
    [Fact]
    public void SourceImplementedClrInterface_Inference_CompilesAndRuns()
    {
        const string source = """
            package i3465source
            import System
            import System.Collections
            import System.Collections.Generic

            class Repo[T] : IEnumerable[T] {
                private let items List[T] = List[T]()

                init(value T) {
                    items.Add(value)
                }

                func GetEnumerator() IEnumerator[T] -> items.GetEnumerator()
                private func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()
            }

            func First[T](items IEnumerable[T]) T {
                for item in items {
                    return item
                }

                return default(T)
            }

            func Main() {
                Console.WriteLine(First(Repo[int32](23)))
            }
            """;

        Assert.Equal($"23{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void NestedDelegateTargets_ThroughReturnsAndCoalesce_CompileAndRun()
    {
        const string source = """
            package i3465lambda
            import System

            func Accept(factory ()->Action[int32]) {
                factory()(2)
            }

            func Choose(factory ()->Action[int32]) int32 -> 1
            func Choose(factory ()->Func[int32, int32]) int32 -> 2
            func VisitValue(action (int32)->int32) {}

            class Visitor {
                shared {
                    func Visit(action (int32)->void) {
                        action(3)
                    }
                }
            }

            func BindNonCompleting() {
                VisitValue((value) -> { throw Exception("stop") })
                VisitValue((value) -> { for { } })
            }

            func Main() {
                var total = 0
                let flag = true
                Accept(factory: () -> {
                    return (((value) -> { total += value }))
                })
                Accept(() -> {
                    return flag
                        ? ((value) -> { total += value })
                        : ((value) -> { total += 100 })
                })
                Accept(factory: () -> nil ?? ((value) -> { total += value }))
                Visitor.Visit((value int32) -> { total += value })
                let selected = Choose(factory: () -> {
                    return (((value) -> {}))
                })
                Console.WriteLine((total * 10) + selected)
            }
            """;

        Assert.Equal($"91{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void ConstructorAndExpressionTreeLambdaTargets_CompileVerifyAndRun()
    {
        const string source = """
            package i3465targets
            import System
            import System.Linq.Expressions

            class Visitor {
                init(action (int32)->void) {
                    Console.Write(1)
                }

                init(action (int32)->int32) {
                    Console.Write(2)
                }
            }

            func Make() Expression[Func[int32, int32]] {
                return (value) -> value + 1
            }

            func Main() {
                Visitor((value) -> {})
                Console.WriteLine(Make().Compile()(4))
            }
            """;

        Assert.Equal($"15{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void NamedConstructorAndNestedExpressionTreeLambdaTargets_CompileVerifyAndRun()
    {
        const string source = """
            package i3465followup
            import System
            import System.Linq.Expressions

            class Visitor {
                init(transform (int32)->int32, action (string)->void) {
                    Console.Write(transform(4))
                    action("ok")
                }
            }

            func Make() Expression[Func[Func[int32, int32]]] {
                return () -> (value) -> value + 1
            }

            func MakeTyped() Expression[Func[int32, Func[int32, int32]]] {
                return (outer int32) -> (value) -> value + 2
            }

            func Main() {
                Visitor(
                    action: (text) -> Console.Write(text),
                    transform: (value) -> value + 1)
                Console.WriteLine(Make().Compile()()(4))
                Console.WriteLine(MakeTyped().Compile()(0)(4))
            }
            """;

        Assert.Equal(
            $"5ok5{Environment.NewLine}6{Environment.NewLine}",
            CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var workDir = Path.Combine(
            AppContext.BaseDirectory,
            "issue3465_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        try
        {
            var srcPath = Path.Combine(workDir, "test.gs");
            var outPath = Path.Combine(workDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
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
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            Assert.True(
                compileExit == 0,
                $"compile failed ({compileExit}): {compileOut}{compileErr}");
            IlVerifier.Verify(outPath);

            File.WriteAllText(Path.ChangeExtension(outPath, "runtimeconfig.json"), """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var startInfo = new ProcessStartInfo(
                "dotnet",
                "exec \"" + outPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var process = Process.Start(startInfo)!;
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();
            Assert.True(
                process.ExitCode == 0,
                $"exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
            return stdout;
        }
        finally
        {
            try
            {
                Directory.Delete(workDir, recursive: true);
            }
            catch
            {
            }
        }
    }
}
