// <copyright file="Issue4033MemberOnAnElementFromKeysOrValuesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4033: a member call on an element obtained by iterating a
/// dictionary's <c>.Values</c> (or <c>.Keys</c>) failed — <c>GS0158</c>, or the
/// internal-compiler-error <c>GS9998</c> — while the same member on the same
/// value reached through the indexer, through <c>for k, v in m</c>, or through
/// <c>TryGetValue</c> bound fine.
/// </summary>
/// <remarks>
/// <para><b>Root cause.</b> <c>Dictionary&lt;,&gt;.Values</c> is declared
/// <c>[Nullable({1, 0, 0})]</c> — measured off the reference assemblies. Byte 0
/// is <c>ValueCollection</c> itself (not-null); the two zeroes sit at the
/// <c>TKey</c>/<c>TValue</c> positions, which are type PARAMETERS: the declarer
/// cannot know what they will be substituted with, so the byte is a
/// placeholder, not an annotation. <c>MemberLookup.GetClrPropertyTypeSymbol</c>
/// only projected the receiver's symbolic arguments through the open property
/// when <c>projectOnlyWhenSymbolicallyRequired</c> was satisfied by one of two
/// narrow probes, so a CLOSED <c>Dictionary[string, string]</c> fell back to
/// reading those placeholder bytes as concrete positions. Issue #1354's rule —
/// "an unannotated reference position means <c>T?</c>" — then applied to a slot
/// that has no annotation to be oblivious ABOUT, and <c>.Keys</c>/<c>.Values</c>
/// surfaced a <c>string?</c> element. Because G# deliberately requires
/// narrowing or <c>?.</c> before reading a PROPERTY off an explicit <c>T?</c>
/// (but not before calling a METHOD), the loop body then lost the element's
/// whole CLR property/field surface.</para>
/// <para><b>The machinery to do this right already existed.</b>
/// <c>NullableFlagsBuilder.MergeDeclarationNullability</c> carries an explicit,
/// documented carve-out taking a type-parameter position's nullability from the
/// receiver's ARGUMENT rather than from the declaration byte — which is exactly
/// why the OPEN <c>map[K, V].Keys</c> spelling was always right (issue #3311
/// pins it). The gate simply never let a closed receiver reach it. The fix
/// projects whenever the open property type mentions a parameter at all, and
/// leaves the merge deciding concrete positions, so #1354 is untouched.</para>
/// <para><b>The map spelling needed a second half.</b> A closed
/// <c>map[K, V]</c> arrives as a <see cref="GSharp.Core.CodeAnalysis.Symbols.MapTypeSymbol"/>,
/// which is neither an <c>ImportedTypeSymbol</c> nor a <c>StructSymbol</c>, so
/// <c>GetProjectionReceiverImportedType</c> answered <see langword="null"/> and
/// the map spelling stayed broken after the <c>Dictionary</c> spelling was
/// fixed. <c>TryGetClosedMapProjectionView</c> surfaces the
/// <c>Dictionary[K, V]</c> view ADR-0104 says it IS. Its open definition comes
/// from the map's OWN <c>ClrType</c>, because #4023 may have built that
/// dictionary inside a <c>MetadataLoadContext</c>.</para>
/// <para><b>The issue's own diagnosis is wrong on two axes, measured.</b> It
/// names the failing ingredient as "when the value is a CONSTRUCTED GENERIC".
/// The real predicate is "a PROPERTY (not a method) on an element from
/// <c>.Keys</c>/<c>.Values</c>": <c>for v in Dictionary[string, string]().Values
/// { v.Length }</c> fails identically on <c>3e5103de</c> with a plain
/// <c>string</c> value, and the issue's own "green" row
/// <c>for v in m.Values { v.Name }</c> is green only because it was never run —
/// see <see cref="AcceptedCases"/>'s <c>string</c> rows. Conversely
/// <c>x.Add(7)</c> — a METHOD on the very element the issue reports as broken —
/// was already green, because a call never consults the receiver gate. Both
/// corrections are posted on the issue and pinned by the rows below.</para>
/// <para><b>The issue also under-reports the blast radius.</b> It records
/// <c>.Keys</c> as "unaffected in the measured rows" and a generic key as "not
/// probed". Measured: <c>.Keys</c> is affected identically, a generic KEY
/// (<c>Dictionary[List[int32], string]</c>) is affected, and so is
/// <c>SortedDictionary[K, V].Values</c> — every nested <c>KeyCollection</c> /
/// <c>ValueCollection</c>. Non-nested generic collections
/// (<c>List</c>, <c>HashSet</c>, <c>Queue</c>, <c>Stack</c>,
/// <c>LinkedList</c>) were never affected and are control rows.</para>
/// <para><b>The old reading was not faithful either.</b> Measured on
/// <c>3e5103de</c>: a <c>Dictionary&lt;string, string?&gt;</c> and a
/// <c>Dictionary&lt;string, string&gt;</c> returned from the SAME
/// nullable-enabled C# assembly both surfaced a <c>string?</c> element from
/// <c>.Values</c>, because both read the same placeholder byte — while both
/// dictionaries' own indexer and <c>for k, v</c> already surfaced <c>string</c>.
/// So the fix does not lose information the compiler had; it makes
/// <c>.Values</c> agree with the two paths that were already right. Recovering
/// a genuinely-annotated imported value's <c>string?</c> on any of the three
/// paths is a separate, pre-existing gap —
/// <c>GetProjectionReceiverImportedType</c> unwraps a
/// <c>NullabilityAnnotatedTypeSymbol</c> to its bare base, discarding the
/// per-position flags that <c>GetClrFieldTypeSymbol</c> alone rebuilds — and it
/// is measured, filed, and untouched here.</para>
/// <para><b>Out of scope, measured and reported.</b> The issue notes "a missing
/// diagnostic underneath". Measured, the residual <c>GS9998</c> is a METHOD
/// GROUP in value position: <c>l.Count</c> on a <c>List[int32]?</c> binds
/// LINQ's <c>Enumerable.Count</c> extension group, and <c>.ToString()</c> on a
/// method group reaches emit unreported. It reproduces with no nullable in
/// sight — <c>List[int32]().Add.ToString()</c> on a plain non-nullable receiver
/// gives the identical GS9998 — so it is neither this bug nor a nullability
/// bug. Filed separately; no new diagnostic is minted here.</para>
/// <para><b>Discrimination witness (ADR-0154).</b> Reverting
/// <c>src/Core/CodeAnalysis/Binding/MemberLookup.cs</c> to <c>3e5103de</c>
/// turns every <see cref="AcceptedCases"/> row red and leaves every
/// <see cref="ControlCases"/> and <see cref="RejectedCases"/> row green.</para>
/// </remarks>
public class Issue4033MemberOnAnElementFromKeysOrValuesTests
{
    /// <summary>How long a compiled case may run before it counts as hung.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The C# library the imported-value rows link against. Compiled with
    /// nullable annotations ENABLED so the two dictionary-returning factories
    /// differ only in whether their value is annotated — that pair is what
    /// proves the fix reads the receiver's argument rather than simply
    /// stripping every <c>?</c>.
    /// </summary>
    private const string LibrarySource = """
        using System.Collections.Generic;

        namespace HelperLib;

        public class Box
        {
            public string Label { get; set; } = "box";
        }

        public static class Factory
        {
            public static Dictionary<string, string> NonNullValues()
                => new() { ["a"] = "hello" };

            public static Dictionary<string, string?> NullableValues()
                => new() { ["a"] = "hello" };

            public static Dictionary<string, Box> BoxValues()
                => new() { ["a"] = new Box() };
        }
        """;

