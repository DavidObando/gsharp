// <copyright file="Issue3984BaseInitializerOpenArgumentTests.cs" company="GSharp">
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
/// Issue #3984: a <c>: base(...)</c> initializer argument whose type
/// structurally carries an open type parameter reported GS0214 having ranked
/// nothing, and the diagnostic's arity claim was false.
/// </summary>
/// <remarks>
/// <para><c>ExpressionBinder</c>'s probes for imported constructors and methods
/// project an argument with no <c>ClrType</c> of its own — <c>[]T</c>,
/// <c>map[K, V]</c>, <c>chan[T]</c>, a symbolic tuple — through
/// <c>GetEffectiveArgumentClrTypeForOverloadResolution</c>, so resolution can
/// rank candidates on erased shapes. <c>Binder</c> handed
/// <c>DeclarationBinder</c> the NON-overload-resolution variant, whose null
/// answer set <c>argsAllTyped = false</c> and skipped resolution entirely — so
/// <c>class MyList[T] : List[T] { init(items []T) : base(items) }</c> was
/// "Class 'List`1' has no accessible constructor that takes 1 argument(s)"
/// against a base that declares exactly such a constructor.</para>
/// <para>Handing over the overload-resolution variant is only half of it, and
/// the second half is a defect of its own. The candidate then ranks, and the
/// per-parameter loop that follows converted the argument to the ERASED
/// parameter type — <c>List[T]</c>'s CLR shape is <c>List&lt;object&gt;</c>, so
/// its <c>IEnumerable&lt;!0&gt;</c> parameter reads back as
/// <c>IEnumerable&lt;object&gt;</c>. That is not the signature the emitter
/// writes: the base-constructor MemberRef is parented at the SYMBOLIC TypeSpec
/// and its signature says <c>IEnumerable&lt;!T0&gt;</c>. So the loop targeted a
/// type the call does not have, which failed outright for an argument with no
/// CLR identity (<c>[]T</c>) and — worse — silently SUCCEEDED for one that has
/// (<c>[]string</c>, <c>(int32, object)</c>), leaving ILVerify's
/// StackUnexpected in the emitted constructor. The loop now recovers the
/// symbolic parameter by substituting the base's own type arguments into the
/// OPEN definition's constructor, the same projection an imported instance
/// call's parameters already go through.</para>
/// <para>Every executable case RUNS and asserts the program's own stdout with a
/// value carried through the constructed object, because both candidate
/// constructors on each fixture type accept the same argument count: binding
/// alone cannot tell the <c>IEnumerable&lt;T&gt;</c> constructor from the
/// <c>int</c> capacity one, and picking the wrong one IL-verifies clean.</para>
/// <para>Discrimination (ADR-0154): every behavioural case is GS0214 on the
/// parent <c>src/</c> — including the <c>chan[T]</c> one, with #3986's channel
/// arm already present in the tree, which is what proves this path never called
/// that projection at all. The two controls are green on both sides; of the
/// rejections, three are red on both and two flip from "compiled with invalid
/// IL" to "refused" — so the fix cannot be "make GS0214 stop firing".</para>
/// </remarks>
public class Issue3984BaseInitializerOpenArgumentTests
{
    /// <summary>How long a compiled case may run before it counts as hung.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The C# library every fixture case links against. Each type declares TWO
    /// constructors of the same arity, one taking the structural shape and one
    /// taking plain <c>int</c>s, and records which ran in <c>Tag</c> — so the
    /// asserted stdout discriminates the selection rather than merely proving
    /// that something compiled.
    /// </summary>
    private const string LibrarySource = """
        using System.Collections.Generic;
        using System.Threading.Channels;

        namespace Interop;

        public class SeqHolder<T>
        {
            public SeqHolder(IEnumerable<T> items)
            {
                var n = 0;
                foreach (var _ in items)
                {
                    n++;
                }

                this.Tag = "seq:" + n;
            }

            public SeqHolder(int capacity)
            {
                this.Tag = "int:" + capacity;
            }

            public string Tag { get; }
        }

        public class MapHolder<K, V>
            where K : notnull
        {
            public MapHolder(Dictionary<K, V> entries)
            {
                this.Tag = "map:" + entries.Count;
            }

            public MapHolder(int capacity)
            {
                this.Tag = "int:" + capacity;
            }

            public string Tag { get; }
        }

        public class TupleHolder<T>
        {
            public TupleHolder((int, T) pair)
            {
                this.Tag = "tuple:" + pair.Item1;
            }

            public TupleHolder(int n)
            {
                this.Tag = "int:" + n;
            }

            public string Tag { get; }
        }

        public class OpenRelay<T>
        {
            public OpenRelay(Channel<T> source, int capacity)
            {
                this.Source = source;
                this.Tag = "chan:" + capacity;
            }

            public OpenRelay(int capacity)
            {
                this.Source = Channel.CreateUnbounded<T>();
                this.Tag = "int:" + capacity;
            }

            public Channel<T> Source { get; }

            public string Tag { get; }
        }

        public class OptHolder<T>
        {
            public OptHolder(IEnumerable<T> items, int tag = 0)
            {
                var n = 0;
                foreach (var _ in items)
                {
                    n++;
                }

                this.Tag = "seq:" + n + ":" + tag;
            }

            public OptHolder(int capacity)
            {
                this.Tag = "int:" + capacity;
            }

            public string Tag { get; }
        }

        public class OptionalOnlyBase
        {
            public OptionalOnlyBase(string? tag = null)
            {
                this.Tag = tag ?? "default";
            }

            public string Tag { get; }
        }

        public class FallbackHolder<T>
        {
            public FallbackHolder(IEnumerable<T> items, T fallback = default!)
            {
                var n = 0;
                foreach (var _ in items)
                {
                    n++;
                }

                this.Tag = "seq:" + n + ":" + (fallback == null ? "nil" : fallback.ToString());
            }

            public FallbackHolder(int capacity)
            {
                this.Tag = "int:" + capacity;
            }

            public string Tag { get; }
        }

        public class ParamsHolder<T>
        {
            public ParamsHolder(params T[] items)
            {
                this.Tag = "params:" + items.Length;
            }

            public string Tag { get; }
        }

        public class BigTupleHolder<T>
        {
            public BigTupleHolder((int, int, int, int, int, int, int, T) pair)
            {
                this.Tag = "big:" + pair.Item1 + ":" + pair.Item8;
            }

            public BigTupleHolder(int n)
            {
                this.Tag = "int:" + n;
            }

            public string Tag { get; }
        }

        public class PairHolder<T>
        {
            public PairHolder(IEnumerable<T> items, int n)
            {
                var c = 0;
                foreach (var _ in items)
                {
                    c++;
                }

                this.Tag = "seq:" + c + ":" + n;
            }

            public PairHolder(IEnumerable<T> items, string label)
            {
                var c = 0;
                foreach (var _ in items)
                {
                    c++;
                }

                this.Tag = "label:" + c + ":" + label;
            }

            public PairHolder(int a, int b)
            {
                this.Tag = "int:" + a + ":" + b;
            }

            public string Tag { get; }
        }
        """;

