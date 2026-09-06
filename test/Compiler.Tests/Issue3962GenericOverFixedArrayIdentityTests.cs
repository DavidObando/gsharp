// <copyright file="Issue3962GenericOverFixedArrayIdentityTests.cs" company="GSharp">
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
/// Issue #3962: a constructed generic over a fixed-length-array type argument
/// lost the length, so <c>List[[3]int32]</c> and <c>List[[4]int32]</c> were the
/// SAME type and converted to one another silently.
/// </summary>
/// <remarks>
/// <para><b>Where it actually was.</b> Not in <c>Conversion</c>. By the time any
/// conversion ran there were no two symbols left to compare: the type-clause
/// binder (<c>Binder.ProjectGenericArgument</c>) and the construction binder
/// (<c>ExpressionBinder.TryResolveClrConstructionTypeArgs</c>) retain a
/// SYMBOLIC type argument only when the argument's CLR type is ABSENT (an
/// in-scope type parameter, a same-compilation user type) or a projection (a
/// named tuple). A fixed array HAS a closed CLR type — but <c>[N]T</c>,
/// <c>[]T</c> and every other length are all backed by the one SZ-array
/// <c>T[]</c>, so both spellings resolved to the single cached
/// <c>ImportedTypeSymbol</c> for <c>List&lt;System.Int32[]&gt;</c> and the
/// length was gone before classification began.</para>
/// <para><b>Not IL-unsoundness.</b> <c>List&lt;int32[]&gt;</c> is one CLR type;
/// the pre-fix program IL-verified and ran. This is a type-IDENTITY precision
/// bug — two types the author spelled differently bound to one symbol — which
/// is why every accepting case below also runs and asserts its own stdout
/// rather than merely verifying.</para>
/// <para><b>The line the fix must not cross.</b> An array recovered from
/// METADATA arrives as <c>ImportedTypeSymbol(T[])</c> and its length is gone
/// beyond recovery — reflection never recorded one. Rejecting such a pair would
/// break ordinary interop (a G# <c>List[[3]int32]</c> handed to a C#
/// <c>List&lt;int[]&gt;</c> parameter is the same CLR type), so the comparison
/// stays lenient exactly there. That is the same line #3924's
/// <c>IsMetadataRecoveredElement</c> draws, and the <c>interop-*</c> cases pin
/// it.</para>
/// <para><b>Known residue, deliberately out of scope (#3998).</b>
/// <c>List[[]int32]</c> to <c>List[[3]int32]</c> is still accepted: a SLICE
/// argument is erased by the same binder mechanism, and retaining it
/// symbolically would touch every <c>List[[]T]</c> in the corpus. It matches
/// the pre-existing top-level behaviour, where <c>[]int32</c> to
/// <c>[3]int32</c> (and <c>[3]int32</c> to <c>[4]int32</c>) are likewise
/// accepted — a separate gap filed as #3998. The <c>bare-*</c> cases pin that
/// unchanged behaviour so this PR's blast radius is visible.</para>
/// </remarks>
public class Issue3962GenericOverFixedArrayIdentityTests
{
    /// <summary>How long a compiled case may run before it counts as hung.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The C# library the interop cases link against. Nullable annotations are
    /// ENABLED so imported returns are not spuriously nullable.
    /// </summary>
    private const string LibrarySource = """
        using System.Collections.Generic;

        namespace Interop;

        public static class ArrayProbes
        {
            // A genuine `List<int[]>` parameter: the CLR type a G#
            // `List[[3]int32]` really has.
            public static int CountArrays(List<int[]> items) => items.Count;

            // A genuine `List<int[]>` return: metadata records no length at
            // all, so the comparison against `List[[3]int32]` must stay
            // lenient rather than reject on information nobody has.
            public static List<int[]> MakeArrays() => new List<int[]> { new[] { 10, 20, 30 } };

            // The NESTED shape: a plain CLR-backed constructed generic whose
            // symbolic type-argument vector is empty at every level.
            public static int CountNested(List<List<int[]>> items) => items.Count;

            public static List<List<int[]>> MakeNested() =>
                new List<List<int[]>> { new List<int[]> { new[] { 10, 20, 30 } } };
        }
        """;

