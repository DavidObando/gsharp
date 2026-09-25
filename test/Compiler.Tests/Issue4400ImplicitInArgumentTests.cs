// <copyright file="Issue4400ImplicitInArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Text;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4400: an argument written WITHOUT <c>in</c> at an <c>in</c>
/// parameter — the normal C# idiom, and what cs2gs emits — is passed by
/// readonly reference exactly as C# does it: the address of an addressable
/// lvalue (local, parameter, field, array element), otherwise the address of
/// a readonly temp holding the value (a literal, a call result, an operator
/// result, or an lvalue that needed an implicit conversion first).
/// </summary>
/// <remarks>
/// <para><b>The defect.</b> The member-call path (<c>this.In(9)</c>,
/// <c>base.In(9)</c>, a call inside a lambda) converted the argument as if the
/// parameter were by-value and handed the VALUE to the emitter, which pushed
/// it where the callee expected an address: ilverify <c>StackUnexpected
/// [found Int32][expected address of Int32]</c>, and
/// <c>InvalidProgramException</c> at run time. Every imported CLR method,
/// constructor and extension with an <c>in</c> parameter had the same
/// defect (the emitter's "spill to a temp" fallback never existed), the
/// imported <c>in</c> indexer was rejected with GS0155, and the free-function,
/// delegate and constructor paths rejected the call outright with GS0242.
/// Each row below was red on the parent commit.</para>
/// <para><b>Aliasing.</b> C# passes the lvalue itself, so a callee that
/// observes the storage after it changes sees the new value; an argument that
/// needed a conversion, or an rvalue, is a private copy.
/// <see cref="Aliasing_MatchesCSharp"/> compiles the C# twin with Roslyn and
/// requires the G# program to print exactly what it prints.</para>
/// </remarks>
public class Issue4400ImplicitInArgumentTests
{
    private const int RunTimeout = 60_000;

    private const string LibrarySource = """
        namespace InLib;

        public struct Big
        {
            public long A;
            public long B;
            public long C;
        }

        public class Api
        {
            public int Seed;

            public Api()
            {
            }

            public Api(in int seed)
            {
                Seed = seed;
            }

            public int this[in int i] => i * 2;

            public static long S(in long x) => x + 1;

            public static int F(in System.Func<int, int> f) => f(2);

            public static int Named(in int a, int b) => (a * 10) + b;

        #nullable enable
            public static int Len(in string? s) => s?.Length ?? -1;
        #nullable restore

            public static string O(int x) => "value";

            public static string O(ref int x) => "ref";

            public static T Id<T>(in T x) => x;

            public static string Gen<T>(in T x) => x?.ToString() ?? "null";

            public long I(in Big b) => b.A + b.B + b.C;
        }

        public static class ApiExt
        {
            public static int Ext(this Api a, in int x) => x + a.Seed;
        }

        public interface IHasIn
        {
            int M(in int x);
        }

        public class HasIn : IHasIn
        {
            public int M(in int x) => x * 3;
        }

        public interface IStaticIn
        {
            static abstract int SM(in int x);
        }

        public class StaticIn : IStaticIn
        {
            public static int SM(in int x) => x * 5;
        }

        public class GenBox<T>
        {
            public static T STake(in T x) => x;

            public T Take(in T x) => x;
        }

        public class GenHolder<T>
        {
            public T Value;

            public GenHolder(in T x)
            {
                Value = x;
            }
        }

        public class GenBase<T>
        {
            public T Value;

            public GenBase(in T x)
            {
                Value = x;
            }

            public string Describe() => Value.ToString();
        }

        public interface IGenPick<T>
        {
            T Pick(in T x);
        }

        public class GenPick<T> : IGenPick<T>
        {
            public T Pick(in T x) => x;
        }

        public class InBase
        {
            public int V;

            public InBase(in int v)
            {
                V = v;
            }
        }
        """;

    private const string AliasingTwinSource = """
        using System;

        public static class Twin
        {
            private sealed class Holder
            {
                public int F;
                public int[] Arr = new int[] { 1 };

                public int ReadAfter(in int x, Action poke)
                {
                    poke();
                    return x;
                }

                public long ReadLongAfter(in long x, Action poke)
                {
                    poke();
                    return x;
                }
            }

            public static string Run()
            {
                var h = new Holder();
                h.F = 1;
                int a = h.ReadAfter(h.F, () => h.F = 99);
                int b = h.ReadAfter(h.Arr[0], () => h.Arr[0] = 77);
                int v = 1;
                int c = h.ReadAfter(v, () => v = 42);
                int w = 1;
                long d = h.ReadLongAfter(w, () => w = 5);
                int e = h.ReadAfter(w + 0, () => w = 6);
                return $"{a} {b} {c} {d} {e}";
            }
        }
        """;