    /// <summary>
    /// Every row reports <c>GS0158</c> or <c>GS9998</c> on <c>3e5103de</c>.
    /// Each moves a real value through the member reached on the loop element
    /// and prints it, so a binding that resolves to the wrong thing prints the
    /// wrong answer rather than merely compiling.
    /// </summary>
    /// <returns>Name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> AcceptedCases()
    {
        // The issue's own repro, `Dictionary` spelling: a constructed-generic
        // value reached through `.Values`. GS9998 on 3e5103de.
        yield return new object[]
        {
            "dictionary-values-element-constructed-generic",
            """
            package Demo
            import System
            import System.Collections.Generic

            func main2() {
                var g = Dictionary[string, List[int32]]()
                g["b"] = List[int32]()
                g["b"].Add(5)
                g["b"].Add(6)
                for lists in g.Values {
                    Console.WriteLine(lists.Count.ToString())
                }
            }

            main2()
            """,
            new[] { "2" },
        };

        // The same repro, `map` spelling. ADR-0104 says these are one type, and
        // the issue's central fact is that both failed identically. GS9998 on
        // 3e5103de, and still GS9998 after the Dictionary half of the fix
        // alone — this row is what forced TryGetClosedMapProjectionView.
        yield return new object[]
        {
            "map-values-element-constructed-generic",
            """
            package Demo
            import System
            import System.Collections.Generic

            func main2() {
                var g = map[string, List[int32]]{}
                g["b"] = List[int32]()
                g["b"].Add(5)
                g["b"].Add(6)
                for lists in g.Values {
                    Console.WriteLine(lists.Count.ToString())
                }
            }

            main2()
            """,
            new[] { "2" },
        };

        // The issue's diagnosis said a constructed generic was the failing
        // ingredient. A plain `string` value fails identically (GS0158 on
        // 3e5103de) — this row is the correction.
        yield return new object[]
        {
            "dictionary-values-element-is-a-plain-string",
            """
            package Demo
            import System
            import System.Collections.Generic

            func main2() {
                var g = Dictionary[string, string]()
                g["b"] = "hello"
                for v in g.Values {
                    Console.WriteLine(v.Length.ToString())
                    Console.WriteLine(v.ToUpper())
                }
            }

            main2()
            """,
            new[] { "5", "HELLO" },
        };

        // The map spelling of the same correction. GS0158 on 3e5103de.
        yield return new object[]
        {
            "map-keys-element-is-a-plain-string",
            """
            package Demo
            import System

            func main2() {
                var m = map[string, string]{"bb": "hello"}
                for k in m.Keys {
                    Console.WriteLine(k.Length.ToString())
                }
            }

            main2()
            """,
            new[] { "2" },
        };

        // The issue records `.Keys` as unaffected. Measured, it is affected
        // identically: GS0158 on 3e5103de.
        yield return new object[]
        {
            "dictionary-keys-element-property",
            """
            package Demo
            import System
            import System.Collections.Generic

            func main2() {
                var g = Dictionary[string, int32]()
                g["bb"] = 5
                for k in g.Keys {
                    Console.WriteLine(k.Length.ToString())
                }
            }

            main2()
            """,
            new[] { "2" },
        };

        // The issue records a generic KEY as "not probed". Measured, GS9998 on
        // 3e5103de — the `.Keys` twin of the reported `.Values` row.
        yield return new object[]
        {
            "dictionary-keys-element-constructed-generic",
            """
            package Demo
            import System
            import System.Collections.Generic

            func main2() {
                var g = Dictionary[List[int32], string]()
                var kk = List[int32]()
                kk.Add(7)
                kk.Add(8)
                kk.Add(9)
                g[kk] = "v"
                for k in g.Keys {
                    Console.WriteLine(k.Count.ToString())
                }
            }

            main2()
            """,
            new[] { "3" },
        };

        // Not only `Dictionary`: every nested KeyCollection/ValueCollection was
        // affected. GS0158 on 3e5103de.
        yield return new object[]
        {
            "sorted-dictionary-values-element-property",
            """
            package Demo
            import System
            import System.Collections.Generic

            func main2() {
                var g = SortedDictionary[string, string]()
                g["a"] = "hello"
                for v in g.Values {
                    Console.WriteLine(v.Length.ToString())
                }
            }

            main2()
            """,
            new[] { "5" },
        };

        // The element reached through a LOCAL rather than directly in the
        // `for` header — the receiver's node kind was the whole gate, so this
        // is the row that shows the defect is about the TYPE, not the syntax.
        // GS9998 on 3e5103de.
        yield return new object[]
        {
            "values-collection-through-a-local-then-iterated",
            """
            package Demo
            import System
            import System.Collections.Generic

            func main2() {
                var g = Dictionary[string, List[int32]]()
                g["b"] = List[int32]()
                g["b"].Add(5)
                var vs = g.Values
                for x in vs {
                    Console.WriteLine(x.Count.ToString())
                }
            }

            main2()
            """,
            new[] { "1" },
        };

        // An IMPORTED class as the value, reached through `.Values`, with its
        // own property read in the body. This is the shape the issue calls
        // green; it is not. GS0158 on 3e5103de.
        yield return new object[]
        {
            "values-element-is-an-imported-class-property-read",
            """
            package Demo
            import System
            import HelperLib

            func main2() {
                var g = Factory.BoxValues()
                for b in g.Values {
                    Console.WriteLine(b.Label)
                }
            }

            main2()
            """,
            new[] { "box" },
        };

        // A dictionary handed over from a nullable-ENABLED C# assembly whose
        // value IS annotated `string?`, read through all THREE paths at once.
        // GS0158 on 3e5103de, on the `.Values` path only.
        //
        // Read this row carefully, because it is the one that could be
        // mistaken for a regression. Measured on 3e5103de, the indexer and
        // `for k, v` ALREADY said `string` here — the receiver's annotation is
        // dropped by `GetProjectionReceiverImportedType`, which unwraps a
        // `NullabilityAnnotatedTypeSymbol` to its bare base — while `.Values`
        // said `string?` for this annotated dictionary AND for the
        // non-annotated `NonNullValues()` alike, because it was reading the
        // declaration's placeholder rather than the annotation. Its apparent
        // correctness here was a coincidence, not a faithful reading. So this
        // row pins the AGREEMENT the fix establishes across the three paths,
        // NOT a claim that the `?` survives: recovering a genuinely-annotated
        // imported value's `string?` on any of them is a separate,
        // pre-existing gap, measured and filed, and untouched here.
        yield return new object[]
        {
            "an-imported-nullable-value-dictionary-agrees-across-its-three-paths",
            """
            package Demo
            import System
            import HelperLib

            func main2() {
                var g = Factory.NullableValues()
                Console.WriteLine(g["a"].Length.ToString())
                for k, v in g {
                    Console.WriteLine(v.Length.ToString())
                }

                for v in g.Values {
                    Console.WriteLine(v.Length.ToString())
                }
            }

            main2()
            """,
            new[] { "5", "5", "5" },
        };

        // A dictionary handed over from a nullable-ENABLED C# assembly whose
        // value is NOT annotated. The element must be `string`, so the property
        // reads. GS0158 on 3e5103de.
        yield return new object[]
        {
            "values-element-from-an-imported-non-nullable-value-dictionary",
            """
            package Demo
            import System
            import HelperLib

            func main2() {
                var g = Factory.NonNullValues()
                for v in g.Values {
                    Console.WriteLine(v.Length.ToString())
                }
            }

            main2()
            """,
            new[] { "5" },
        };
    }

