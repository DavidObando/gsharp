// <copyright file="Issue832DiscardedOpenTReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #832 (parent #706, related #806 / ADR-0084). End-to-end emit +
/// IL-verify coverage for instance calls on a symbolic open-generic
/// receiver whose closed CLR shape is type-erased to <c>object</c>.
///
/// Pre-fix, the BoundImportedInstanceCallExpression emit path always
/// invoked <c>EmitErasedObjectReturnWidening</c> with the closed-CLR
/// return type (e.g. <c>Queue&lt;object&gt;::Dequeue() → object</c>).
/// When the receiver was a symbolic container (e.g. <c>Queue[T]</c>
/// with an in-scope <c>T</c>), the MemberRef was already parented at
/// the symbolic instantiation, so the runtime stack value after the
/// <c>callvirt</c> was the substituted symbolic <c>!T</c>, not the
/// erased <c>object</c>. The widening therefore appended a spurious
/// <c>unbox.any !T</c> against a stack slot that already held <c>T</c>.
///
/// The source-level method body usually escaped notice because the
/// widening was emitted while the call's result was on the stack — the
/// caller then either popped it (expression-statement discard) or
/// converted/consumed it. In an iterator <c>MoveNext</c> rewrite the
/// state machine re-loaded the receiver and a <c>callvirt</c>-then-pop
/// shape exposed the bug: ilverify rejected the IL with
/// <c>[StackObjRef] [found value 'T'] Expected an ObjRef on the
/// stack</c> at the spurious unbox, and the runtime threw
/// <c>NullReferenceException</c> from <c>MoveNext</c>.
///
/// The fix routes through a new helper
/// <c>TryGetSymbolicSubstitutedInstanceMethodReturn</c> that mirrors the
/// existing property variant: when the receiver normalises to a
/// symbolic open-generic container, the widening is skipped because
/// the substituted symbolic return type matches the expected bound
/// type and no <c>object→T</c> projection is needed.
///
/// Each test compiles with gsc, verifies via
/// <see cref="IlVerifier.Verify(string, System.Collections.Generic.IEnumerable{string}, System.Collections.Generic.IEnumerable{string})"/>,
/// then runs under <c>dotnet exec</c> and asserts the captured stdout.
/// </summary>
public class Issue832DiscardedOpenTReturnEmitTests
{
    [Fact]
    public void WindowedIteratorRepro_QueueDequeueDiscardClassT_Verifiable()
    {
        // Verbatim repro from issue #832: an iterator that calls
        // `Queue[T]::Dequeue()` in expression-statement position. T is
        // reference-typed at this call site. Pre-fix this asserted both
        //   * ilverify: `[StackObjRef] found value 'T'` at the spurious
        //     unbox.any in the state-machine MoveNext, and
        //   * runtime: `System.NullReferenceException` in
        //     <WindowedIterator>d__N.MoveNext().
        var source = """
            package P
            import System
            import System.Collections.Generic

            func WindowedIterator[T](source IEnumerable[T], size int32) IEnumerable[IList[T]] {
                var buffer = Queue[T](size)
                for item in source {
                    buffer.Enqueue(item)
                    if buffer.Count == size {
                        yield List[T](buffer)
                        buffer.Dequeue()
                    }
                }
            }

            var data = List[string]()
            data.Add("a")
            data.Add("b")
            data.Add("c")
            data.Add("d")
            for w in WindowedIterator[string](data, 2) {
                for x in w {
                    Console.Write(x)
                    Console.Write(" ")
                }

                Console.WriteLine("")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("a b \nb c \nc d \n", output);
    }

    [Fact]
    public void WindowedIteratorRepro_QueueDequeueDiscardStructT_Verifiable()
    {
        // Same iterator as above, but T is a value type at the call
        // site. Pre-fix the spurious `unbox.any !T` against an open
        // value-type T failed ilverify identically, and the JIT shape
        // of `unbox.any` on a value-type stack slot reliably crashed
        // before the iterator even produced its first element.
        var source = """
            package P
            import System
            import System.Collections.Generic

            func WindowedIterator[T](source IEnumerable[T], size int32) IEnumerable[IList[T]] {
                var buffer = Queue[T](size)
                for item in source {
                    buffer.Enqueue(item)
                    if buffer.Count == size {
                        yield List[T](buffer)
                        buffer.Dequeue()
                    }
                }
            }

            var data = List[int32]()
            data.Add(1)
            data.Add(2)
            data.Add(3)
            data.Add(4)
            for w in WindowedIterator[int32](data, 2) {
                for x in w {
                    Console.Write(x)
                    Console.Write(" ")
                }

                Console.WriteLine("")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1 2 \n2 3 \n3 4 \n", output);
    }

    [Fact]
    public void DiscardedOpenT_DirectFunctionBody_ClassT_Verifiable()
    {
        // Strip the iterator state-machine rewrite from the repro so
        // the failing emit is exercised in a plain function body. The
        // discard is the immediate site of the spurious `unbox.any`;
        // pre-fix ilverify rejected this DLL too — the iterator
        // rewrite merely surfaces the failure as a runtime NRE.
        var source = """
            package P
            import System
            import System.Collections.Generic

            func Drain[T class](buffer Queue[T]) int32 {
                var count = 0
                while buffer.Count > 0 {
                    buffer.Dequeue()
                    count = count + 1
                }

                return count
            }

            var q = Queue[string]()
            q.Enqueue("x")
            q.Enqueue("y")
            q.Enqueue("z")
            Console.WriteLine(Drain[string](q))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n", output);
    }

    [Fact]
    public void DiscardedOpenT_DirectFunctionBody_StructT_Verifiable()
    {
        // Same as above, but with an open value-type T. The pre-fix
        // failure mode for struct-T was an `unbox.any !T` against a
        // stack slot that already held the boxed-free `!T`; both
        // ilverify and the runtime rejected it.
        var source = """
            package P
            import System
            import System.Collections.Generic

            func Drain[T struct](buffer Queue[T]) int32 {
                var count = 0
                while buffer.Count > 0 {
                    buffer.Dequeue()
                    count = count + 1
                }

                return count
            }

            var q = Queue[int32]()
            q.Enqueue(10)
            q.Enqueue(20)
            q.Enqueue(30)
            q.Enqueue(40)
            Console.WriteLine(Drain[int32](q))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("4\n", output);
    }

    [Fact]
    public void DiscardedOpenT_ListRemoveDiscard_StructT_Verifiable()
    {
        // Cross-check the fix isn't Queue-specific: a different
        // BCL container method that also returns the open `!T`
        // (`List[T].Remove(item)` returns bool, not T — pick a Stack
        // instead so the discarded return is `T`). This proves the
        // emit guard fires uniformly across symbolic open-generic
        // receivers, not just `Queue[T]`.
        var source = """
            package P
            import System
            import System.Collections.Generic

            func PopAll[T](stack Stack[T]) int32 {
                var n = 0
                while stack.Count > 0 {
                    stack.Pop()
                    n = n + 1
                }

                return n
            }

            var s = Stack[int32]()
            s.Push(1)
            s.Push(2)
            s.Push(3)
            Console.WriteLine(PopAll[int32](s))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue832_emit_").FullName;
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
                $"compile failed ({compileExit}): {compileOut}{compileErr}");
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
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException(
                    "exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