    private const string NamedOrderTwinSource = """
        public static class OrderTwin
        {
            private sealed class H
            {
                public int F;

                public H(int f)
                {
                    F = f;
                }
            }

            private struct Cell
            {
                public int Value;
            }

            private sealed class Box
            {
                public Cell Cell = new Cell { Value = 11 };
            }

            private sealed class S
            {
                public Box box = new Box();
                public int[,] grid = { { 1, 2 }, { 3, 4 } };
                public H h = new H(5);
                public int[] xs = { 10, 20 };
                public int i;
                public int[] arr = { 1, 2 };
                public int v = 3;
            }

            private static int Consume(int b, in int a) => (a * 100) + b;

            private static int Reassign(S s)
            {
                s.h = new H(7);
                return 1;
            }

            private static int Bump(S s)
            {
                s.i = 1;
                s.xs = new[] { 30, 40 };
                return 2;
            }

            private static int Swap(S s)
            {
                s.arr[0] = 99;
                s.arr = new[] { 50, 60 };
                return 3;
            }

            private static int SetV(S s)
            {
                s.v = 8;
                return 4;
            }

            private static int MutateBox(S s)
            {
                s.box.Cell.Value = 12;
                return 5;
            }

            private static int MutateGrid(S s)
            {
                s.grid[1, 0] = 33;
                return 6;
            }

            public static string Run()
            {
                var s = new S();
                int r1 = Consume(a: s.h.F, b: Reassign(s));
                int r2 = Consume(a: s.xs[s.i], b: Bump(s));
                ref int r = ref s.arr[0];
                int r3 = Consume(a: r, b: Swap(s));
                int r4 = Consume(a: s.v, b: SetV(s));
                int r5 = Consume(a: s.box.Cell.Value, b: MutateBox(s));
                int r6 = Consume(a: s.grid[1, 0], b: MutateGrid(s));
                return $"{r1} {r2} {r3} {r4} {r5} {r6}";
            }
        }
        """;

    private const string NamedOrderSource = """
        package P
        import System

        class H {
            var F int32 = 0
            init(f int32) { F = f }
        }

        struct Cell {
            var Value int32
        }

        class Box {
            var Cell Cell = Cell{Value: 11}
        }

        class S {
            var box Box = Box()
            var grid [,]int32 = [2, 2]int32{1, 2, 3, 4}
            var h H = H(5)
            var xs []int32 = []int32{10, 20}
            var i int32 = 0
            var arr []int32 = []int32{1, 2}
            var v int32 = 3
        }

        func Consume(b int32, in a int32) int32 -> a * 100 + b

        func Reassign(s S) int32 {
            s.h = H(7)
            return 1
        }

        func Bump(s S) int32 {
            s.i = 1
            s.xs = []int32{30, 40}
            return 2
        }

        func Swap(s S) int32 {
            s.arr[0] = 99
            s.arr = []int32{50, 60}
            return 3
        }

        func SetV(s S) int32 {
            s.v = 8
            return 4
        }

        func MutateBox(s S) int32 {
            s.box.Cell.Value = 12
            return 5
        }

        func MutateGrid(s S) int32 {
            s.grid[1, 0] = 33
            return 6
        }

        func Run() string {
            let s = S()
            let r1 = Consume(a: s.h.F, b: Reassign(s))
            let r2 = Consume(a: s.xs[s.i], b: Bump(s))
            var ref r = s.arr[0]
            let r3 = Consume(a: r, b: Swap(s))
            let r4 = Consume(a: s.v, b: SetV(s))
            let r5 = Consume(a: s.box.Cell.Value, b: MutateBox(s))
            let r6 = Consume(a: s.grid[1, 0], b: MutateGrid(s))
            return "${r1} ${r2} ${r3} ${r4} ${r5} ${r6}"
        }

        Console.WriteLine(Run())
        """;

    private const string AliasingSource = """
        package P
        import System

        class Holder {
            var F int32 = 0
            var Arr []int32 = []int32{1}
            func ReadAfter(in x int32, poke () -> void) int32 {
                poke()
                return x
            }
            func ReadLongAfter(in x int64, poke () -> void) int64 {
                poke()
                return x
            }
        }

        let h = Holder()
        h.F = 1
        let a = h.ReadAfter(h.F, () -> { h.F = 99 })
        let b = h.ReadAfter(h.Arr[0], () -> { h.Arr[0] = 77 })
        var v int32 = 1
        let c = h.ReadAfter(v, () -> { v = 42 })
        var w int32 = 1
        let d = h.ReadLongAfter(w, () -> { w = 5 })
        let e = h.ReadAfter(w + 0, () -> { w = 6 })
        Console.WriteLine("${a} ${b} ${c} ${d} ${e}")
        """;