    /// <summary>
    /// Cases that must COMPILE, IL-VERIFY, RUN, and print what they claim. A
    /// fix that only stops accepting things would pass the rejection theory
    /// and fail every one of these.
    /// </summary>
    /// <returns>Name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> AcceptedCases()
    {
        // The instantiation the issue's repro builds, used for real: added to,
        // indexed, iterated, and passed through LINQ. Every one of those goes
        // out to reflection and back, which is exactly where a symbolic type
        // argument can be dropped again.
        yield return new object[]
        {
            "same-length-generic-round-trips-through-members",
            """
            package P
            import System
            import System.Collections.Generic
            import System.Linq

            func main2() {
                var l3 = List[[3]int32]()
                l3.Add([3]int32{1, 2, 3})
                l3.Add([3]int32{4, 5, 6})
                Console.WriteLine(l3.Count.ToString())
                Console.WriteLine(l3[1][2].ToString())
                for item in l3 {
                    Console.WriteLine(item.Length.ToString())
                }

                Console.WriteLine(l3.First()[0].ToString())

                var alias List[[3]int32] = l3
                Console.WriteLine(alias.Count.ToString())
            }

            main2()
            """,
            new[] { "2", "6", "3", "3", "1", "2" },
        };

        // The same length written twice must still be ONE type: the fix
        // escalates to a symbolic comparison, and that comparison has to
        // AGREE, not merely differ.
        yield return new object[]
        {
            "matching-lengths-are-still-identity-across-declarations",
            """
            package P
            import System
            import System.Collections.Generic

            func takes(l List[[3]int32]) int32 {
                return l[0][1]
            }

            func makes() List[[3]int32] {
                var made = List[[3]int32]()
                made.Add([3]int32{7, 8, 9})
                return made
            }

            func main2() {
                var l List[[3]int32] = makes()
                Console.WriteLine(takes(l).ToString())

                var d = Dictionary[string, [3]int32]()
                d["k"] = [3]int32{4, 5, 6}
                var same Dictionary[string, [3]int32] = d
                Console.WriteLine(same["k"][2].ToString())
            }

            main2()
            """,
            new[] { "8", "6" },
        };

        // A covariant interface over the SAME length still widens. The fix
        // must reject invariant length MISMATCH, not the upcast.
        yield return new object[]
        {
            "covariant-upcast-over-the-same-length-still-widens",
            """
            package P
            import System
            import System.Collections.Generic
            import System.Linq

            func counts(items IEnumerable[[3]int32]) int32 {
                return Enumerable.Count(items)
            }

            func main2() {
                var l3 = List[[3]int32]()
                l3.Add([3]int32{1, 2, 3})
                var widened IEnumerable[[3]int32] = l3
                Console.WriteLine(counts(widened).ToString())
                Console.WriteLine(counts(l3).ToString())
            }

            main2()
            """,
            new[] { "1", "1" },
        };

        // A nested constructed generic over a matching length is one type too.
        yield return new object[]
        {
            "nested-generic-over-the-same-length-is-one-type",
            """
            package P
            import System
            import System.Collections.Generic

            func main2() {
                var outer = List[List[[3]int32]]()
                var inner = List[[3]int32]()
                inner.Add([3]int32{1, 2, 3})
                outer.Add(inner)

                var alias List[List[[3]int32]] = outer
                Console.WriteLine(alias[0][0][1].ToString())
            }

            main2()
            """,
            new[] { "2" },
        };

        // A STATIC generic receiver over a matching length: the third
        // retention site (`TryCloseImportedGenericTypeReceiver`) has to build
        // the symbolic view and still produce verifiable IL parented at the
        // constructed TypeSpec.
        yield return new object[]
        {
            "static-generic-receiver-over-a-matching-length-runs",
            """
            package P
            import System
            import System.Collections.Generic

            func main2() {
                var c EqualityComparer[[3]int32] = EqualityComparer[[3]int32].Default
                var a = [3]int32{1, 2, 3}
                Console.WriteLine(c.Equals(a, a).ToString())
                Console.WriteLine(EqualityComparer[[3]int32].Default.Equals(a, a).ToString())
            }

            main2()
            """,
            new[] { "True", "True" },
        };

        // A nullable REFERENCE element inside the fixed array. Retaining the
        // symbolic argument bypasses the #1354 branch that attaches the DFS
        // nullable-flags array (it only runs when NO symbolic argument is
        // kept), so the inner `?` now has to survive through
        // `NullableFlagsBuilder` on the `GetConstructed` path instead.
        yield return new object[]
        {
            "nullable-reference-element-inside-a-fixed-array",
            """
            package P
            import System
            import System.Collections.Generic

            func makes() List[[3]string?] {
                var l = List[[3]string?]()
                l.Add([3]string?{"a", nil, "c"})
                return l
            }

            func main2() {
                var l = makes()
                Console.WriteLine(l.Count.ToString())
                Console.WriteLine(l[0][0]!!)
            }

            main2()
            """,
            new[] { "1", "a" },
        };

        // A same-compilation element inside the fixed array: the argument now
        // carries BOTH reasons to stay symbolic, and the two must compose.
        // (`List[[3]Foo].Add` is a separate, PRE-EXISTING member-projection gap
        // — red on `main` too — filed as #3998, so this case moves the value
        // through the outer list instead.)
        yield return new object[]
        {
            "same-compilation-element-inside-a-matching-fixed-array",
            """
            package P
            import System
            import System.Collections.Generic

            struct Foo {
                var X int32
            }

            func takes(l List[[3]Foo]) int32 {
                return l.Count
            }

            func main2() {
                var l = List[[3]Foo]()
                var alias List[[3]Foo] = l
                Console.WriteLine(takes(alias).ToString())

                var arr = [3]Foo{Foo{X: 1}, Foo{X: 2}, Foo{X: 3}}
                Console.WriteLine(arr[2].X.ToString())
            }

            main2()
            """,
            new[] { "0", "3" },
        };
    }

