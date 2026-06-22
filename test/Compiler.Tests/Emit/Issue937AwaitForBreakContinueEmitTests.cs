// <copyright file="Issue937AwaitForBreakContinueEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #937: <c>break</c>, <c>continue</c>, and labeled break/continue were
/// rejected ("The keyword 'break' can only be used inside of loops.") inside an
/// <c>await for</c> (async foreach over an <c>IAsyncEnumerable&lt;T&gt;</c>) loop
/// body, because the binder did not register a loop scope for the async loop the
/// way the synchronous <c>for … in</c> loop does. These tests verify full parity:
/// the keywords now bind, lower, and emit with correct runtime semantics.
/// </summary>
public class Issue937AwaitForBreakContinueEmitTests
{
    #region break inside await for

    [Fact]
    public void AwaitFor_Break_Compiles_And_Runs()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            async func Nums() IAsyncEnumerable[int32] {
                yield 1
                await Task.Delay(1)
                yield 2
                yield 3
                yield 4
            }

            async func Run() {
                var sum = 0
                await for n in Nums() {
                    if n == 3 {
                        break
                    }
                    sum = sum + n
                }
                Console.WriteLine(sum)
            }

            Run().Wait()
            """;

        // 1 + 2 added; 3 breaks before 4. Sum = 3.
        var (_, stdout) = CompileRunCapture(source);
        Assert.Equal("3", stdout.Trim());
    }

    #endregion

    #region continue inside await for

    [Fact]
    public void AwaitFor_Continue_Compiles_And_Runs()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            async func Nums() IAsyncEnumerable[int32] {
                yield 1
                await Task.Delay(1)
                yield 2
                yield 3
                yield 4
            }

            async func Run() {
                var sum = 0
                await for n in Nums() {
                    if n == 2 {
                        continue
                    }
                    if n == 4 {
                        continue
                    }
                    sum = sum + n
                }
                Console.WriteLine(sum)
            }

            Run().Wait()
            """;

        // 2 and 4 skipped via continue; 1 + 3 added. Sum = 4.
        var (_, stdout) = CompileRunCapture(source);
        Assert.Equal("4", stdout.Trim());
    }

    #endregion

    #region break + continue combined

    [Fact]
    public void AwaitFor_BreakAndContinue_Compiles_And_Runs()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            async func Nums() IAsyncEnumerable[int32] {
                yield 1
                await Task.Delay(1)
                yield 2
                yield 3
                yield 4
            }

            async func Run() {
                var sum = 0
                await for n in Nums() {
                    if n == 3 {
                        break
                    }
                    if n == 2 {
                        continue
                    }
                    sum = sum + n
                }
                Console.WriteLine(sum)
            }

            Run().Wait()
            """;

        // 1 added; 2 continues; 3 breaks. Sum = 1.
        var (_, stdout) = CompileRunCapture(source);
        Assert.Equal("1", stdout.Trim());
    }

    #endregion

    #region labeled break / continue across nested await-for loops

    [Fact]
    public void AwaitFor_LabeledBreakAndContinue_Compiles_And_Runs()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            async func Outer() IAsyncEnumerable[int32] {
                yield 1
                await Task.Delay(1)
                yield 2
                yield 3
            }

            async func Inner() IAsyncEnumerable[int32] {
                yield 10
                await Task.Delay(1)
                yield 20
                yield 30
            }

            async func Run() {
                var sum = 0
            outer:
                await for a in Outer() {
                    await for b in Inner() {
                        if b == 20 {
                            continue outer
                        }
                        if a == 3 {
                            break outer
                        }
                        sum = sum + a + b
                    }
                }
                Console.WriteLine(sum)
            }

            Run().Wait()
            """;

        // a=1: b=10 -> sum += 11; b=20 -> continue outer.
        // a=2: b=10 -> sum += 12 (=23); b=20 -> continue outer.
        // a=3: b=10 -> break outer.
        // Sum = 23.
        var (_, stdout) = CompileRunCapture(source);
        Assert.Equal("23", stdout.Trim());
    }

    #endregion

    #region break stops pulling further elements

    [Fact]
    public void AwaitFor_Break_StopsConsuming()
    {
        // The producer prints each element before yielding it. Because the
        // async stream is pull-based, `break` must stop calling MoveNextAsync,
        // so the element after the break point is never produced.
        var source = """
            package Probe
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            async func Stream() IAsyncEnumerable[int32] {
                Console.WriteLine("produce 1")
                yield 1
                await Task.Delay(1)
                Console.WriteLine("produce 2")
                yield 2
                Console.WriteLine("produce 3")
                yield 3
            }

            async func Run() {
                var sum = 0
                await for n in Stream() {
                    sum = sum + n
                    if n == 2 {
                        break
                    }
                }
                Console.WriteLine(sum)
            }

            Run().Wait()
            """;

        // 1 and 2 produced and summed; break prevents "produce 3". Sum = 3.
        var (_, stdout) = CompileRunCapture(source);
        Assert.Equal("produce 1\nproduce 2\n3", stdout.Trim());
    }

    #endregion

    #region Helpers

    private static (Assembly assembly, string stdout) CompileRunCapture(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_937_").FullName;
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