    /// <summary>Gets the G#-to-G# call forms, each with its expected stdout.</summary>
    public static IEnumerable<object[]> SourceCallForms()
    {
        // The issue's own shape, plus base., lambda, field, readonly field,
        // array element, static, and an implicit int32 -> int64 conversion.
        yield return new object[]
        {
            "instance-base-lambda-static",
            """
            package P
            import System

            open class Base {
                open func In(in x int32) int32 -> x + 1
            }

            class C : Base {
                var field int32 = 40
                let roField int32 = 41
                const K int32 = 2

                override func In(in x int32) int32 -> x + 100
                func In64(in x int64) int64 -> x + 1

                shared {
                    func SIn(in x int32) int32 -> x * 2
                }

                func Go() string {
                    var local int32 = 5
                    let arr = [3]int32{7, 8, 9}
                    let a = this.In(9)
                    let b = base.In(9)
                    let c = this.In(local)
                    let d = this.In(field)
                    let e = this.In(roField)
                    let f = this.In(arr[1])
                    let g = this.In64(local)
                    let h = this.In64(3)
                    let i = C.SIn(local + 1)
                    let lam = () -> this.In(local) + base.In(3)
                    let j = lam()
                    let k = this.In(K)
                    return "${a} ${b} ${c} ${d} ${e} ${f} ${g} ${h} ${i} ${j} ${k}"
                }
            }

            Console.WriteLine(C().Go())
            """,
            new[] { "109 10 105 140 141 108 6 4 12 109 102" },
        };

        // Free functions (formerly GS0242), a generic `in T`, and a named
        // delegate invoke (formerly GS0242).
        yield return new object[]
        {
            "function-generic-delegate",
            """
            package P
            import System

            func Top(in x int32) int32 -> x + 1
            func TopG[T](in x T) string -> "${x}"

            delegate InF(in value int32) int32;
            var callback InF = (in value int32) -> value * 3

            var local = 3
            Console.WriteLine(Top(3))
            Console.WriteLine(Top(local))
            Console.WriteLine(TopG(local))
            Console.WriteLine(TopG("s"))
            Console.WriteLine(callback(local))
            Console.WriteLine(callback(4))
            """,
            new[] { "4", "4", "3", "s", "9", "12" },
        };

        // Constructors: direct, convenience-init chaining, `: base(...)`; a
        // user indexer; an extension; a struct passing `this` and its own
        // readonly field; and a call inside an async function.
        yield return new object[]
        {
            "constructor-extension-struct-async",
            """
            package P
            import System
            import System.Threading.Tasks

            struct Pt {
                var X int32
                let Y int32
                init(x int32, y int32) {
                    X = x
                    Y = y
                }
                func Read(in p Pt) int32 -> p.X + p.Y
                func Self() int32 -> this.Read(this)
                func FromField() int32 -> Take(Y) + Take(X)
            }

            func Take(in x int32) int32 -> x

            open class GBase {
                var V int32 = 0
                init(in v int32) { V = v }
            }

            class GDerived : GBase {
                init(k int32) : base(k + 1) { }
            }

            class Chained {
                var V int32 = 0
                init(in v int32) { V = v }
                convenience init() {
                    init(20 + 1)
                }
            }

            func (p Pt) Ext(in k int32) int32 -> p.X + k

            async func Later() int32 {
                await Task.Yield()
                return Take(await Task.FromResult(8)) + Take(2)
            }

            let p = Pt(1, 2)
            var i = 4
            Console.WriteLine(p.Self())
            Console.WriteLine(p.FromField())
            Console.WriteLine(GDerived(4).V)
            Console.WriteLine(Chained().V)
            Console.WriteLine(GBase(i).V)
            Console.WriteLine(p.Ext(5))
            Console.WriteLine(p.Ext(i))
            Console.WriteLine(Later().Result)
            """,
            new[] { "3", "3", "5", "21", "4", "6", "5", "10" },
        };

        // Forwarding storage that is ALREADY a reference: an `in`, `ref` or
        // `out` parameter and a `ref`/`ref readonly` alias local pass their
        // existing address (the slot's own `T&`, never the address of it).
        // The explicit `Inner(in x)` beside the implicit one is the control.
        yield return new object[]
        {
            "forward-existing-reference",
            """
            package P
            import System

            func Inner(in x int32) int32 -> x + 1
            func Outer(in x int32) int32 -> Inner(x) + Inner(in x)
            func ViaRef(ref x int32) int32 -> Inner(x)
            func ViaOut(out x int32) int32 {
                x = 4
                return Inner(x)
            }
            func Locals(seed int32) int32 {
                var v = seed
                var ref r = v
                let ref readonly ro = v
                return Inner(r) + Inner(ro)
            }
            func WithConst() int32 {
                const k = 3
                return Inner(k)
            }

            struct S {
                var V int32
                func Me(in s S) int32 -> s.V
                func Fwd(in s S) int32 -> Me(s)
            }

            var v = 10
            var o = 0
            Console.WriteLine(Outer(v))
            Console.WriteLine(Locals(v))
            Console.WriteLine(ViaRef(&v))
            Console.WriteLine(ViaOut(out o))
            Console.WriteLine(S{V: 7}.Fwd(S{V: 9}))
            Console.WriteLine(WithConst())
            """,
            new[] { "22", "22", "11", "5", "9", "4" },
        };

        // Arguments bound on the side paths that skip the ref-kind check: an
        // untyped lambda target-bound late (free function and constructor), a
        // method group through a convenience-init chain, a typed lambda through
        // a generic method's function-literal adapter, an open type parameter
        // passed through a generic method, and an untyped `default`.
        yield return new object[]
        {
            "lambda-group-generic-default",
            """
            package P
            import System

            func Top(in x int32) int32 -> x + 1
            func UseF(in f (int32) -> int32) int32 -> f(4)
            func UseFunc(in f Func[int32, int32]) int32 -> f(5)
            func Twice(x int32) int32 -> x * 2

            class K {
                var V int32 = 0
                init(in f Func[int32, int32]) { V = f(6) }
                convenience init() {
                    init(Twice)
                }
                func M(in x int32) int32 -> x + 7
                func Take[T](in x T) T -> x
                func TakeF[T](in f (T) -> T, v T) T -> f(v)
            }

            func G[U](k K, u U) U -> k.Take(u)

            let k = K()
            Console.WriteLine(UseF((x) -> x * 2))
            Console.WriteLine(UseFunc((x) -> x * 3))
            Console.WriteLine(K((x) -> x * 4).V)
            Console.WriteLine(k.V)
            Console.WriteLine(k.TakeF((x int32) -> x + 1, 8))
            Console.WriteLine(G(k, 6))
            Console.WriteLine(Top(default))
            Console.WriteLine(k.M(default))
            """,
            new[] { "8", "15", "24", "12", "9", "6", "1", "7" },
        };

        // The `shared` (static) user-call path's side branches: a generic
        // function-literal adapter, an untyped lambda at a non-generic `in`
        // delegate parameter, and an open type parameter passed through; plus
        // the same lambda shapes on instance and extension calls.
        yield return new object[]
        {
            "shared-static-lambdas",
            """
            package P
            import System

            class S {
                shared {
                    func Use[T](in f (T) -> T, v T) T -> f(v)
                    func UseN(in f (int32) -> int32) int32 -> f(3)
                    func Pass[T](in x T) T -> x
                }
                func M(in f (int32) -> int32) int32 -> f(4)
                func MG[T](in f (T) -> T, v T) T -> f(v)
            }

            struct Q {
                var X int32
            }

            func (q Q) Ext(in f (int32) -> int32) int32 -> f(q.X)

            func G[U](u U) U -> S.Pass(u)

            Console.WriteLine(S.Use((x int32) -> x + 1, 1))
            Console.WriteLine(S.UseN((x) -> x * 2))
            Console.WriteLine(S().M((x) -> x * 3))
            Console.WriteLine(S().MG((x int32) -> x * 4, 2))
            Console.WriteLine(Q{X: 5}.Ext((x int32) -> x * 5))
            Console.WriteLine(G(9))
            Console.WriteLine(S.Pass(10))
            """,
            new[] { "2", "6", "12", "8", "25", "9", "10" },
        };

        // Special argument conversions ahead of the by-ref handling: an
        // interpolated string re-lowered to `IFormattable` (function and
        // constructor; the temp takes the slot type, not `FormattableString`),
        // a reordered named `nil`, and an untyped lambda through a named
        // delegate's `in` function parameter.
        yield return new object[]
        {
            "formattable-nil-delegate",
            """
            package P
            import System

            func F(in x IFormattable) string -> x.ToString(nil, nil)

            class K {
                var S string = ""
                init(in x IFormattable) { S = x.ToString(nil, nil) }
            }

            func Opt(in s string?, b int32) string -> "${s ?? "nil"}${b}"

            delegate D(in f (int32) -> int32) int32;

            let n = 5
            Console.WriteLine(F("n=${n}"))
            Console.WriteLine(K("k=${n}").S)
            Console.WriteLine(Opt(b: 2, s: nil))
            var d D = (in f (int32) -> int32) -> f(3)
            Console.WriteLine(d((x) -> x * 7))
            """,
            new[] { "n=5", "k=5", "nil2", "21" },
        };

        // Named arguments keep lexical evaluation order when an omitted-`in`
        // rvalue is reordered into its parameter slot (free function, instance
        // method, constructor); a side-effect-free lvalue stays in its slot.
        yield return new object[]
        {
            "named-argument-order",
            """
            package P
            import System

            class Holder {
                var F int32 = 5
            }

            class Log {
                var Text string = ""
                let H Holder = Holder()
                func Mark(tag string, v int32) int32 {
                    Text = Text + tag
                    return v
                }
                func Hold() Holder {
                    Text = Text + "H"
                    return H
                }
            }

            class Sink {
                var V int32 = 0
                init() { }
                init(in a int32, b int32) { V = a * 10 + b }
                func Take(in a int32, b int32) int32 -> a * 10 + b
            }

            func Consume(in a int32, b int32) int32 -> a * 10 + b
            func Consume2(a int32, in b int32) int32 -> a * 10 + b

            let l1 = Log()
            Console.WriteLine(Consume(b: l1.Mark("B", 2), a: l1.Mark("A", 1)))
            Console.WriteLine(l1.Text)
            let l2 = Log()
            Console.WriteLine(Consume2(b: l2.Mark("B", 2), a: l2.Mark("A", 1)))
            Console.WriteLine(l2.Text)
            let l3 = Log()
            Console.WriteLine(Sink().Take(b: l3.Mark("B", 2), a: l3.Mark("A", 1)))
            Console.WriteLine(l3.Text)
            let l4 = Log()
            Console.WriteLine(Sink(b: l4.Mark("B", 2), a: l4.Mark("A", 1)).V)
            Console.WriteLine(l4.Text)
            var x = 7
            let l5 = Log()
            Console.WriteLine(Consume(b: l5.Mark("B", 2), a: x))
            Console.WriteLine(l5.Text)
            let l6 = Log()
            Console.WriteLine(Consume(b: l6.Mark("B", 2), a: l6.Hold().F))
            Console.WriteLine(l6.Text)
            let l7 = Log()
            Console.WriteLine(Consume(b: l7.Mark("B", 2), a: in l7.Hold().F))
            Console.WriteLine(l7.Text)
            """,
            new[] { "12", "BA", "12", "BA", "12", "BA", "12", "BA", "72", "B", "52", "BH", "52", "BH" },
        };
    }

