// <copyright file="Issue1100GenericMemberOnUserTypeArgEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1100: emitting a member access (method call / field access /
/// constructor) on a constructed BCL generic type whose type argument is a
/// same-compilation user type — e.g. <c>Queue[Entry]</c> with <c>Entry</c>
/// declared in the same assembly — aborted compilation with
/// <c>GS9998: NotSupportedException: TypeBuilder generic instantiation does not
/// support resolving members</c>.
/// <para>
/// Root cause: <see cref="GSharp.Core.CodeAnalysis.Symbols.FunctionTypeSymbol"/>
/// closed the host-runtime open delegate definition over type arguments loaded
/// by the reference resolver's <c>MetadataLoadContext</c>; mixing reflection
/// contexts made <c>Type.MakeGenericType</c> return a
/// <c>System.Reflection.Emit.TypeBuilderInstantiation</c>, and every subsequent
/// reflection probe (binding-time convertibility checks, emit member
/// resolution) threw <see cref="NotSupportedException"/>. The fix surfaces a
/// null (symbolic) CLR type for such unusable instantiations, and the binder
/// recovers the symbolic generic-method return type so <c>Queue[Entry].Dequeue()</c>
/// binds to <c>Entry</c> rather than erasing to <c>object</c>.
/// </para>
/// These tests compile, IL-verify, and run the minimal repro end to end,
/// proving emit no longer throws.
/// </summary>
public class Issue1100GenericMemberOnUserTypeArgEmitTests
{
    [Fact]
    public void QueueOfUserType_EnqueueDequeueCount_EmitsAndRuns()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            class Entry {
                var Value int32
                init(value int32) {
                    Value = value
                }
            }

            class C {
                let q Queue[Entry] = Queue[Entry]()

                func add(e Entry) {
                    q.Enqueue(e)
                }

                func count() int32 {
                    return q.Count
                }

                func drainSum() int32 {
                    var total = 0
                    while q.Count > 0 {
                        let x = q.Dequeue()
                        total = total + x.Value
                    }
                    return total
                }
            }

            var c = C()
            c.add(Entry(10))
            c.add(Entry(20))
            c.add(Entry(12))
            Console.WriteLine(c.count())
            Console.WriteLine(c.drainSum())
            Console.WriteLine(c.count())
            """;

        Assert.Equal("3\n42\n0\n", CompileAndRun(source));
    }

    [Fact]
    public void ListOfUserType_AddIndexCount_EmitsAndRuns()
    {
        // Exercises a second constructed BCL generic (List[T]) member-access
        // family (Add / indexer / Count) over a same-compilation user type.
        var source = """
            package P
            import System
            import System.Collections.Generic

            class Item {
                var Id int32
                init(id int32) {
                    Id = id
                }
            }

            class Bag {
                let items List[Item] = List[Item]()

                func push(i Item) {
                    items.Add(i)
                }

                func first() Item {
                    return items[0]
                }

                func size() int32 {
                    return items.Count
                }
            }

            var b = Bag()
            b.push(Item(7))
            b.push(Item(9))
            var head = b.first()
            Console.WriteLine(head.Id)
            Console.WriteLine(b.size())
            """;

        Assert.Equal("7\n2\n", CompileAndRun(source));
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
