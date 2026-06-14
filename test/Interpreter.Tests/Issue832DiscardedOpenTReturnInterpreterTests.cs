// <copyright file="Issue832DiscardedOpenTReturnInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #832 — tree-walking interpreter parity for the discarded
/// open-T return shape. The interpreter has no emitted IL, so it
/// never exercised the spurious <c>unbox.any</c> the emit suite
/// guards against, but it MUST still execute the expression-statement
/// discard of a <c>T</c>-returning call without observable effect
/// beyond the call's side effects (here: removing an element from
/// the receiver container).
///
/// Same scope split as Issue #813 / #798 — the open-T iterator path
/// is exercised at a closed instantiation because the tree-walking
/// interpreter has no state-machine substitution for an open generic
/// method-type parameter. The closed shape proves the call dispatch
/// and the discard both behave correctly.
/// </summary>
public class Issue832DiscardedOpenTReturnInterpreterTests
{
    [Fact]
    public void DiscardedDequeue_ClosedQueueOfString_ExecutesSideEffect()
    {
        // `Queue[string]::Dequeue()` is called in expression-statement
        // position. The interpreter must dispatch the call, remove
        // the front element, and discard the returned value without
        // surfacing a binding error or runtime exception.
        var source = """
            import System
            import System.Collections.Generic

            var q = Queue[string]()
            q.Enqueue("a")
            q.Enqueue("b")
            q.Enqueue("c")
            q.Dequeue()
            Console.WriteLine(q.Count)
            Console.WriteLine(q.Peek())
            """;

        Assert.Equal("2\nb\n", RunSubmission(source));
    }

    [Fact]
    public void DiscardedDequeue_ClosedQueueOfInt32_ExecutesSideEffect()
    {
        // Same shape but with a value-type element. The emit path
        // routes through the same `unbox.any` guard; the interpreter
        // simply dispatches the BCL call. The discard must compose
        // with subsequent state checks.
        var source = """
            import System
            import System.Collections.Generic

            var q = Queue[int32]()
            q.Enqueue(10)
            q.Enqueue(20)
            q.Enqueue(30)
            q.Dequeue()
            q.Dequeue()
            Console.WriteLine(q.Count)
            Console.WriteLine(q.Peek())
            """;

        Assert.Equal("1\n30\n", RunSubmission(source));
    }

    [Fact]
    public void DiscardedPop_ClosedStackOfInt32_ExecutesSideEffect()
    {
        // Cross-check the discard works for a different BCL
        // container method (`Stack[T]::Pop()` also returns `T`).
        var source = """
            import System
            import System.Collections.Generic

            var s = Stack[int32]()
            s.Push(1)
            s.Push(2)
            s.Push(3)
            s.Pop()
            Console.WriteLine(s.Count)
            Console.WriteLine(s.Peek())
            """;

        Assert.Equal("2\n2\n", RunSubmission(source));
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