    /// <summary>
    /// Each G#-declared call form binds an omitted-<c>in</c> argument, IL-verifies
    /// and prints the C#-equivalent result.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# program.</param>
    /// <param name="expectedLines">The expected stdout lines.</param>
    [Theory]
    [MemberData(nameof(SourceCallForms))]
    public void SourceDeclaredInParameter_OmittedModifier_CompilesVerifiesAndRuns(
        string name,
        string source,
        string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4400_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var log = Compile(tempDir, source, appPath);
            Assert.True(File.Exists(appPath), $"'{name}' must compile. Log:\n{log}");

            IlVerifier.Verify(appPath);

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"'{name}' must run. Exit {exit}:\n{output}");
            Assert.Equal(expectedLines, SplitLines(output));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// Imported C# methods, constructors, a base constructor, an indexer, an
    /// extension and generic methods with <c>in</c> parameters, all called
    /// from G# without <c>in</c>.
    /// </summary>
    [Fact]
    public void ImportedInParameter_OmittedModifier_CompilesVerifiesAndRuns()
    {
        const string source = """
            package P
            import System
            import InLib

            struct Pt {
                var X int32
                init(x int32) { X = x }
            }

            class ClrDerived : InBase {
                init() : base(33) { }
            }

            class Log {
                var Text string = ""
                func Mark(tag string, v int32) int32 {
                    Text = Text + tag
                    return v
                }
            }

            func Fwd64(in x int64) int64 -> Api.S(x)

            var v int64 = 5
            Console.WriteLine(Api.S(v))
            Console.WriteLine(Api.S(7))
            let api = Api()
            var b = Big{A: 1, B: 2, C: 3}
            Console.WriteLine(api.I(b))
            Console.WriteLine(api.I(Big{A: 4}))
            Console.WriteLine(Api(9).Seed)
            let seed = 11
            let seeded = Api(seed)
            Console.WriteLine(seeded.Seed)
            Console.WriteLine(api[4])
            Console.WriteLine(api[seed])
            Console.WriteLine(seeded.Ext(4))
            Console.WriteLine(seeded.Ext(seed))
            Console.WriteLine(ClrDerived().V)
            let p = Pt(6)
            Console.WriteLine(Api.Id(p).X)
            Console.WriteLine(Api.Gen(12))
            Console.WriteLine(Fwd64(40))
            Console.WriteLine(Api.S(default))
            Console.WriteLine(Api.F((x int32) -> x * 5))
            Console.WriteLine(Api.O(default))
            let log = Log()
            let named = Api.Named(b: log.Mark("B", 2), a: log.Mark("A", 1))
            Console.WriteLine("${named} ${log.Text}")
            Console.WriteLine(Api.Len(nil))
            Console.WriteLine(Api.Len("abc"))
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4400_imp_").FullName;
        try
        {
            var libPath = CompileCSharp(tempDir, "InLib", LibrarySource);
            var appPath = Path.Combine(tempDir, "App.dll");
            var log = Compile(tempDir, source, appPath, "/reference:" + libPath);
            Assert.True(File.Exists(appPath), $"the app must compile. Log:\n{log}");

            IlVerifier.Verify(appPath, new[] { libPath });

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"the app must run. Exit {exit}:\n{output}");
            Assert.Equal(
                new[] { "6", "8", "6", "4", "9", "11", "8", "22", "15", "22", "33", "6", "12", "41", "1", "10", "value", "12 BA", "-1", "3" },
                SplitLines(output));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// Imported GENERIC members whose <c>in T</c> slot the closed reflection
    /// shape erases to <c>object&amp;</c> — over an open <c>T</c> and over a
    /// same-compilation struct — spill/address at the symbolic <c>!0</c>, the
    /// type the emitted MemberRef actually takes: instance and static methods,
    /// a constructor, an interface slot, and a <c>: base(...)</c> initializer
    /// into a generic CLR base.
    /// </summary>
    [Fact]
    public void GenericImportedInParameter_OmittedModifier_UsesTheSymbolicPointee()
    {
        const string source = """
            package P
            import System
            import InLib

            struct Pt {
                var X int32
                override func ToString() string -> "Pt(${X})"
            }

            class Derived[T] : GenBase[T] {
                init(x T) : base(x) { }
            }

            class DerivedPt : GenBase[Pt] {
                init(p Pt) : base(p) { }
            }

            func Open[T](b GenBox[T], v T) T -> b.Take(v)
            func OpenStatic[T](v T) T -> GenBox[T].STake(v)
            func OpenCtor[T](v T) T -> GenHolder[T](v).Value
            func OpenIface[T](g IGenPick[T], v T) T -> g.Pick(v)

            let p = Pt{X: 5}
            Console.WriteLine(Open(GenBox[int32](), 3))
            Console.WriteLine(Open(GenBox[Pt](), p).X)
            Console.WriteLine(GenBox[Pt]().Take(p).X)
            Console.WriteLine(GenBox[Pt].STake(p).X)
            Console.WriteLine(GenBox[int32].STake(4))
            Console.WriteLine(OpenStatic(p).X)
            Console.WriteLine(OpenCtor(p).X)
            Console.WriteLine(GenHolder[Pt](p).Value.X)
            Console.WriteLine(Derived[Pt](p).Describe())
            Console.WriteLine(Derived[int32](6).Describe())
            Console.WriteLine(DerivedPt(p).Describe())
            Console.WriteLine(OpenIface(GenPick[Pt](), p).X)
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4400_gen_").FullName;
        try
        {
            var libPath = CompileCSharp(tempDir, "InLib", LibrarySource);
            var appPath = Path.Combine(tempDir, "Generic.dll");
            var log = Compile(tempDir, source, appPath, "/reference:" + libPath);
            Assert.True(File.Exists(appPath), $"the app must compile. Log:\n{log}");

            IlVerifier.Verify(appPath, new[] { libPath });

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"the app must run. Exit {exit}:\n{output}");
            Assert.Equal(
                new[] { "3", "5", "5", "5", "4", "5", "5", "5", "Pt(5)", "6", "Pt(5)", "5" },
                SplitLines(output));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// Interface-constrained calls — an instance slot and a static-abstract
    /// slot — bind their arguments on paths that skip the general CLR
    /// conversion pass for a non-generic method; an omitted <c>in</c> must
    /// still become a readonly reference there.
    /// </summary>
    [Fact]
    public void ConstrainedInterfaceInParameter_OmittedModifier_CompilesVerifiesAndRuns()
    {
        const string source = """
            package P
            import System
            import InLib

            func InstanceCaller[T IHasIn](t T) int32 {
                var local = 2
                return t.M(5) + t.M(local)
            }

            func StaticCaller[T IStaticIn]() int32 {
                var local = 2
                return T.SM(5) + T.SM(local)
            }

            Console.WriteLine(InstanceCaller(HasIn()))
            Console.WriteLine(StaticCaller[StaticIn]())
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4400_constrained_").FullName;
        try
        {
            var libPath = CompileCSharp(tempDir, "InLib", LibrarySource);
            var appPath = Path.Combine(tempDir, "Constrained.dll");
            var log = Compile(tempDir, source, appPath, "/reference:" + libPath);
            Assert.DoesNotContain("GS9998", log, StringComparison.Ordinal);
            Assert.True(File.Exists(appPath), $"the app must compile. Log:\n{log}");

            // Only the static-abstract caller carries ilverify's known
            // pre-C# 11 static-virtual false positives; everything else,
            // including StackUnexpected inside it, is verified strictly.
            IlVerifier.Verify(
                appPath,
                new[] { libPath },
                IlVerifier.KnownIssues.StaticVirtualInterface,
                ignoredErrorScope: "StaticCaller");

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"the app must run. Exit {exit}:\n{output}");
            Assert.Equal(new[] { "21", "35" }, SplitLines(output));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// Reordered named arguments select an `in` argument's storage in SOURCE
    /// order, as C# does, even when a later argument reassigns the field
    /// receiver or the array/index that selects it; a `ref` local keeps
    /// aliasing the storage it was bound to. Checked against the C# twin.
    /// </summary>
    [Fact]
    public void NamedArgumentStorageSelection_MatchesCSharp()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4400_order_").FullName;
        try
        {
            var twinPath = CompileCSharp(tempDir, "OrderTwin", NamedOrderTwinSource);
            var context = new AssemblyLoadContext("gs_4400_order_twin", isCollectible: true);
            string expected;
            try
            {
                using var twinImage = new MemoryStream(File.ReadAllBytes(twinPath));
                var twin = context.LoadFromStream(twinImage);
                var run = twin.GetType("OrderTwin", throwOnError: true)!.GetMethod("Run", BindingFlags.Public | BindingFlags.Static)!;
                expected = (string)run.Invoke(null, null)!;
            }
            finally
            {
                context.Unload();
            }

            Assert.Equal("501 1002 9903 804 1205 3306", expected);

            var appPath = Path.Combine(tempDir, "Order.dll");
            var log = Compile(tempDir, NamedOrderSource, appPath);
            Assert.True(File.Exists(appPath), $"the ordering program must compile. Log:\n{log}");
            IlVerifier.Verify(appPath);

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"the ordering program must run. Exit {exit}:\n{output}");
            Assert.Equal(expected, output.Trim());
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// A callee that reads its <c>in</c> parameter after the caller's storage
    /// changes observes exactly what the C# twin observes: fields, array
    /// elements and (captured) locals alias; a converted or rvalue argument is
    /// a private copy.
    /// </summary>
    [Fact]
    public void Aliasing_MatchesCSharp()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4400_alias_").FullName;
        try
        {
            var twinPath = CompileCSharp(tempDir, "Twin", AliasingTwinSource);
            var context = new AssemblyLoadContext("gs_4400_twin", isCollectible: true);
            string expected;
            try
            {
                // Load from bytes so no file handle outlives the collectible
                // context's asynchronous unload (the directory is deleted below).
                using var twinImage = new MemoryStream(File.ReadAllBytes(twinPath));
                var twin = context.LoadFromStream(twinImage);
                var run = twin.GetType("Twin", throwOnError: true)!.GetMethod("Run", BindingFlags.Public | BindingFlags.Static)!;
                expected = (string)run.Invoke(null, null)!;
            }
            finally
            {
                context.Unload();
            }

            // Pinned so a drift in either compiler is noticed, not averaged.
            Assert.Equal("99 77 42 1 5", expected);

            var appPath = Path.Combine(tempDir, "Alias.dll");
            var log = Compile(tempDir, AliasingSource, appPath);
            Assert.True(File.Exists(appPath), $"the aliasing program must compile. Log:\n{log}");
            IlVerifier.Verify(appPath);

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"the aliasing program must run. Exit {exit}:\n{output}");
            Assert.Equal(expected, output.Trim());
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>Gets argument shapes that must still be rejected, with the expected diagnostic.</summary>
    public static IEnumerable<object[]> RejectedArguments()
    {
        // No implicit conversion: the ordinary by-value diagnostic, on every path.
        yield return new object[]
        {
            "member-no-conversion",
            """
            class C {
                func In(in x int32) int32 -> x
                func Go() int32 -> this.In("s")
            }
            """,
            "GS0154",
        };
        yield return new object[]
        {
            "function-no-conversion",
            """
            func Top(in x int32) int32 -> x
            let r = Top("s")
            """,
            "GS0154",
        };
        yield return new object[]
        {
            "constructor-no-conversion",
            """
            class C {
                init(in x int32) { }
            }
            let c = C("s")
            """,
            "GS0154",
        };

        // A `ref` parameter still requires the modifier; before the fix the
        // member path emitted the value unverifiably instead.
        yield return new object[]
        {
            "member-ref-without-modifier",
            """
            class C {
                func R(ref x int32) { x = x + 1 }
                func Go() {
                    var v = 1
                    this.R(v)
                }
            }
            """,
            "GS0235",
        };

        // The same through the early-bound branches that skip the ref-kind
        // check: an open type parameter passed through a generic instance,
        // `shared` or extension method, and a function literal adapted for a
        // generic `ref` delegate parameter.
        yield return new object[]
        {
            "generic-instance-ref-without-modifier",
            """
            class C {
                func R[T](ref x T) { }
            }
            func G[U](c C, u U) {
                c.R(u)
            }
            """,
            "GS0235",
        };
        yield return new object[]
        {
            "generic-shared-ref-without-modifier",
            """
            class C {
                shared {
                    func R[T](ref x T) { }
                }
            }
            func G[U](u U) {
                C.R(u)
            }
            """,
            "GS0235",
        };
        yield return new object[]
        {
            "generic-extension-out-without-modifier",
            """
            struct Q {
                var X int32
            }
            func (q Q) R[T](out x T) { x = default }
            func G[U](q Q, u U) {
                q.R(u)
            }
            """,
            "GS0235",
        };
        yield return new object[]
        {
            "generic-function-literal-ref-without-modifier",
            """
            class C {
                func F[T](ref f (T) -> T, v T) T -> f(v)
            }
            let r = C().F((x int32) -> x + 1, 2)
            """,
            "GS0235",
        };
    }

    /// <summary>
    /// Arguments C# would also reject keep a diagnostic (never unverifiable IL
    /// and never an internal error).
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="body">The G# declarations and statements.</param>
    /// <param name="expectedId">The expected diagnostic id.</param>
    [Theory]
    [MemberData(nameof(RejectedArguments))]
    public void UnconvertibleOrRefArgument_StillReportsDiagnostic(string name, string body, string expectedId)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4400_diag_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var log = Compile(tempDir, "package P\n" + body + "\n", appPath, "/target:library");
            Assert.Contains(expectedId, log, StringComparison.Ordinal);
            Assert.DoesNotContain("GS0242", log, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", log, StringComparison.Ordinal);
            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{log}");
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static string[] SplitLines(string output)
        => output.Split('\n').Select(line => line.TrimEnd('\r')).Where(line => line.Length > 0).ToArray();

    private static string CompileCSharp(string tempDir, string assemblyName, string source)
    {
        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToList();
        var compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { CSharpSyntaxTree.ParseText(source) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var path = Path.Combine(tempDir, assemblyName + ".dll");
        var result = compilation.Emit(path);
        Assert.True(
            result.Success,
            "the C# source must compile:\n"
                + string.Join("\n", result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));
        return path;
    }

    private static string Compile(string dir, string source, string outPath, params string[] extra)
    {
        var srcPath = Path.Combine(dir, Path.GetFileNameWithoutExtension(outPath) + ".gs");
        File.WriteAllText(srcPath, source);
        var args = new List<string> { "/out:" + outPath, "/targetframework:net10.0" };
        if (!extra.Any(argument => argument.StartsWith("/target:", StringComparison.Ordinal)))
        {
            args.Add("/target:exe");
        }

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
