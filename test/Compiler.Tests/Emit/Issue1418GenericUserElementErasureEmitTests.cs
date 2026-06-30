// <copyright file="Issue1418GenericUserElementErasureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1418 (follow-up to #1344): generalizes user-element preservation
/// across <em>any</em> constructed CLR generic <c>G[Entry]</c> surfaced from a
/// property, not just the enumerable-collection (#1328) and channel-reader
/// /writer (#1344) shapes that were previously allow-listed.
/// <para>
/// A same-compilation user type used as a CLR generic argument is erased to
/// <c>System.Object</c> on the closed type. When a property's open type is a
/// constructed generic over the receiver's type parameter (e.g.
/// <c>TaskCompletionSource[Entry].Task</c> -> <c>Task&lt;TResult&gt;</c>, or
/// <c>LinkedList[Entry].First</c> -> <c>LinkedListNode&lt;T&gt;</c>), the closed
/// reflection type reports <c>Task[object]</c> / <c>LinkedListNode[object]</c>,
/// collapsing the element type for every downstream projection
/// (<c>await</c>, <c>.Result</c>, chained member access). The fix surfaces the
/// symbolic <c>[Entry]</c> projection whenever it carries a same-compilation
/// user type anywhere, while member lookup still resolves against the erased
/// closed shape (proven by #1088).
/// </para>
/// These tests compile, IL-verify, and run each repro end-to-end.
/// </summary>
public class Issue1418GenericUserElementErasureEmitTests
{
    [Fact]
    public void TaskCompletionSourceTask_UserElement_AwaitBindsAndRuns()
    {
        // `TaskCompletionSource[Entry].Task` -> `Task[Entry]` is neither an
        // enumerable collection nor a channel; before #1418 it erased to
        // `Task[object]`, so `await tcs.Task` bound the result as `object` and
        // `e.V` failed GS0158.
        var source = """
            package P
            import System
            import System.Threading.Tasks

            class Issue1418TaskEntry { var V int32 = 0 }

            public var total = 0
            async func Consume(tcs TaskCompletionSource[Issue1418TaskEntry]) {
                let e = await tcs.Task
                total = total + e.V
            }

            let tcs = TaskCompletionSource[Issue1418TaskEntry]()
            var a = Issue1418TaskEntry()
            a.V = 42
            tcs.SetResult(a)
            Consume(tcs).Wait()
            Console.WriteLine(total)
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void TaskCompletionSourceTask_UserElement_ResultBindsAndRuns()
    {
        // The same symbolic `Task[Entry]` flowing through the synchronous
        // `.Result` surface (open type `TResult`, a bare parameter on the now
        // preserved `Task[Entry]`).
        var source = """
            package P
            import System
            import System.Threading.Tasks

            class Issue1418ResultEntry { var V int32 = 0 }

            let tcs = TaskCompletionSource[Issue1418ResultEntry]()
            var a = Issue1418ResultEntry()
            a.V = 7
            tcs.SetResult(a)
            let e = tcs.Task.Result
            Console.WriteLine(e.V)
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    [Fact]
    public void LinkedListNodeProperty_UserElement_ChainedAccessBindsAndRuns()
    {
        // `LinkedList[Entry].First` -> `LinkedListNode[Entry]` is a NON-enumerable
        // constructed generic property; before #1418 it erased to
        // `LinkedListNode[object]`, so `node.Value` bound as `object` and
        // `node.Value.V` failed GS0158. (`LinkedList` itself is enumerable, but
        // the `.First` PROPERTY type — `LinkedListNode<T>` — is not.)
        var source = """
            package P
            import System
            import System.Collections.Generic

            class Issue1418NodeEntry { var V int32 = 0 }

            let ll = LinkedList[Issue1418NodeEntry]()
            var a = Issue1418NodeEntry()
            a.V = 11
            ll.AddLast(a)
            let node = ll.First
            Console.WriteLine(node.Value.V)
            """;

        Assert.Equal("11\n", CompileAndRun(source));
    }

    [Fact]
    public void ChannelReaderWriter_UserElement_StillBindsAndRuns()
    {
        // Regression guard: the #1344 channel shape, previously handled by a
        // dedicated allow-list now folded into the general rule, keeps working.
        var source = """
            package P
            import System
            import System.Threading.Channels

            class Issue1418ChanEntry { var V int32 = 0 }

            public var total = 0
            async func Consume(ch Channel[Issue1418ChanEntry]) {
                await for m in ch.Reader.ReadAllAsync() {
                    total = total + m.V
                }
            }

            let ch = Channel.CreateUnbounded[Issue1418ChanEntry]()
            var a = Issue1418ChanEntry()
            a.V = 5
            var w1 = ch.Writer.TryWrite(a)
            var b = Issue1418ChanEntry()
            b.V = 9
            var w2 = ch.Writer.TryWrite(b)
            ch.Writer.Complete()
            Consume(ch).Wait()
            Console.WriteLine(total)
            """;

        Assert.Equal("14\n", CompileAndRun(source));
    }

    [Fact]
    public void DictionaryValuesCollection_UserElement_StillBindsAndRuns()
    {
        // Regression guard: the #1328 enumerable-collection shape
        // (`Dictionary[K, Entry].Values` -> `ValueCollection[K, Entry]`), also
        // folded into the general rule, keeps preserving the element type
        // through the `for … in` surface.
        var source = """
            package P
            import System
            import System.Collections.Generic

            class Issue1418DictEntry { var V int32 = 0 }

            let d = Dictionary[int32, Issue1418DictEntry]()
            var a = Issue1418DictEntry()
            a.V = 3
            d[1] = a
            var b = Issue1418DictEntry()
            b.V = 8
            d[2] = b
            var total = 0
            for e in d.Values {
                total = total + e.V
            }
            Console.WriteLine(total)
            """;

        Assert.Equal("11\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1418_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
            string Ref(string name) => "/r:" + Path.Combine(runtimeDir, name);

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
                    Ref("System.Private.CoreLib.dll"),
                    Ref("System.Runtime.dll"),
                    Ref("System.Console.dll"),
                    Ref("System.Collections.dll"),
                    Ref("System.Threading.dll"),
                    Ref("System.Threading.Channels.dll"),
                    Ref("System.Threading.Tasks.dll"),
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
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch (IOException)
            {
            }
        }
    }
}