    /// <summary>
    /// Shapes that already worked and must keep working — including the
    /// non-nested generic collections that were never affected, and the three
    /// other ways of reaching the same dictionary's values, whose agreement
    /// with each other is what identified the bug.
    /// </summary>
    /// <returns>Name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> ControlCases()
    {
        // The three green paths to the SAME dictionary's values. Their
        // agreement (all `string`) against `.Values`' disagreement (`string?`)
        // is the measurement that located the defect.
        yield return new object[]
        {
            "control-indexer-for-k-v-and-trygetvalue-all-agree",
            """
            package Demo
            import System
            import System.Collections.Generic

            func main2() {
                var g = Dictionary[string, string]()
                g["bb"] = "hello"
                Console.WriteLine(g["bb"].Length.ToString())
                for k, v in g {
                    Console.WriteLine(k.Length.ToString() + "/" + v.Length.ToString())
                }

                var got string
                if g.TryGetValue("bb", out got) {
                    Console.WriteLine(got.Length.ToString())
                }
            }

            main2()
            """,
            new[] { "5", "2/5", "5" },
        };

        // A METHOD on the element from `.Values` was always green, because a
        // call never consults the receiver gate. It must stay green.
        yield return new object[]
        {
            "control-a-method-on-the-values-element",
            """
            package Demo
            import System
            import System.Collections.Generic

            func main2() {
                var g = Dictionary[string, List[int32]]()
                g["b"] = List[int32]()
                for x in g.Values {
                    x.Add(7)
                }

                Console.WriteLine(g["b"].Count.ToString())
            }

            main2()
            """,
            new[] { "1" },
        };

        // Non-nested generic collections were never affected: their element
        // carries no placeholder byte. Four of them, so an over-broad change to
        // the projection would be visible here.
        yield return new object[]
        {
            "control-non-nested-generic-collections-are-unaffected",
            """
            package Demo
            import System
            import System.Collections.Generic

            func main2() {
                var l = List[string]()
                l.Add("hello")
                for x in l {
                    Console.WriteLine(x.Length.ToString())
                }

                var h = HashSet[string]()
                h.Add("worlds")
                for x in h {
                    Console.WriteLine(x.Length.ToString())
                }

                var q = Queue[string]()
                q.Enqueue("sevens")
                for x in q {
                    Console.WriteLine(x.Length.ToString())
                }

                var s = Stack[string]()
                s.Push("eight")
                for x in s {
                    Console.WriteLine(x.Length.ToString())
                }
            }

            main2()
            """,
            new[] { "5", "6", "6", "5" },
        };

        // A constructed-generic element from a plain enumerable was always
        // green — the ingredient the issue blamed, in isolation, is innocent.
        yield return new object[]
        {
            "control-constructed-generic-element-from-a-plain-list",
            """
            package Demo
            import System
            import System.Collections.Generic

            func main2() {
                var outer = List[List[int32]]()
                var inner = List[int32]()
                inner.Add(5)
                outer.Add(inner)
                for x in outer {
                    Console.WriteLine(x.Count.ToString())
                }
            }

            main2()
            """,
            new[] { "1" },
        };

        // Issue #3311: an OPEN `map[K, V]`'s `.Keys` must keep iterating as
        // `K`, never `K?`. This is the spelling that was RIGHT all along, via
        // the very carve-out the fix now lets closed receivers reach, so it
        // pins that the fix did not disturb it.
        yield return new object[]
        {
            "control-an-open-map-keys-iterates-as-k",
            """
            package Demo
            import System

            func firstKey[K, V](m map[K, V], fallback K) K {
                for k in m.Keys {
                    return k
                }

                return fallback
            }

            func main2() {
                var m = map[string, int32]{"only": 1}
                Console.WriteLine(firstKey[string, int32](m, "none"))
            }

            main2()
            """,
            new[] { "only" },
        };
    }