    /// <summary>
    /// Interop cases: the metadata-recovery line the fix must NOT cross. Both
    /// were green before the fix and must stay green — an array that came back
    /// through reflection carries no length, so a comparison against
    /// <c>[3]int32</c> stays lenient instead of rejecting on information
    /// neither side has.
    /// </summary>
    /// <returns>Name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> InteropCases()
    {
        yield return new object[]
        {
            "interop-fixed-array-generic-reaches-a-clr-list-of-arrays",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            func main2() {
                var l3 = List[[3]int32]()
                l3.Add([3]int32{1, 2, 3})
                Console.WriteLine(ArrayProbes.CountArrays(l3).ToString())

                var back List[[3]int32] = ArrayProbes.MakeArrays()
                Console.WriteLine(back[0][1].ToString())
            }

            main2()
            """,
            new[] { "1", "20" },
        };

        // Review finding 4 predicted this would break: a NESTED
        // metadata-recovered array (`List<List<int[]>>`) reached through a
        // plain CLR-backed constructed generic, whose symbolic type-argument
        // vector is empty. Measured green before and after — pinned so the
        // carve-out's reach is covered rather than argued about.
        yield return new object[]
        {
            "interop-nested-metadata-arrays-convert-both-ways",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            func main2() {
                var nested = List[List[[3]int32]]()
                Console.WriteLine(ArrayProbes.CountNested(nested).ToString())

                var back List[List[[3]int32]] = ArrayProbes.MakeNested()
                Console.WriteLine(back[0][0][1].ToString())
            }

            main2()
            """,
            new[] { "0", "20" },
        };
    }

