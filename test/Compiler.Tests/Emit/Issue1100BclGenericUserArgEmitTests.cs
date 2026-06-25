// <copyright file="Issue1100BclGenericUserArgEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1100: member access (method call returning <c>T</c>, method call
/// taking <c>T</c>, property access) on a constructed BCL generic
/// (<c>Queue[Entry]</c>, <c>List[Entry]</c>, <c>Dictionary[string, Entry]</c>)
/// whose type argument is a <em>same-compilation</em> user
/// <c>class</c>/<c>data struct</c>.
/// <para>
/// Binder facet (the standalone-reproducible symptom): a generic member whose
/// open signature returns the type-level parameter <c>T</c> — e.g.
/// <c>Queue&lt;T&gt;.Dequeue()</c> — was typed from the type-erased closed
/// shape (<c>Queue&lt;object&gt;.Dequeue() → object</c>), so
/// <c>var x Entry = q.Dequeue()</c> was rejected with
/// <c>GS0155 ("Cannot convert type 'object' to 'Entry'")</c>. The recovery in
/// <c>ResolveInstanceReturnTypeFromReceiver</c> only fired when the recovered
/// projection still contained an in-scope type parameter (#794); it now also
/// fires when the projection is a same-compilation user type (mirroring the
/// generic-method counterpart fixed for #903), so <c>Dequeue()</c> surfaces
/// the real <c>Entry</c> element type.
/// </para>
/// <para>
/// Emit facet: once binding recovers the user element type, the call's
/// MemberRef parent is the symbolic <c>Queue&lt;Entry&gt;</c> instantiation
/// (encoded via the open definition rather than resolving members off the
/// erased closed shape — #649/#671/#832/#903), and the post-call
/// erasure-widening is short-circuited so no spurious <c>unbox.any</c> /
/// <c>castclass</c> is emitted. These tests compile, IL-verify, and actually
/// run programs exercising the shape end-to-end.
/// </para>
/// </summary>
public class Issue1100BclGenericUserArgEmitTests
{
    [Fact]
    public void QueueOfUserClass_EnqueueDequeueCount_Compiles_And_Runs()
    {
        // The headline repro from the issue's "minimal shape": a `Queue[Entry]`
        // where `Entry` is a same-compilation user class. `Dequeue()` must
        // surface `Entry` (not erased `object`) so `var x Entry = q.Dequeue()`
        // binds without GS0155, and the program must emit and run correctly.
        var source = """
            package P
            import System
            import System.Collections.Generic

            class Entry { var V int32 }

            class C {
                private let q Queue[Entry] = Queue[Entry]()
                func Add(e Entry) { q.Enqueue(e) }
                func Drain() int32 {
                    var sum = 0
                    while q.Count > 0 {
                        var x Entry = q.Dequeue()
                        sum = sum + x.V
                    }
                    return sum
                }
            }

            var c = C()
            var a = Entry()
            a.V = 40
            c.Add(a)
            var b = Entry()
            b.V = 2
            c.Add(b)
            Console.WriteLine(c.Drain())
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void QueueOfUserDataStruct_EnqueueDequeueCount_Compiles_And_Runs()
    {
        // Value-type user argument: `Dequeue()` returns a raw `Item` struct,
        // so the emitter must NOT widen the (erased `object`) return with a
        // spurious `unbox.any` — that would be ilverify-rejected and crash.
        var source = """
            package P
            import System
            import System.Collections.Generic

            data struct Item(Name string, Price int32)

            class C {
                private let q Queue[Item] = Queue[Item]()
                func Add(i Item) { q.Enqueue(i) }
                func Total() int32 {
                    var sum = 0
                    while q.Count > 0 {
                        var x Item = q.Dequeue()
                        sum = sum + x.Price
                    }
                    return sum
                }
            }

            var c = C()
            c.Add(Item{Name: "a", Price: 40})
            c.Add(Item{Name: "b", Price: 2})
            Console.WriteLine(c.Total())
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void ListOfUserClass_AddIndexerForInCount_Compiles_And_Runs()
    {
        // `List[Entry]`: `Add(T)` (param), indexer read (`list[i] → Entry`),
        // `for-in` element type recovery, and `Count`.
        var source = """
            package P
            import System
            import System.Collections.Generic

            class Entry { var V int32 }

            class C {
                private let l List[Entry] = List[Entry]()
                func Add(e Entry) { l.Add(e) }
                func SumViaIndexer() int32 {
                    var sum = 0
                    var i = 0
                    while i < l.Count {
                        var x Entry = l[i]
                        sum = sum + x.V
                        i = i + 1
                    }
                    return sum
                }
                func SumViaForIn() int32 {
                    var sum = 0
                    for item in l { sum = sum + item.V }
                    return sum
                }
            }

            var c = C()
            var a = Entry()
            a.V = 10
            c.Add(a)
            var b = Entry()
            b.V = 32
            c.Add(b)
            Console.WriteLine(c.SumViaIndexer())
            Console.WriteLine(c.SumViaForIn())
            """;

        Assert.Equal("42\n42\n", CompileAndRun(source));
    }

    [Fact]
    public void DictionaryOfUserValue_WriteReadIndexer_Compiles_And_Runs()
    {
        // `Dictionary[string, Entry]`: indexer write (`d[k] = e`), indexer read
        // recovering the `Entry` value type, and `TryGetValue` out-parameter.
        var source = """
            package P
            import System
            import System.Collections.Generic

            class Entry { var V int32 }

            class C {
                private let d Dictionary[string, Entry] = Dictionary[string, Entry]()
                func Put(key string, e Entry) { d[key] = e }
                func Get(key string) int32 {
                    var got Entry = d[key]
                    return got.V
                }
                func TryGet(key string) int32 {
                    var ok = d.TryGetValue(key, out var found)
                    if ok { return found.V }
                    return -1
                }
            }

            var c = C()
            var a = Entry()
            a.V = 42
            c.Put("k", a)
            Console.WriteLine(c.Get("k"))
            Console.WriteLine(c.TryGet("k"))
            Console.WriteLine(c.TryGet("missing"))
            """;

        Assert.Equal("42\n42\n-1\n", CompileAndRun(source));
    }

    [Fact]
    public void QueueOfUserClass_DequeueReturnedFromMethod_Compiles_And_Runs()
    {
        // A method whose declared return type IS the user type and whose body
        // returns `q.Dequeue()` directly — the binder must recover `Entry` for
        // the return without an intervening local annotation (GS0155 guard).
        var source = """
            package P
            import System
            import System.Collections.Generic

            class Entry { var V int32 }

            class C {
                private let q Queue[Entry] = Queue[Entry]()
                func Add(e Entry) { q.Enqueue(e) }
                func Next() Entry { return q.Dequeue() }
            }

            var c = C()
            var a = Entry()
            a.V = 7
            c.Add(a)
            var n = c.Next()
            Console.WriteLine(n.V)
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1100_emit_").FullName;
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
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }
}