    /// <summary>
    /// The shapes that must still be refused, so the fix neither invents
    /// members nor weakens G#'s rule that reading a property off an EXPLICIT
    /// <c>T?</c> requires narrowing or <c>?.</c> first.
    /// </summary>
    /// <returns>Name, G# source, the expected diagnostic id, and how many times it must appear.</returns>
    public static IEnumerable<object[]> RejectedCases()
    {
        // ADR-0001: an explicitly-written `string?` still requires narrowing or
        // `?.` before a property read. The fix must NOT relax this — it changes
        // which element type `.Values` produces, not what may be done to a `T?`.
        yield return new object[]
        {
            "an-explicit-nullable-reference-still-refuses-a-property-read",
            """
            package Demo
            import System

            func main2() {
                var s string? = "hello"
                Console.WriteLine(s.Length.ToString())
            }

            main2()
            """,
            "GS0158",
            1,
        };

        // The same rule at an explicitly-nullable ELEMENT type. `[]string?` is
        // the author saying the elements may be nil, so the loop variable is
        // genuinely `string?` and the property read is genuinely refused —
        // unlike `.Values`, where the `?` was fabricated from a placeholder.
        yield return new object[]
        {
            "an-explicitly-nullable-slice-element-still-refuses-a-property-read",
            """
            package Demo
            import System

            func main2() {
                var s = []string?{"hello"}
                for v in s {
                    Console.WriteLine(v.Length.ToString())
                }
            }

            main2()
            """,
            "GS0158",
            1,
        };

        // The fix does not invent members the element does not have.
        yield return new object[]
        {
            "a-member-the-values-element-does-not-have-is-still-refused",
            """
            package Demo
            import System
            import System.Collections.Generic

            func main2() {
                var g = Dictionary[string, List[int32]]()
                for x in g.Values {
                    Console.WriteLine(x.NoSuchMember.ToString())
                }
            }

            main2()
            """,
            "GS0158",
            1,
        };
    }