    /// <summary>
    /// Cases that must be REJECTED. Each was accepted before the fix — that is
    /// the point of the change — and none may reach the emitter (GS9998).
    /// </summary>
    /// <returns>Name, G# source, a substring the diagnostics must name.</returns>
    public static IEnumerable<object[]> RejectedCases()
    {
        // The issue's headline row.
        yield return new object[]
        {
            "different-lengths-do-not-convert",
            """
            package P
            import System.Collections.Generic

            var l3 = List[[3]int32]()
            var l4 List[[4]int32] = l3
            """,
            "'System.Collections.Generic.List[[3]int32]' to 'System.Collections.Generic.List[[4]int32]'",
        };

        // The same conflation in a two-argument generic, on the second
        // position, so a fix that only inspects argument 0 stays red.
        yield return new object[]
        {
            "different-lengths-do-not-convert-in-a-map-value-position",
            """
            package P
            import System.Collections.Generic

            var d3 = Dictionary[string, [3]int32]()
            var d4 Dictionary[string, [4]int32] = d3
            """,
            "'System.Collections.Generic.Dictionary[string, [3]int32]' to 'System.Collections.Generic.Dictionary[string, [4]int32]'",
        };

        // The same conflation in ARGUMENT position, which is a different
        // classification entry point (GS0154, not GS0155).
        yield return new object[]
        {
            "different-lengths-do-not-satisfy-a-parameter",
            """
            package P
            import System.Collections.Generic

            func wants(l List[[4]int32]) {
            }

            var l3 = List[[3]int32]()
            wants(l3)
            """,
            "requires a value of type 'System.Collections.Generic.List[[4]int32]'",
        };

        // Declared-type form: neither side goes through the construction
        // binder, so this pins the type-clause binder independently.
        yield return new object[]
        {
            "different-lengths-do-not-convert-between-declared-types",
            """
            package P
            import System.Collections.Generic

            func wants(l List[[4]int32]) int32 {
                return l.Count
            }

            func pass(l List[[3]int32]) int32 {
                return wants(l)
            }

            System.Console.WriteLine(pass(List[[3]int32]()).ToString())
            """,
            "requires a value of type 'System.Collections.Generic.List[[4]int32]'",
        };

        // Nested one level down: the length must be found at any depth.
        yield return new object[]
        {
            "different-lengths-nested-inside-a-generic-argument",
            """
            package P
            import System.Collections.Generic

            func wants(l List[List[[4]int32]]) {
            }

            var outer = List[List[[3]int32]]()
            wants(outer)
            """,
            "requires a value of type 'System.Collections.Generic.List[System.Collections.Generic.List[[4]int32]]'",
        };

        // Behind a slice wrapper, so the recursion through GetWrappedTypes is
        // load-bearing rather than incidental.
        yield return new object[]
        {
            "different-lengths-behind-a-slice-wrapper",
            """
            package P
            import System.Collections.Generic

            func wants(l List[[][4]int32]) {
            }

            var outer = List[[][3]int32]()
            wants(outer)
            """,
            "requires a value of type 'System.Collections.Generic.List[[][4]int32]'",
        };

        // The FULLY-QUALIFIED construction spelling resolves its type arguments
        // in a third place (`ExpressionBinder.Access`), which had its own copy
        // of the retention rule. Without that site fixed, this row still
        // compiles while every row above is rejected.
        yield return new object[]
        {
            "different-lengths-through-the-qualified-construction-spelling",
            """
            package P
            import System.Collections.Generic

            var l3 = System.Collections.Generic.List[[3]int32]()
            var l4 List[[4]int32] = l3
            """,
            "'System.Collections.Generic.List[[3]int32]' to 'System.Collections.Generic.List[[4]int32]'",
        };

        // Review finding 2. Generic VARIANCE must not readmit a mismatch the
        // identity comparison rejected: `IEnumerable[T]` is covariant, and the
        // bare `[3]int32` -> `[4]int32` conversion is implicit (#3998), so the
        // covariant slot accepted the pair until the shape mismatch was
        // rejected before variance was applied.
        yield return new object[]
        {
            "covariance-does-not-readmit-a-length-mismatch",
            """
            package P
            import System.Collections.Generic

            var l3 = List[[3]int32]()
            var e3 IEnumerable[[3]int32] = l3
            var e4 IEnumerable[[4]int32] = e3
            """,
            "'System.Collections.Generic.IEnumerable[[3]int32]' to 'System.Collections.Generic.IEnumerable[[4]int32]'",
        };

        // The contravariant half of the same rule (`IComparer[in T]`), in the
        // direction contravariance would otherwise allow.
        yield return new object[]
        {
            "contravariance-does-not-readmit-a-length-mismatch",
            """
            package P
            import System
            import System.Collections.Generic

            func wants3(c IComparer[[3]int32]) int32 {
                return 0
            }

            func pass4(c IComparer[[4]int32]) int32 {
                return wants3(c)
            }

            Console.WriteLine(pass4(Comparer[[4]int32].Default).ToString())
            """,
            "requires a value of type 'System.Collections.Generic.IComparer[[3]int32]'",
        };

        // Review finding 3. The STATIC generic receiver is resolved by a
        // fourth code path of its own; without the retention there,
        // `EqualityComparer[[3]int32].Default` is exposed as a metadata-only
        // `EqualityComparer<int32[]>` and flows into the `[4]` slot through the
        // metadata-recovery leniency.
        yield return new object[]
        {
            "static-generic-receiver-discriminates-lengths",
            """
            package P
            import System.Collections.Generic

            var c4 EqualityComparer[[4]int32] = EqualityComparer[[3]int32].Default
            """,
            "'System.Collections.Generic.EqualityComparer[[3]int32]' to 'System.Collections.Generic.EqualityComparer[[4]int32]'",
        };

        // #3924's own control, restated here: a same-compilation element must
        // still discriminate, and this PR must not have traded one erasure for
        // another.
        yield return new object[]
        {
            "same-compilation-elements-are-still-not-conflated",
            """
            package P
            import System.Collections.Generic

            struct Foo {
                var X int32
            }

            struct Bar {
                var Y int32
            }

            func wants(l List[Foo]) {
            }

            var bars = List[Bar]()
            wants(bars)
            """,
            "requires a value of type 'System.Collections.Generic.List[Foo]'",
        };

        // A fixed length INSIDE a same-compilation-element generic: both
        // erasure reasons at once.
        yield return new object[]
        {
            "different-lengths-over-a-same-compilation-element",
            """
            package P
            import System.Collections.Generic

            struct Foo {
                var X int32
            }

            func wants(l List[[4]Foo]) {
            }

            var l3 = List[[3]Foo]()
            wants(l3)
            """,
            "requires a value of type 'System.Collections.Generic.List[[4]Foo]'",
        };
    }

