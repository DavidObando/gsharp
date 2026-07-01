// <copyright file="Issue1567GetOnlyCollectionInitEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// End-to-end emit tests for issue #1567 — populating a get-only collection
/// property at construction via a braced collection-initializer nested inside
/// an object/composite initializer (<c>T{ Member: { a, b } }</c>). This mirrors
/// C#'s <c>new T { Prop = { a, b } }</c>, which lowers to
/// <c>receiver.Prop.Add(a); receiver.Prop.Add(b);</c> and therefore does NOT
/// require a setter on <c>Prop</c>.
/// <para>
/// Each test compiles a G# program, IL-verifies the produced assembly, runs it,
/// and asserts the runtime contents (counts, elements, dictionary lookups) so
/// the lowering to <c>Add</c> / indexer-set against the get-only property's
/// backing collection is exercised at execution time. Every user type is given
/// a unique name because the name-keyed FunctionTypeSymbol cache is not cleared
/// between tests.
/// </para>
/// </summary>
public class Issue1567GetOnlyCollectionInitEmitTests
{
    [Fact]
    public void GetOnlyList_EmptySingleAndMany_Add()
    {
        // Empty, single, and many-element braced initializers all lower to
        // Add calls on the get-only IList property's backing list.
        var source = """
            package Issue1567List
            import System
            import System.Collections.Generic

            class BagL1567 {
                prop Items IList[int32] { get; init; }
                init() {
                    Items = List[int32]()
                }
            }

            var empty = BagL1567{ Items: {} }
            Console.WriteLine(empty.Items.Count)

            var one = BagL1567{ Items: { 42 } }
            Console.WriteLine(one.Items.Count)
            Console.WriteLine(one.Items[0])

            var many = BagL1567{ Items: { 10, 20, 30 } }
            Console.WriteLine(many.Items.Count)
            Console.WriteLine(many.Items[0])
            Console.WriteLine(many.Items[2])
            """;

        Assert.Equal("0\n1\n42\n3\n10\n30\n", CompileAndRun(source));
    }

    [Fact]
    public void GetOnlyCollection_StringElements_Add()
    {
        // A get-only System.Collections.ObjectModel.Collection[string] populated
        // via the braced form, alongside a settable scalar member on the same
        // composite literal.
        var source = """
            package Issue1567Coll
            import System
            import System.Collections.Generic
            import System.Collections.ObjectModel

            class BagC1567 {
                prop Tag string { get; init; }
                prop Names Collection[string] { get; init; }
                init() {
                    Tag = ""
                    Names = Collection[string]()
                }
            }

            var b = BagC1567{ Tag: "hi", Names: { "alice", "bob", "carol" } }
            Console.WriteLine(b.Tag)
            Console.WriteLine(b.Names.Count)
            Console.WriteLine(b.Names[0])
            Console.WriteLine(b.Names[2])
            """;

        Assert.Equal("hi\n3\nalice\ncarol\n", CompileAndRun(source));
    }

    [Fact]
    public void GetOnlyDictionary_KeyedAndIndexedEntries_Add()
    {
        // A get-only IDictionary populated with both the "k": v and ["k"] = v
        // entry spellings; both lower to Add(k, v) / indexer-set.
        var source = """
            package Issue1567Dict
            import System
            import System.Collections.Generic

            class BagD1567 {
                prop Lookup IDictionary[string, int32] { get; init; }
                init() {
                    Lookup = Dictionary[string, int32]()
                }
            }

            var b = BagD1567{ Lookup: { "a": 1, ["b"] = 2, "c": 3 } }
            Console.WriteLine(b.Lookup.Count)
            Console.WriteLine(b.Lookup["a"])
            Console.WriteLine(b.Lookup["b"])
            Console.WriteLine(b.Lookup["c"])
            """;

        Assert.Equal("3\n1\n2\n3\n", CompileAndRun(source));
    }

    [Fact]
    public void SettableCollectionProperty_BracedForm_AlsoAdds()
    {
        // C# uses Add-lowering for `Prop = { ... }` even when the property is
        // settable. The braced form must therefore Add (not replace) regardless
        // of writability — proven by pre-seeding the collection in init().
        var source = """
            package Issue1567Settable
            import System
            import System.Collections.Generic

            class BagS1567 {
                prop Items IList[int32] { get; set; }
                init() {
                    Items = List[int32]()
                    Items.Add(1)
                }
            }

            var b = BagS1567{ Items: { 2, 3 } }
            Console.WriteLine(b.Items.Count)
            Console.WriteLine(b.Items[0])
            Console.WriteLine(b.Items[2])
            """;

        Assert.Equal("3\n1\n3\n", CompileAndRun(source));
    }

    [Fact]
    public void GetOnlyNonCollection_ScalarAssign_ReportsGs0127()
    {
        // GS0127 must still fire for a genuine attempt to assign a
        // non-collection get-only property via the plain (non-braced) form.
        var source = """
            package Issue1567Neg1
            import System

            class BagN1567 {
                prop RoInt int32 { get; }
                init() {
                }
            }

            var b = BagN1567{ RoInt: 5 }
            """;

        var (exit, diagnostics) = CompileExpectingFailure(source);
        Assert.NotEqual(0, exit);
        Assert.Contains("GS0127", diagnostics);
    }

    [Fact]
    public void BracedFormOnNonCollectionProperty_ReportsGs0369()
    {
        // The braced form on a member whose type has no accessible Add must
        // report GS0369 (not collection-initializable), never an internal
        // error and never a silent assignment.
        var source = """
            package Issue1567Neg2
            import System

            class BagM1567 {
                prop RoInt int32 { get; init; }
                init() {
                    RoInt = 0
                }
            }

            var b = BagM1567{ RoInt: { 1, 2 } }
            """;

        var (exit, diagnostics) = CompileExpectingFailure(source);
        Assert.NotEqual(0, exit);
        Assert.Contains("GS0369", diagnostics);
    }

    private static string CompileAndRun(string source)
    {
        var (exit, output, diagnostics) = Compile(source, run: true);
        Assert.True(exit == 0, $"compile/run failed ({exit}): {diagnostics}");
        return output;
    }

    private static (int Exit, string Diagnostics) CompileExpectingFailure(string source)
    {
        var (exit, _, diagnostics) = Compile(source, run: false);
        return (exit, diagnostics);
    }

    private static (int Exit, string Output, string Diagnostics) Compile(string source, bool run)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1567_").FullName;
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

            var diagnostics = compileOut.ToString() + compileErr.ToString();
            if (compileExit != 0 || !run)
            {
                return (compileExit, string.Empty, diagnostics);
            }

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

            return (0, stdout.Replace("\r\n", "\n"), diagnostics);
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