    /// <summary>
    /// A member on an element from <c>.Keys</c>/<c>.Values</c> binds, and the
    /// program compiles, IL-verifies, runs, and prints what it claims.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(AcceptedCases))]
    public void AMemberOnAnElementFromKeysOrValues_Binds(string name, string source, string[] expectedLines)
    {
        RunCase("gs_4033_", name, source, expectedLines);
    }

    /// <summary>
    /// The rows that already worked keep working.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(ControlCases))]
    public void AShapeThatAlreadyWorked_StillWorks(string name, string source, string[] expectedLines)
    {
        RunCase("gs_4033_control_", name, source, expectedLines);
    }

    /// <summary>
    /// The fix neither invents members nor weakens the explicit-nullable rule.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedId">The diagnostic id the compile must report.</param>
    /// <param name="expectedCount">How many times that id must appear.</param>
    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void AShapeThatIsGenuinelyNullableOrMissing_IsStillRefused(
        string name,
        string source,
        string expectedId,
        int expectedCount)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4033_neg_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.Equal(expectedCount, CountDiagnostic(appLog, expectedId));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static int CountDiagnostic(string log, string id)
    {
        var count = 0;
        var needle = "error " + id;
        var index = log.IndexOf(needle, StringComparison.Ordinal);
        while (index >= 0)
        {
            count++;
            index = log.IndexOf(needle, index + needle.Length, StringComparison.Ordinal);
        }

        return count;
    }