    /// <summary>
    /// Behaviour this PR deliberately does NOT change, pinned so the blast
    /// radius is visible and a later fix for #3998 has to update this file on
    /// purpose. At the TOP level a fixed array's length is not part of
    /// conversion at all on <c>main</c>, and this PR does not touch that.
    /// </summary>
    /// <returns>Name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> UnchangedBareCases()
    {
        yield return new object[]
        {
            "bare-fixed-array-lengths-still-interconvert",
            """
            package P
            import System

            func takes4(a [4]int32) int32 {
                return a[0]
            }

            func main2() {
                var a3 [3]int32 = [3]int32{1, 2, 3}
                var a4 [4]int32 = a3
                Console.WriteLine(a4.Length.ToString())
                Console.WriteLine(takes4(a3).ToString())

                var s []int32 = a3
                Console.WriteLine(s.Length.ToString())
            }

            main2()
            """,
            new[] { "3", "1", "3" },
        };

        // Review finding 1: `xs.Add([4]int32{...})` on a `List[[3]int32]` is
        // still accepted. That is NOT member-projection erasure — it is the
        // #3998 bare rule, and the `take3` line proves it: a G#-declared
        // `[3]int32` parameter, which owes nothing to reflection, accepts a
        // `[4]int32` argument too. A fully substituted `Add([3]int32)` would
        // therefore accept the same call. Pinned so that fixing #3998 has to
        // revisit both lines together.
        yield return new object[]
        {
            "member-argument-length-follows-the-bare-conversion-rule",
            """
            package P
            import System
            import System.Collections.Generic

            func take3(a [3]int32) int32 {
                return a[0]
            }

            func main2() {
                Console.WriteLine(take3([4]int32{1, 2, 3, 4}).ToString())

                var xs = List[[3]int32]()
                xs.Add([4]int32{5, 6, 7, 8})
                Console.WriteLine(xs.Count.ToString())
            }

            main2()
            """,
            new[] { "1", "1" },
        };

        yield return new object[]
        {
            "slice-argument-still-reaches-a-fixed-array-generic",
            """
            package P
            import System
            import System.Collections.Generic

            func main2() {
                var slice = List[[]int32]()
                slice.Add([]int32{1, 2, 3})
                var fixed3 List[[3]int32] = slice
                Console.WriteLine(fixed3.Count.ToString())
            }

            main2()
            """,
            new[] { "1" },
        };
    }

    /// <summary>
    /// Every accepting case compiles, IL-verifies, runs, and prints what it
    /// claims.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(AcceptedCases))]
    [MemberData(nameof(UnchangedBareCases))]
    public void AFixedArrayGeneric_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3962_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");
            Assert.True(File.Exists(appPath), $"'{name}' must compile:\n{appLog}");

            IlVerifier.Verify(appPath);

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"'{name}' must run to completion. Exit {exit}:\n{output}");
            Assert.Equal(expectedLines, SplitLines(output));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The metadata-recovery line: an imported <c>List&lt;int[]&gt;</c> carries
    /// no length, so it keeps converting both ways.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(InteropCases))]
    public void AMetadataRecoveredArray_StaysLenient(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3962_interop_").FullName;
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

    /// <summary>
    /// Two instantiations that differ only in a fixed length are two types, and
    /// neither reaches the emitter.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedMention">A substring the diagnostics must name.</param>
    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void ADifferentFixedLength_IsADifferentType(string name, string source, string expectedMention)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3962_neg_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.Contains(expectedMention, appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
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
            "Interop",
            new[] { CSharpSyntaxTree.ParseText(LibrarySource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));

        var libPath = Path.Combine(tempDir, "Interop.dll");
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
