// <copyright file="Issue798SharedStaticIteratorInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #798 / ADR-0084 §L5 — tree-walking interpreter parity for
/// the shared-static-iterator binding path. The reported symptom
/// surfaced through the gsc no-output path (which routes through
/// <c>Compilation.Evaluate</c> / <c>ControlFlowGraph.Create</c>)
/// as <c>GS9998: Unexpected statement: YieldStatement</c> because
/// the CFG builder's terminator switch did not list
/// <c>BoundYieldStatement</c>. The fix adds it to the fall-through
/// arm so the interpreter accepts iterator bodies in
/// shared-static methods.
/// </summary>
/// <remarks>
/// Coverage here uses concretely-instantiated iterator return
/// types (e.g. <c>IEnumerable[int32]</c>). The tree-walking
/// interpreter shares the same generic-iterator gap noted in the
/// emit suite (<c>Issue798SharedStaticIteratorEmitTests</c>) — the
/// open-T form binds cleanly post-fix (see the binder tests) but
/// the interpreter has no state-machine substitution for an open
/// generic method-type-parameter SM yet. That gap is tracked
/// separately.
/// </remarks>
public class Issue798SharedStaticIteratorInterpreterTests
{
    [Fact]
    public void SharedStatic_IEnumerableInt_Iterator_Runs()
    {
        var source = """
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Of(a int32, b int32, c int32) IEnumerable[int32] {
                        yield a
                        yield b
                        yield c
                    }
                }
            }

            var sum = 0
            for x in Sequences.Of(10, 20, 12) {
                sum = sum + x
            }
            Console.WriteLine(sum)
            """;

        Assert.Equal("42\n", RunSubmission(source));
    }

    [Fact]
    public void SharedStatic_SequenceInt_Iterator_Runs()
    {
        var source = """
            class Sequences {
                shared {
                    func Of(a int32, b int32, c int32) sequence[int32] {
                        yield a
                        yield b
                        yield c
                    }
                }
            }

            var sum = 0
            for x in Sequences.Of(1, 2, 3) {
                sum = sum + x
            }
            Console.WriteLine(sum)
            """;

        Assert.Equal("6\n", RunSubmission(source));
    }

    [Fact]
    public void SharedStatic_AsyncIEnumerableInt_Iterator_Runs()
    {
        var source = """
            import System.Collections.Generic
            import System.Threading.Tasks

            class Sequences {
                shared {
                    async func Of(a int32, b int32) IAsyncEnumerable[int32] {
                        yield a
                        await Task.Delay(1)
                        yield b
                    }
                }
            }

            var sum = 0
            let e = Sequences.Of(10, 32).GetAsyncEnumerator()
            for e.MoveNextAsync().AsTask().Result {
                sum = sum + e.Current
            }
            Console.WriteLine(sum)
            """;

        Assert.Equal("42\n", RunSubmission(source));
    }

    [Fact]
    public void SharedStatic_AsyncSequenceInt_Iterator_Runs()
    {
        // ADR-0041: `async func ... sequence[T]` resolves to
        // AsyncSequenceTypeSymbol. Verify the interpreter accepts
        // and executes this shape on a shared-static method.
        var source = """
            import System.Threading.Tasks

            class Sequences {
                shared {
                    async func Of(a int32, b int32) sequence[int32] {
                        yield a
                        await Task.Delay(1)
                        yield b
                    }
                }
            }

            var sum = 0
            let e = Sequences.Of(100, 23).GetAsyncEnumerator()
            for e.MoveNextAsync().AsTask().Result {
                sum = sum + e.Current
            }
            Console.WriteLine(sum)
            """;

        Assert.Equal("123\n", RunSubmission(source));
    }

    [Fact]
    public void SharedStatic_Empty_Iterator_Runs()
    {
        // The literal `Sequences.Empty` repro from the issue at a
        // concrete instantiation — confirms the binder accepts the
        // body and the CFG no longer crashes through the interpreter
        // path.
        var source = """
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Empty() IEnumerable[int32] {
                        for v in []int32{} {
                            yield v
                        }
                    }

                    func Of(v int32) IEnumerable[int32] {
                        yield v
                    }
                }
            }

            var sum = 0
            for x in Sequences.Empty() {
                sum = sum + x
            }
            for y in Sequences.Of(7) {
                sum = sum + y
            }
            for z in Sequences.Of(35) {
                sum = sum + z
            }
            Console.WriteLine(sum)
            """;

        Assert.Equal("42\n", RunSubmission(source));
    }

    private static string RunSubmission(string text)
    {
        using var outWriter = new StringWriter();
        var prevOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var repl = new GSharpRepl();
            repl.EvaluateSubmission(text);
        }
        finally
        {
            Console.SetOut(prevOut);
        }

        return outWriter.ToString().Replace("\r\n", "\n");
    }
}