    private static void RunCase(string prefix, string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory(prefix).FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);
            Assert.True(File.Exists(appPath), $"'{name}' must compile:\n{appLog}");

            IlVerifier.Verify(appPath, new[] { libPath });

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"'{name}' must run to completion. Exit {exit}:\n{output}");
            Assert.Equal(expectedLines, SplitLines(output));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static string[] SplitLines(string output) => output
        .Split('\n')
        .Select(line => line.TrimEnd('\r'))
        .Where(line => line.Length > 0)
        .ToArray();

    private static string CompileCSharpLibrary(string tempDir)
    {
        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "HelperLib",
            new[] { CSharpSyntaxTree.ParseText(LibrarySource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));

        var libPath = Path.Combine(tempDir, "HelperLib.dll");
        var result = compilation.Emit(libPath);
        Assert.True(
            result.Success,
            "the C# library must compile:\n"
                + string.Join("\n", result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));

        return libPath;
    }

    private static string Compile(string dir, string fileName, string source, string outPath, params string[] extra)
    {
        var srcPath = Path.Combine(dir, fileName);
        File.WriteAllText(srcPath, source);
        var args = new List<string> { "/out:" + outPath, "/targetframework:net10.0" };
        args.AddRange(extra);
        foreach (var reference in TrustedPlatformAssemblies())
        {
            args.Add("/reference:" + reference);
        }

        args.Add(srcPath);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        try
        {
            Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        return compileOut.ToString() + compileErr;
    }

    private static (int Exit, string Output) RunDotnet(string assemblyPath)
    {
        var psi = new ProcessStartInfo("dotnet", $"\"{assemblyPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? ".",
        };

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("could not start dotnet");

        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(RunTimeout))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // The process exited between the timeout and the kill.
            }

            return (-1, $"timed out after {RunTimeout / 1000}s.");
        }

        var output = new StringBuilder();
        output.Append(stdout.GetAwaiter().GetResult());
        output.Append(stderr.GetAwaiter().GetResult());
        return (process.ExitCode, output.ToString());
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            return Enumerable.Empty<string>();
        }

        return tpa.Split(Path.PathSeparator).Where(File.Exists);
    }
}
