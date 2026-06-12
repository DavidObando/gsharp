// <copyright file="Issue652AwaitForAsyncEnumerableEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #652: <c>await for x in y</c> over <c>IAsyncEnumerable&lt;T&gt;</c>
/// triggered GS9998 ("Type must be a type provided by the MetadataLoadContext")
/// because the lowering mixed runtime <c>typeof(...)</c> types with
/// MetadataLoadContext-loaded types when constructing generic instantiations.
/// These tests verify that the desugaring correctly derives all helper types
/// from the same context as the stream type.
/// </summary>
public class Issue652AwaitForAsyncEnumerableEmitTests
{
    #region Free async-yield function producer

    [Fact]
    public void AwaitFor_FreeFunction_Producer_Compiles_And_Runs()
    {
        // Free function returning IAsyncEnumerable[int32] consumed via await for.
        var source = """
            package Probe
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            async func Inner() IAsyncEnumerable[int32] {
                yield 1
                await Task.Delay(1)
                yield 2
            }

            async func Consume() {
                var sum = 0
                let seq = Inner()
                await for n in seq {
                    sum = sum + n
                }
                Console.WriteLine(sum)
            }

            Consume().Wait()
            """;

        var (assembly, stdout) = CompileRunCapture(source);
        Assert.Equal("3", stdout.Trim());
    }

    #endregion

    #region Class member producer

    [Fact]
    public void AwaitFor_ClassMember_Producer_Compiles_And_Runs()
    {
        // Class method returning IAsyncEnumerable[int32] consumed via await for.
        var source = """
            package Probe
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            class Producer {
                init() {}

                async func Numbers() IAsyncEnumerable[int32] {
                    yield 10
                    await Task.Delay(1)
                    yield 20
                    await Task.Delay(1)
                    yield 30
                }
            }

            async func Run() {
                var sum = 0
                let p = Producer()
                await for n in p.Numbers() {
                    sum = sum + n
                }
                Console.WriteLine(sum)
            }

            Run().Wait()
            """;

        var (assembly, stdout) = CompileRunCapture(source);
        Assert.Equal("60", stdout.Trim());
    }

    #endregion

    #region Nested await-for (await for inside await for)

    [Fact]
    public void AwaitFor_Nested_Compiles_And_Runs()
    {
        // Two nested await-for loops over independent async enumerables.
        var source = """
            package Probe
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            async func Outer() IAsyncEnumerable[int32] {
                yield 1
                await Task.Delay(1)
                yield 2
            }

            async func Inner(x int32) IAsyncEnumerable[int32] {
                yield x * 10
                await Task.Delay(1)
                yield x * 100
            }

            async func Run() {
                var sum = 0
                await for a in Outer() {
                    await for b in Inner(a) {
                        sum = sum + b
                    }
                }
                Console.WriteLine(sum)
            }

            Run().Wait()
            """;

        // Outer yields 1, 2
        // Inner(1) yields 10, 100 → 110
        // Inner(2) yields 20, 200 → 220
        // Total = 330
        var (assembly, stdout) = CompileRunCapture(source);
        Assert.Equal("330", stdout.Trim());
    }

    #endregion

    #region await for with string element type

    [Fact]
    public void AwaitFor_StringElement_Compiles_And_Runs()
    {
        // Ensure the fix works for reference-type element types too.
        var source = """
            package Probe
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            async func Words() IAsyncEnumerable[string] {
                yield "hello"
                await Task.Delay(1)
                yield "world"
            }

            async func Run() {
                var result = ""
                await for w in Words() {
                    result = result + w + " "
                }
                Console.Write(result)
            }

            Run().Wait()
            """;

        var (assembly, stdout) = CompileRunCapture(source);
        Assert.Equal("hello world ", stdout);
    }

    #endregion

    #region Helpers

    private static (Assembly assembly, string stdout) CompileRunCapture(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_652_").FullName;
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

        var bytes = File.ReadAllBytes(outPath);
        var assembly = Assembly.Load(bytes);

        // Run the entry point and capture stdout
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);

        var captured = new StringWriter();
        var prevOut2 = Console.Out;
        Console.SetOut(captured);
        try
        {
            entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
        }
        finally
        {
            Console.SetOut(prevOut2);
        }

        return (assembly, captured.ToString().Replace("\r\n", "\n"));
    }

    #endregion
}