    /// <summary>
    /// Gets the cases that must compile, IL-verify and run: each is (name, G#
    /// source, expected stdout lines).
    /// </summary>
    /// <returns>The case data.</returns>
    public static IEnumerable<object[]> Cases()
    {
        // The issue's own repro, against the BCL rather than the fixture:
        // `List[T]` declares `List(int)` and `List(IEnumerable<T>)`, so the
        // printed Count is what says which one ran — 3 for the enumerable, 0
        // for the capacity.
        yield return new object[]
        {
            "the-issues-repro-a-slice-of-the-open-element-into-a-bcl-base",
            """
            package P
            import System
            import System.Collections.Generic

            class MyList[T] : List[T] {
                init(items []T) : base(items) {
                }
            }

            Console.WriteLine(MyList[int32]([]int32{1, 2, 3}).Count)
            """,
            new[] { "3" },
        };

        // The same shape against a plain C# assembly, which is where it bites
        // an author with no BCL type in sight.
        yield return new object[]
        {
            "a-slice-of-the-open-element",
            """
            package P
            import System
            import Interop

            class Seq[T] : SeqHolder[T] {
                init(items []T) : base(items) {
                }
            }

            Console.WriteLine(Seq[int32]([]int32{1, 2, 3}).Tag)
            """,
            new[] { "seq:3" },
        };

        // `map[K, V]` over two open parameters — the #3303 arm of the erasure
        // projection, reached from `: base(...)` for the first time.
        yield return new object[]
        {
            "a-map-over-an-open-key-and-value",
            """
            package P
            import System
            import Interop

            class Holder[K, V] : MapHolder[K, V] {
                init(entries map[K, V]) : base(entries) {
                }
            }

            Console.WriteLine(Holder[string, int32](map[string, int32]{"a": 1, "b": 2}).Tag)
            """,
            new[] { "map:2" },
        };

        // A tuple with a symbolic element — the #3087 arm.
        yield return new object[]
        {
            "a-tuple-carrying-the-open-element",
            """
            package P
            import System
            import Interop

            class Pairish[T] : TupleHolder[T] {
                init(pair (int32, T)) : base(pair) {
                }
            }

            Console.WriteLine(Pairish[string]((7, "x")).Tag)
            """,
            new[] { "tuple:7" },
        };

        // ADR-0174 D2's `chan[T]` over an open element — the #3876 arm. This
        // row is red on the parent commit even though that arm is already in
        // the tree, because this path never called the projection carrying it.
        yield return new object[]
        {
            "a-channel-over-the-open-element",
            """
            package P
            import System
            import Interop

            class Relay[T] : OpenRelay[T] {
                init(source chan[T]) : base(source, 4) {
                }
            }

            Console.WriteLine(Relay[int32](chan[int32](2)).Tag)
            """,
            new[] { "chan:4" },
        };

        // The SECOND consumer of the same delegate,
        // DeclarationBinder.Constructors.cs's
        // RebindDeferredArgumentsWithCommonClrTargets: a deferred branchy
        // argument (`if …`) beside an erased one. Its erased-argument loop
        // returned early on the null, so the branchy argument was never rebound
        // against the candidate set.
        yield return new object[]
        {
            "a-deferred-branchy-argument-beside-an-erased-one",
            """
            package P
            import System
            import Interop

            class Pair[T] : PairHolder[T] {
                init(items []T, flag bool) : base(items, if flag { 4 } else { 9 }) {
                }
            }

            Console.WriteLine(Pair[int32]([]int32{1, 2, 3}, true).Tag)
            Console.WriteLine(Pair[int32]([]int32{1, 2}, false).Tag)
            """,
            new[] { "seq:3:4", "seq:2:9" },
        };

        // The discriminating form of the same site: `PairHolder[T]` declares
        // BOTH `(IEnumerable<T>, int)` and `(IEnumerable<T>, string)`, so the
        // deferred argument's rebind is what picks the overload — `label:`
        // rather than `seq:` in the output is the proof it ran.
        yield return new object[]
        {
            "a-deferred-branchy-argument-selects-the-string-overload",
            """
            package P
            import System
            import Interop

            class Labelled[T] : PairHolder[T] {
                init(items []T, flag bool) : base(items, if flag { "yes" } else { "no" }) {
                }
            }

            Console.WriteLine(Labelled[int32]([]int32{1, 2, 3}, true).Tag)
            Console.WriteLine(Labelled[int32]([]int32{1, 2}, false).Tag)
            """,
            new[] { "label:3:yes", "label:2:no" },
        };

        // Control 1 from the issue: the same base constructor set reached with
        // a NON-erased argument. Green on both sides — this is what says the
        // bug was never about base initializers or generic bases as such.
        yield return new object[]
        {
            "control-a-non-erased-argument-to-the-same-generic-base",
            """
            package P
            import System
            import Interop

            class Seq[T] : SeqHolder[T] {
                init(capacity int32) : base(capacity) {
                }
            }

            Console.WriteLine(Seq[int32](5).Tag)
            """,
            new[] { "int:5" },
        };

        // Control 2 from the issue: the same base constructor with a CLOSED
        // element. Green on both sides.
        yield return new object[]
        {
            "control-a-closed-element-in-the-same-position",
            """
            package P
            import System
            import Interop

            class Derived : OpenRelay[int32] {
                init(source chan[int32]) : base(source, 4) {
                }
            }

            Console.WriteLine(Derived(chan[int32](2)).Tag)
            """,
            new[] { "chan:4" },
        };

        // Review of this PR, finding 1. Ranking an erased argument reaches, for
        // the first time, a constructor selected with an OMITTED optional
        // parameter — and the per-parameter loop walks the PARAMETERS. Without
        // materialising the omitted default it indexed past the supplied
        // arguments and crashed the compiler outright (GS9998,
        // IndexOutOfRangeException). The printed `:0` is the default arriving.
        yield return new object[]
        {
            "an-omitted-optional-parameter-beside-an-erased-argument",
            """
            package P
            import System
            import Interop

            class Opt[T] : OptHolder[T] {
                init(items []T) : base(items) {
                }
            }

            Console.WriteLine(Opt[int32]([]int32{1, 2, 3}).Tag)
            """,
            new[] { "seq:3:0" },
        };

        // The same omitted optional against a CLOSED base — no erasure anywhere,
        // and `main` crashes on it too (`GS9998: IndexOutOfRangeException`).
        // The crash therefore PREDATES this PR: the conversion loop always
        // walked the parameters while the argument list held only what was
        // supplied. What this PR changed is that an erased argument can now
        // reach that loop as well; the repair covers both, and this row is what
        // says the older half is fixed rather than merely avoided.
        yield return new object[]
        {
            "an-omitted-optional-on-a-closed-base-crashed-on-main-too",
            """
            package P
            import System
            import Interop

            class D : OptHolder[int32] {
                init(items []int32) : base(items) {
                }
            }

            Console.WriteLine(D([]int32{1, 2, 3}).Tag)
            """,
            new[] { "seq:3:0" },
        };

        // Review follow-up: the omitted default is materialised from the
        // parameter's ERASED CLR type, so `T fallback = default` on a `Base[T]`
        // arrived as `default(object)` and met a symbolic `T` slot it could not
        // convert to (GS0156). It is re-materialised at the recovered target,
        // the same recovery #1471 applies to an explicit `default` argument and
        // for the same reason: `default(T)` must reify over the real slot rather
        // than lower to `ldnull`. `T` closes to `int32` here, so the default
        // arriving is `0`.
        yield return new object[]
        {
            "an-omitted-symbolic-default-beside-an-erased-argument",
            """
            package P
            import System
            import Interop

            class Fb[T] : FallbackHolder[T] {
                init(items []T) : base(items) {
                }
            }

            Console.WriteLine(Fb[int32]([]int32{1, 2, 3}).Tag)
            """,
            new[] { "seq:3:0" },
        };

        // Review of this PR, finding 2. The synthesised `params` array is what
        // the emitter pushes, so it has to be built over the SYMBOLIC element:
        // `params T[]` on a `Base[T]` is `!T0[]`. Built over the erased element
        // it boxed into an `object[]` and handed that to a MemberRef whose
        // signature says `T0[]` — this case ran and printed the right string
        // while failing ILVerify, which is why the harness verifies as well as
        // runs.
        yield return new object[]
        {
            "an-expanded-params-array-over-the-open-element",
            """
            package P
            import System
            import Interop

            class Pk[T] : ParamsHolder[T] {
                init(item T) : base(item) {
                }
            }

            Console.WriteLine(Pk[int32](7).Tag)
            """,
            new[] { "params:1" },
        };

        // Review of this PR, finding 3. An argument the author SPELLED as the
        // imported type already satisfies the projected parameter, so the
        // structural canonicalisation must not fire — rewriting the target to
        // `map[K, V]` pushed this valid call into the very classifier gap
        // (#3987) the rewrite exists to route around. Green on `main`, so this
        // is a regression guard, not a new capability.
        yield return new object[]
        {
            "control-an-explicitly-imported-dictionary-spelling",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            class Holder[K, V] : MapHolder[K, V] {
                init(entries Dictionary[K, V]) : base(entries) {
                }
            }

            Console.WriteLine(Holder[string, int32](Dictionary[string, int32]()).Tag)
            """,
            new[] { "map:0" },
        };

        // Review of this PR, finding 4. A tuple of arity 8 or more is
        // `ValueTuple<T1..T7, TRest>`, so the canonicalisation has to flatten
        // the `TRest` chain before it can name the shape — otherwise the long
        // tuples, which need the rewrite most, keep the imported spelling and
        // hit the open-element identity gap.
        yield return new object[]
        {
            "a-tuple-of-arity-eight-carrying-the-open-element",
            """
            package P
            import System
            import Interop

            class Big[T] : BigTupleHolder[T] {
                init(pair (int32, int32, int32, int32, int32, int32, int32, T)) : base(pair) {
                }
            }

            Console.WriteLine(Big[string]((1, 2, 3, 4, 5, 6, 7, "z")).Tag)
            """,
            new[] { "big:1:z" },
        };
    }

    /// <summary>
    /// Gets the base calls that must still be REJECTED: each is (name, G#
    /// source, the diagnostic id the compiler must report).
    /// </summary>
    /// <returns>The case data.</returns>
    public static IEnumerable<object[]> RejectedCases()
    {
        // Wrong arity against a base that really declares nothing of that
        // arity — GS0214's claim is TRUE here, so GS0214 is what it stays.
        yield return new object[]
        {
            "wrong-arity-still-reports-gs0214",
            """
            package P
            import System
            import Interop

            class Seq[T] : SeqHolder[T] {
                init(items []T) : base(items, 1, 2) {
                }
            }

            Console.WriteLine(Seq[int32]([]int32{1}).Tag)
            """,
            "GS0214",
        };

        // Right arity, wrong argument type. Before this fix GS0214 said the
        // base had no two-argument constructor, which was false; now that
        // resolution has actually run, the report names applicability — the
        // same GS0267 the ordinary imported-constructor probe gives.
        yield return new object[]
        {
            "a-wrong-argument-type-now-names-applicability",
            """
            package P
            import System
            import Interop

            class Relay[T] : OpenRelay[T] {
                init(source chan[T]) : base(source, "four") {
                }
            }

            Console.WriteLine(Relay[int32](chan[int32](2)).Tag)
            """,
            "GS0267",
        };

        // The two rows this fix flips from "compiled, with INVALID IL" to
        // "refused". Neither argument has anything erased about it — `[]string`
        // and `(int32, object)` are fully CLR-backed — so both went straight
        // through the old conversion loop, which converted them to the base's
        // ERASED parameter (`IEnumerable[object]`, `ValueTuple[int32, object]`)
        // while the emitted MemberRef's signature reads `IEnumerable<!T0>` /
        // `ValueTuple<int32, !T0>`. ILVerify rejected the emitted constructor
        // with StackUnexpected on both. Targeting the symbolic parameter is
        // what makes them a bind-time error, where they belong.
        yield return new object[]
        {
            "a-clr-typed-slice-does-not-satisfy-a-symbolic-element",
            """
            package P
            import System
            import Interop

            class Seq[T] : SeqHolder[T] {
                init(items []string) : base(items) {
                }
            }

            Console.WriteLine(Seq[int32]([]string{"a", "b"}).Tag)
            """,
            "GS0155",
        };

        yield return new object[]
        {
            "an-erased-tuple-spelling-does-not-satisfy-a-symbolic-element",
            """
            package P
            import System
            import Interop

            class Pairish[T] : TupleHolder[T] {
                init(pair (int32, object)) : base(pair) {
                }
            }

            Console.WriteLine(Pairish[string]((7, "x")).Tag)
            """,
            "GS0155",
        };

        // An erased argument now RANKS, but ranking is not acceptance: a
        // `map[string, T]` erases to a `Dictionary<…>`, which is no
        // `IEnumerable<T>`, so no constructor is applicable and the report
        // names applicability. Being projected is what let it be judged.
        yield return new object[]
        {
            "an-erased-shape-that-does-not-fit-is-still-refused",
            """
            package P
            import System
            import Interop

            class Seq[T] : SeqHolder[T] {
                init(entries map[string, T]) : base(entries) {
                }
            }

            Console.WriteLine(Seq[int32](map[string, int32]{"a": 1}).Tag)
            """,
            "GS0267",
        };
    }

    /// <summary>
    /// Compiles the C# library, compiles a G# consumer against it, IL-verifies
    /// the consumer, runs it, and asserts the program's own output.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(Cases))]
    public void AnOpenBaseInitializerArgument_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3984_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);

            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);
            Assert.True(File.Exists(appPath), $"'{name}' must compile. Log:\n{appLog}");

            IlVerifier.Verify(appPath, new[] { libPath });

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"'{name}' must run to completion. Exit {exit}:\n{output}");

            var lines = output
                .Split('\n')
                .Select(line => line.TrimEnd('\r'))
                .Where(line => line.Length > 0)
                .ToArray();
            Assert.Equal(expectedLines, lines);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    [Fact]
    public void ImplicitBaseCall_MaterializesOmittedOptionalArgument()
    {
        // Issue #3880: derived default/designated ctors referenced a nonexistent
        // base .ctor() instead of calling the real optional-only .ctor(string)
        // with its materialized nil default.
        var tempDir = Directory.CreateTempSubdirectory("gs_3880_base_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            const string source = """
                package P
                import System
                import Interop

                class Derived : OptionalOnlyBase {
                }

                class DerivedWithConstructor : OptionalOnlyBase {
                    init(value int32) {
                    }
                }

                class PrimaryAndExplicit(value int32) : OptionalOnlyBase {
                    init() {
                    }
                }

                open class GPrimaryBase(tag string? = nil) {
                }

                class GPrimaryDerived : GPrimaryBase {
                }

                open class GExplicitBase {
                    prop Tag string

                    init(tag string? = nil) {
                        this.Tag = tag ?? "default"
                    }
                }

                class GExplicitDerived : GExplicitBase {
                }

                Console.WriteLine(Derived().Tag)
                Console.WriteLine(DerivedWithConstructor(1).Tag)
                Console.WriteLine(PrimaryAndExplicit(1).Tag)
                Console.WriteLine(GPrimaryDerived().tag ?? "default")
                Console.WriteLine(GExplicitDerived().Tag)
                """;

            var appPath = Path.Combine(tempDir, "implicit-optional-base.dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);
            Assert.True(File.Exists(appPath), $"The derived class must compile. Log:\n{appLog}");

            IlVerifier.Verify(appPath, new[] { libPath });
            var (exit, output) = RunDotnet(appPath);
            Assert.Equal(0, exit);
            Assert.Equal(
                string.Concat(Enumerable.Repeat($"default{Environment.NewLine}", 5)),
                output);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// A base call that is genuinely inapplicable stays rejected, and says
    /// which of the two things went wrong.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedId">The diagnostic id the log must carry.</param>
    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void AnInapplicableBaseCall_IsRefusedAndNamesTheRealProblem(string name, string source, string expectedId)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3984_neg_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);

            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.Contains(expectedId, appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

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

        // A channel case that picked the wrong constructor can fail by never
        // completing rather than by throwing, so read asynchronously and bound
        // the wait; otherwise the read is what hangs.
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
