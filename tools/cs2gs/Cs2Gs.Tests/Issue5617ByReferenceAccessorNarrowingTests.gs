// <copyright file="Issue5617ByReferenceAccessorNarrowingTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import System.Text
import System.Text.RegularExpressions
import Xunit

/// Issue #5617: gsc removes the narrowing fact of a by-reference variable at an accessor that can run user code
/// (ADR-0208 R14, R16 and R17) and at a write through a member or an element (R12). C# flow analysis keeps the
/// fact, so the translated read needs its own `!!`. An accessor that runs no user code keeps the fact, so its read
/// stays bare. Issue #5650: a loop whose iteration can run user code (ADR-0208 R11, ADR-0213) removes the fact
/// too. Each test translates the C#, compiles the G# with the repository's `gsc.dll`, runs it, and compares the
/// output with the output of the C#.
open class Issue5617ByReferenceAccessorNarrowingTests {
    @Fact
    func RefParameter_AdjacentGotoCase_KeepsThePrecedingSectionEffects() {
        let printed = AssertRunsLikeCSharp(`
public sealed class Box { public int F; }
public class Demo
{
    public static int Read(ref string? s, Box box, int k)
    {
        if (s == null) return 0;
        switch (k)
        {
            case 0:
                box.F = 1;
                goto case 1;
            case 1:
                return s.Length;
            default:
                return 0;
        }
    }
    public static string Run()
    {
        string? text = "abc";
        return Read(ref text, new Box(), 0).ToString();
    }
}`)
        Assert.Contains("return s!!.Length", printed)
    }

    /// The issue shape: `Lazy<T>.Value` is an imported getter that is not on the stable list (R16).
    @Fact
    func RefParameter_ReadAfterAnUnlistedImportedGetter_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using System;
public class Demo
{
    public static int Compute(ref string? s, Lazy<int> lazy)
    {
        if (s == null) return 0;
        var n = lazy.Value;
        return s.Length + n;
    }
    public static string Run()
    {
        string? text = "abc";
        return Compute(ref text, new Lazy<int>(() => 1)).ToString();
    }
}`)
        Assert.Contains("s!!.Length", printed)
    }

    /// A source property with a computed getter runs user code (R14).
    @Fact
    func RefParameter_ReadAfterAComputedSourceGetter_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public sealed class Counter
{
    private int count;
    public int Next => ++count;
}
public class Demo
{
    public static int Compute(ref string? s, Counter counter)
    {
        if (s == null) return 0;
        var n = counter.Next;
        return s.Length + n;
    }
    public static string Run()
    {
        string? text = "abc";
        return Compute(ref text, new Counter()).ToString();
    }
}`)
        Assert.Contains("s!!.Length", printed)
    }

    /// An overridable auto property read through a receiver whose type can have a subclass can dispatch to an
    /// override with user code (R14, #5599).
    @Fact
    func OutParameter_ReadAfterAnOverridableAutoPropertyOfAnOpenReceiver_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public class Shape
{
    public virtual int Size { get; set; }
}
public class Square : Shape
{
    public Square() { Size = 5; }
    public override int Size { get; set; }
}
public class Demo
{
    static string? Pick() => "abc";
    public static int Compute(out string? s, Shape shape)
    {
        s = Pick();
        if (s == null) return 0;
        var n = shape.Size;
        return s.Length + n;
    }
    public static string Run() => Compute(out _, new Square()).ToString();
}`)
        Assert.Contains("s!!.Length", printed)
    }

    /// An imported indexer read that is not on the stable list (`Dictionary<K, V>` calls `GetHashCode` and `Equals`
    /// of the key) runs user code (R17).
    @Fact
    func RefParameter_ReadAfterAnUnlistedImportedIndexer_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using System.Collections.Generic;
public class Demo
{
    public static int Compute(ref string? s, Dictionary<int, int> map)
    {
        if (s == null) return 0;
        var n = map[1];
        return s.Length + n;
    }
    public static string Run()
    {
        string? text = "abc";
        return Compute(ref text, new Dictionary<int, int> { [1] = 7 }).ToString();
    }
}`)
        Assert.Contains("s!!.Length", printed)
    }

    /// An imported indexer write, an imported setter and a field write: a write through a member or an element can
    /// change the storage that a by-reference parameter names (R12, R17).
    @Fact
    func RefParameter_ReadAfterAnImportedSetterOrIndexerWrite_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using System.Collections.Generic;
using System.IO;
public sealed class Box
{
    public int Field;
}
public class Demo
{
    public static int Store(ref string? s, Dictionary<int, int> table)
    {
        if (s == null) return 0;
        table[2] = 5;
        return s.Length + table.Count;
    }
    public static int Seek(ref string? s, MemoryStream stream)
    {
        if (s == null) return 0;
        stream.Position = 0;
        return s.Length;
    }
    public static int Write(ref string? s, Box box)
    {
        if (s == null) return 0;
        box.Field = 3;
        return s.Length + box.Field;
    }
    public static string Run()
    {
        string? text = "abc";
        return Store(ref text, new Dictionary<int, int>()) + "," + Seek(ref text, new MemoryStream()) + "," + Write(ref text, new Box());
    }
}`)
        Assert.Contains("return s!!.Length + table.Count", printed)
        Assert.Contains("return s!!.Length\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("return s!!.Length + box.Field", printed)
    }

    /// cs2gs lowers a positional subpattern to a read of the member that its slot deconstructs to, so a computed
    /// getter there runs user code (R14). A positional record property is a plain auto property and keeps the fact.
    @Fact
    func RefParameter_ReadAfterAPositionalPatternOverAComputedGetter_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public sealed class Counter
{
    private int count;
    public int Next => ++count;
    public void Deconstruct(out int next) { next = Next; }
}
public sealed record Point(int X);
public class Demo
{
    public static int Compute(ref string? s, Counter counter)
    {
        if (s == null) return 0;
        var hit = counter is Counter(1);
        return s.Length + (hit ? 1 : 0);
    }
    public static int Plain(ref string? s, Point point)
    {
        if (s == null) return 0;
        var hit = point is Point(1);
        return s.Length + (hit ? 1 : 0);
    }
    public static string Run()
    {
        string? text = "abc";
        return Compute(ref text, new Counter()) + "," + Plain(ref text, new Point(1));
    }
}`)
        Assert.Contains("return s!!.Length + (if hit", printed)
        Assert.Contains("return s.Length + (if hit", printed)
    }

    /// The guard's own pattern runs its getters before the fact holds, so gsc does not narrow a by-reference variable
    /// on a pattern with a computed getter (R18 (6)). A plain auto property keeps the fact.
    @Fact
    func RefParameter_GuardedByItsOwnPatternWithAComputedGetter_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public sealed class Box
{
    private int count;
    public int P => ++count;
    public int Q { get; set; }
    public int X = 7;
}
public class Demo
{
    public static int Compute(ref Box? s)
    {
        if (s is Box { P: 1 } matched) return s.X;
        return 0;
    }
    public static int Plain(ref Box? s)
    {
        if (s is Box { Q: 0 } matched) return s.X + 1;
        return 0;
    }
    public static string Run()
    {
        Box? box = new Box();
        return Compute(ref box) + "," + Plain(ref box);
    }
}`)
        Assert.Contains("return s!!.X\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("return s.X + 1", printed)
    }

    /// A writable `ref` local of an element can write the storage that a by-reference parameter names, so gsc records
    /// it as a write (R12, `RecordWritableReference`). A `ref readonly` local and a `ref` local of a local keep the fact.
    @Fact
    func RefParameter_ReadAfterAWritableRefLocalOfAnElement_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public class Demo
{
    public static int Writable(ref string? s, int[] xs)
    {
        if (s == null) return 0;
        ref int alias = ref xs[0];
        return s.Length + alias;
    }
    public static int ReadOnly(ref string? s, int[] xs)
    {
        if (s == null) return 0;
        ref readonly int view = ref xs[0];
        return s.Length + view + 1;
    }
    public static int OfLocal(ref string? s, int[] xs)
    {
        var n = xs[1];
        if (s == null) return 0;
        ref int local = ref n;
        return s.Length + local + 2;
    }
    public static string Run()
    {
        string? text = "abc";
        var xs = new int[] { 4, 5 };
        return Writable(ref text, xs) + "," + ReadOnly(ref text, xs) + "," + OfLocal(ref text, xs);
    }
}`)
        Assert.Contains("return s!!.Length + alias", printed)
        Assert.Contains("return s.Length + view + 1", printed)
        Assert.Contains("return s.Length + local + 2", printed)
    }

    /// gsc emits an index read on an imported `List<int>` subclass nested in `Outer<T>` through `IList`, because the
    /// CLR type arguments of the nested type include `T` (R17). The listed `List<T>` indexer is then not the one that
    /// runs. A closed `Outer<string>.Items` uses the listed indexer and keeps the fact.
    @Fact
    func RefParameter_ReadAfterAnIndexOfAnImportedNestedTypeOfAGenericParameter_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using Lib;
public class Demo
{
    public static int Open<T>(ref string? s, Outer<T>.Items items)
    {
        if (s == null) return 0;
        var n = items[0];
        return s.Length + n;
    }
    public static int Closed(ref string? s, Outer<string>.Items items)
    {
        if (s == null) return 0;
        var n = items[0];
        return s.Length + n + 1;
    }
    public static string Run()
    {
        string? text = "abc";
        var items = new Outer<string>().Values;
        return Open<string>(ref text, items) + "," + Closed(ref text, items);
    }
}`, library: `
using System.Collections.Generic;
namespace Lib
{
    public class Outer<T>
    {
        public class Items : List<int> { }
        public Items Values { get; } = new Items { 4 };
    }
}`)
        Assert.Contains("return s!!.Length + n\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("return s.Length + n + 1", printed)
    }

    /// A `with` expression writes the members of the copy, which gsc counts as a member write (R12), for a positional
    /// property and for an `init` property.
    @Fact
    func RefParameter_ReadAfterARecordWithExpression_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public sealed record Rec(int X)
{
    public int Y { get; init; }
}
public class Demo
{
    public static int Positional(ref string? s, Rec r)
    {
        if (s == null) return 0;
        var r2 = r with { X = 2 };
        return s.Length + r2.X;
    }
    public static int Init(ref string? s, Rec r)
    {
        if (s == null) return 0;
        var r2 = r with { Y = 3 };
        return s.Length + r2.Y;
    }
    public static string Run()
    {
        string? text = "abc";
        return Positional(ref text, new Rec(1)) + "," + Init(ref text, new Rec(1));
    }
}`)
        Assert.Contains("return s!!.Length + r2.X", printed)
        Assert.Contains("return s!!.Length + r2.Y", printed)
    }

    /// The address of a member names storage that a write through the pointer can change, so gsc counts it as a
    /// write (R12). The address of a local keeps the fact.
    @Fact
    func RefParameter_ReadAfterTheAddressOfAMember_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public struct Pt { public int X; }
public class Demo
{
    public static unsafe int Member(ref string? s, int seed)
    {
        var pt = new Pt { X = seed };
        if (s == null) return 0;
        int* p = &pt.X;
        return s.Length + *p;
    }
    public static unsafe int Local(ref string? s, int seed)
    {
        var n = seed;
        if (s == null) return 0;
        int* q = &n;
        return s.Length + *q + 1;
    }
    public static string Run()
    {
        string? text = "abc";
        return Member(ref text, 4) + "," + Local(ref text, 4);
    }
}`)
        Assert.Contains("return s!!.Length + *p", printed)
        Assert.Contains("return s.Length + *q + 1", printed)
    }

    /// cs2gs passes the receiver of a `this ref` extension as `&counters[0]`, a writable reference to an element,
    /// which gsc counts as a write (R12). A local receiver and an `in` receiver keep the fact.
    @Fact
    func RefParameter_ReadAfterARefExtensionCallOnAnElement_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public struct Counter { public int N; }
public static class Ext
{
    public static void Touch(this ref Counter value) { value.N++; }
    public static int Peek(this in Counter value) => value.N;
}
public class Demo
{
    public static int Element(ref string? s, Counter[] counters)
    {
        if (s == null) return 0;
        counters[0].Touch();
        return s.Length + counters[0].N;
    }
    public static int Local(ref string? s, int seed)
    {
        var c = new Counter { N = seed };
        if (s == null) return 0;
        c.Touch();
        return s.Length + c.N + 1;
    }
    public static int ReadOnly(ref string? s, Counter[] counters)
    {
        if (s == null) return 0;
        var n = counters[0].Peek();
        return s.Length + n + 2;
    }
    public static string Run()
    {
        string? text = "abc";
        var counters = new Counter[1];
        return Element(ref text, counters) + "," + Local(ref text, 1) + "," + ReadOnly(ref text, counters);
    }
}`)
        Assert.Contains("return s!!.Length + counters[0].N", printed)
        Assert.Contains("return s.Length + c.N + 1", printed)
        Assert.Contains("return s.Length + n + 2", printed)
    }

    /// A `switch` case or arm runs its test, and its guard, before its body (ADR-0208, #5629). cs2gs lowers a property
    /// case to a guard that reads the property, so a computed getter there removes the fact for the body. A constant
    /// case on `object` calls `Equals`, a plain call that keeps the fact of a by-reference variable (amendment A3).
    @Fact
    func RefParameter_ReadInASwitchCaseAfterAnAccessorTest_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using System;
public sealed class Box { private int count; public int P => ++count; }
public class Demo
{
    public static int Case(ref string? s, object o)
    {
        if (s == null) return 0;
        switch (o)
        {
            case Box { P: 1 }:
                return s.Length;
            default:
                return 0;
        }
    }
    public static int Arm(ref string? s, object o)
    {
        if (s == null) return 0;
        return o switch { Box { P: 1 } => s.Length + 1, _ => 0 };
    }
    public static int Guard(ref string? s, int n, Lazy<int> lazy)
    {
        if (s == null) return 0;
        switch (n)
        {
            case 1 when lazy.Value > 0:
                return s.Length + 2;
            default:
                return 0;
        }
    }
    public static int Constant(ref string? s, object o)
    {
        if (s == null) return 0;
        switch (o)
        {
            case 1:
                return s.Length + 3;
            default:
                return 0;
        }
    }
    public static string Run()
    {
        string? text = "abc";
        return Case(ref text, new Box()) + "," + Arm(ref text, new Box()) + "," +
            Guard(ref text, 1, new Lazy<int>(() => 1)) + "," + Constant(ref text, 1);
    }
}`)
        Assert.Contains("return s!!.Length\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("s!!.Length + 1", printed)
        Assert.Contains("return s!!.Length + 2", printed)
        Assert.Contains("return s.Length + 3", printed)
    }

    /// A `default` section that is not last runs after the tests and guards of the later cases (#5629), so a later
    /// guard or property case with an accessor removes the fact for the `default` body. A later constant case on
    /// `int32` keeps it.
    @Fact
    func RefParameter_ReadInADefaultBeforeAnAccessorCase_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using System;
public sealed class Box { private int count; public int P => ++count; }
public class Demo
{
    public static int Guard(ref string? s, int n, Lazy<int> lazy)
    {
        if (s == null) return 0;
        switch (n)
        {
            default:
                return s.Length;
            case 1 when lazy.Value > 0:
                return 0;
        }
    }
    public static int Property(ref string? s, object o)
    {
        if (s == null) return 0;
        switch (o)
        {
            default:
                return s.Length + 1;
            case Box { P: 1 }:
                return 0;
        }
    }
    public static int Constant(ref string? s, int n)
    {
        if (s == null) return 0;
        switch (n)
        {
            default:
                return s.Length + 2;
            case 1:
                return 0;
        }
    }
    public static string Run()
    {
        string? text = "abc";
        return Guard(ref text, 2, new Lazy<int>(() => 1)) + "," + Property(ref text, new Box()) + "," +
            Constant(ref text, 2);
    }
}`)
        Assert.Contains("return s!!.Length\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("return s!!.Length + 1", printed)
        Assert.Contains("return s.Length + 2", printed)
    }

    /// A field read, the getters and indexers on the stable list, a plain auto property, an overridable auto property
    /// through a receiver that cannot have a subclass, and `Nullable<T>.Value` (which the translator emits as `!!`)
    /// run no user code, so gsc keeps the fact and the read stays bare.
    @Fact
    func RefParameter_ReadAfterAccessorsThatRunNoUserCode_StaysBare() {
        let printed = AssertRunsLikeCSharp(`
using System.Collections.Generic;
using System.Text;
public sealed class Box
{
    public int Field = 1;
}
public sealed class Person
{
    public string Name { get; init; } = "ab";
    public int Age { get; set; }
}
public class Shape
{
    public virtual int Size { get; set; }
}
public sealed class Square : Shape
{
    public Square() { Size = 5; }
    public override int Size { get; set; }
}
public class Demo
{
    public static int Compute(ref string? s, Box box, string other, List<int> list, Dictionary<int, int> table, StringBuilder builder)
    {
        if (s == null) return 0;
        var a = box.Field;
        var b = other.Length + other[0];
        var c = list.Count + list[0];
        var d = table.Count + builder.Length;
        return s.Length + a + b + c + d;
    }
    public static int Members(ref string? s, Person person, Square square, int? maybe)
    {
        if (s == null) return 0;
        var a = person.Name.Length + person.Age;
        var b = square.Size;
        var c = maybe.HasValue ? maybe.Value : 0;
        return s.Length + a + b + c;
    }
    public static string Run()
    {
        string? text = "abc";
        var list = new List<int> { 4 };
        var table = new Dictionary<int, int> { [1] = 1 };
        return Compute(ref text, new Box(), "xy", list, table, new StringBuilder("q")) + "," + Members(ref text, new Person(), new Square(), 3);
    }
}`)
        Assert.DoesNotContain("s!!", printed)
    }

    /// Issue #5650: gsc iterates every collection other than a single-dimensional array and a `string` through an
    /// enumerator, which can run user code (ADR-0208 R11), so the fact ends at the loop: inside the body and after it.
    /// This holds for an `in` and an `out` parameter as for a `ref` parameter.
    @Fact
    func RefParameter_ReadAfterOrInAForEachOverAnEnumerable_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using System.Collections.Generic;
public class Demo
{
    static IEnumerable<int> Numbers() { yield return 1; yield return 2; }
    public static int Compute(ref string? s, List<int> items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var item in items) total += item;
        return s.Length + total;
    }
    public static int Inside(ref string? s, List<int> items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var item in items) total += item + s.Length;
        return total;
    }
    public static int Sequence(in string? s, IEnumerable<int> items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var item in items) total += item;
        return s.Length + total;
    }
    public static int Map(out string? s, Dictionary<int, int> items)
    {
        s = items.Count > 0 ? "abcd" : null;
        if (s == null) return 0;
        var total = 0;
        foreach (var pair in items) total += pair.Value;
        return s.Length + total;
    }
    public static string Run()
    {
        string? text = "abc";
        var items = new List<int> { 1, 2 };
        return Compute(ref text, items) + "," + Inside(ref text, items) + "," + Sequence(in text, Numbers()) + "," +
            Map(out _, new Dictionary<int, int> { [1] = 5 });
    }
}`)
        Assert.Contains("return s!!.Length + total", printed)
        Assert.Contains("total += item + s!!.Length", printed)
        Assert.Equal(4, Regex.Matches(printed, `s!!`).Count)
    }

    /// A span, an immutable array and a multi-dimensional array are pattern enumerators in gsc (ADR-0208 R11).
    @Fact
    func RefParameter_ReadAfterOrInAForEachOverAPatternEnumerator_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using System;
using System.Collections.Immutable;
public class Demo
{
    public static int Spans(ref string? s, Span<int> items, ReadOnlySpan<int> readOnly)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var item in items) total += item + s.Length;
        foreach (var item in readOnly) total += item;
        return s.Length + total;
    }
    public static int Immutable(ref string? s, ImmutableArray<int> items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var item in items) total += item + s.Length;
        return total;
    }
    public static int Grid(ref string? s, int[,] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var item in items) total += item + s.Length;
        return s.Length + total;
    }
    public static string Run()
    {
        string? text = "abc";
        return Spans(ref text, new[] { 1, 2 }.AsSpan(), new[] { 3 }) + "," +
            Immutable(ref text, ImmutableArray.Create(4, 5)) + "," + Grid(ref text, new int[2, 2]);
    }
}`)
        Assert.Equal(5, Regex.Matches(printed, `s!!`).Count)
    }

    /// gsc iterates a single-dimensional array and a `string` by index, which runs no user code, also with a typed
    /// loop variable that widens, wraps or boxes the element, with an inferred tuple-target loop and a record into
    /// discards only, which reads no member (ADR-0213 table T5). A loop that holds a
    /// `while` loop, and not a `for ... in`, keeps the fact too. The reads stay bare.
    @Fact
    func RefParameter_ReadAfterAForEachOverAnArrayOrAString_StaysBare() {
        let printed = AssertRunsLikeCSharp(`
using System.Text;
public record Point(int X, int Y);
public sealed class Wrapper
{
    public int V;
    public static implicit operator Wrapper(int v) => new Wrapper { V = v };
}
public class Demo
{
    public static int Arrays(ref string? s, int[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var item in items) total += item + s.Length;
        foreach (var item in items) total += item;
        return s.Length + total;
    }
    public static int Strings(ref string? s, string text, StringBuilder builder)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var c in text) total += 1 + s.Length;
        foreach (var c in builder.ToString()) total += 1;
        foreach (var part in "a,b".Split(',')) total += 1;
        return s.Length + total;
    }
    public static int Typed(ref string? s, int[] items, (int, int)[] pairs, Point[] points)
    {
        if (s == null) return 0;
        long sum = 0;
        var n = 0;
        foreach (long item in items) sum += item;
        foreach (int? item in items) n += 1;
        foreach (object item in items) n += 1;
        foreach (var (a, b) in pairs) n += s.Length;
        foreach (var (_, _) in points) n += 1;
        foreach ((Wrapper _, int _) in points) n += 1;
        return s.Length + n + (int)sum;
    }
    public static int InnerWhile(ref string? s, int[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var item in items)
        {
            var m = 0;
            while (m < 2) { total += item; m++; }
        }
        return s.Length + total;
    }
    public static string Run()
    {
        string? text = "abc";
        var items = new[] { 1, 2 };
        return Arrays(ref text, items) + "," + Strings(ref text, "xy", new StringBuilder("q")) + "," +
            Typed(ref text, items, new[] { (1, 2) }, new[] { new Point(3, 4) }) + "," + InnerWhile(ref text, items);
    }
}`)
        Assert.DoesNotContain("s!!", printed)
    }

    /// The loop variable's prelude runs before every body run (ADR-0213 table T5): a `Deconstruct` of a record, a
    /// user-defined conversion of a typed loop variable, a tuple conversion (rebuilt element by element) and the
    /// unwrapping of a nullable value run code, so the fact ends even over an array.
    @Fact
    func RefParameter_ReadAfterAForEachWhosePreludeRunsUserCode_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using System.Collections.Generic;
public record Point(int X, int Y);
public sealed class Wrapper
{
    public int V;
    public static implicit operator Wrapper(int v) => new Wrapper { V = v };
}
public class Demo
{
    public static int Records(ref string? s, Point[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (x, y) in items) total += s.Length;
        return s.Length + total;
    }
    public static int FirstOfRecords(ref string? s, Point[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (x, _) in items) total += 1;
        return s.Length + total;
    }
    public static int Pairs(ref string? s, Dictionary<int, int> items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (k, v) in items) total += v;
        return s.Length + total;
    }
    public static int Converted(ref string? s, int[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (Wrapper w in items) total += w.V;
        return s.Length + total;
    }
    public static int Tuples(ref string? s, (int, int)[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach ((long, long) pair in items) total += s.Length + 1;
        return s.Length + total;
    }
    public static int Unwrapped(ref string? s, int?[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (int item in items) total += item;
        return s.Length + total;
    }
    public static string Run()
    {
        string? text = "abc";
        return Records(ref text, new[] { new Point(1, 2) }) + "," + FirstOfRecords(ref text, new[] { new Point(5, 6) }) +
            "," + Pairs(ref text, new Dictionary<int, int> { [1] = 2 }) + "," + Converted(ref text, new[] { 7 }) + "," +
            Tuples(ref text, new[] { (1, 2) }) + "," + Unwrapped(ref text, new int?[] { 3 });
    }
}`)
        Assert.Contains("total += s!!.Length\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("total += s!!.Length + 1", printed)
        Assert.Equal(8, Regex.Matches(printed, `s!!`).Count)
    }

    /// gsc scans a loop's region without types, so a `for ... in` nested in a loop counts as an iteration that runs
    /// user code for the enclosing loop, whatever its collection (ADR-0213 section 9). The fact ends at the entry of
    /// the enclosing loop and stays removed after it. A guard inside the enclosing loop is after that entry, so only
    /// the inner loop counts for its reads. A `do ... while (false)` has no back edge, so gsc does not apply its region
    /// (`HeaderIsLiteralFalse`).
    @Fact
    func RefParameter_ReadAroundALoopThatHoldsAForEach_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using System.Collections.Generic;
public sealed class Box
{
    public int F;
}
public class Demo
{
    public static int NestedArrays(ref string? s, int[] outer, int[] inner)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var o in outer)
        {
            total += s.Length;
            foreach (var i in inner) total += i;
        }
        return s.Length + total;
    }
    public static int WhileLoop(ref string? s, int[] inner)
    {
        if (s == null) return 0;
        var total = 0;
        var n = 0;
        while (n < 2)
        {
            total += s.Length;
            foreach (var i in inner) total += i;
            n++;
        }
        return total;
    }
    public static int ForLoop(ref string? s, int[] inner)
    {
        if (s == null) return 0;
        var total = 0;
        for (var n = 0; n < 2; n++)
        {
            foreach (var i in inner) total += i;
        }
        return s.Length + total;
    }
    public static int DoLoop(ref string? s, int[] inner)
    {
        if (s == null) return 0;
        var total = 0;
        var n = 0;
        do
        {
            foreach (var i in inner) total += i;
            n++;
        } while (n < 2);
        return s.Length + total;
    }
    public static int DoOnce(ref string? s, int[] inner, Box box)
    {
        if (s == null) return 0;
        var total = 0;
        do
        {
            total += s.Length + 3;
            box.F = 1;
            foreach (var i in inner) total += i;
        } while (false);
        return s.Length + total;
    }
    public static int DoOnceThenRead(ref string? s, int[] inner)
    {
        if (s == null) return 0;
        var total = 0;
        do
        {
            foreach (var i in inner) total += i;
        } while (false);
        return total + s.Length;
    }
    public static int GuardInLoopOverArrays(ref string? s, int[] outer, int[] inner)
    {
        var total = 0;
        foreach (var o in outer)
        {
            if (s == null) continue;
            foreach (var i in inner) total += i;
            total += s.Length + 1;
        }
        return total;
    }
    public static int GuardInLoopOverList(ref string? s, int[] outer, List<int> inner)
    {
        var total = 0;
        foreach (var o in outer)
        {
            if (s == null) continue;
            foreach (var i in inner) total += i;
            total += s.Length + 2;
        }
        return total;
    }
    public static string Run()
    {
        string? text = "abc";
        var inner = new[] { 2 };
        return NestedArrays(ref text, new[] { 1 }, inner) + "," + WhileLoop(ref text, inner) + "," +
            ForLoop(ref text, inner) + "," + DoLoop(ref text, inner) + "," + DoOnce(ref text, inner, new Box()) + "," +
            DoOnceThenRead(ref text, inner) + "," +
            GuardInLoopOverArrays(ref text, new[] { 1 }, inner) + "," +
            GuardInLoopOverList(ref text, new[] { 1 }, new List<int> { 2 });
    }
}`)
        Assert.Contains("total += s.Length + 1", printed)
        Assert.Contains("total += s!!.Length + 2", printed)
        Assert.Contains("total += s.Length + 3", printed)
        Assert.Contains("return total + s.Length", printed)
        Assert.Equal(7, Regex.Matches(printed, `s!!`).Count)
    }

    /// gsc binds the `else` branch of an `if` from the state before the `then` branch (#5650, #5654), so a loop or a
    /// field write in the `then` branch leaves a read in the `else` branch bare.
    /// ADR-0208 R4 also isolates switch section bodies when no goto can enter another section.
    @Fact
    func RefParameter_ReadInAnElseAfterALoopInTheThenBranch_StaysBare() {
        let printed = AssertRunsLikeCSharp(`
using System.Collections.Generic;
public sealed class Box
{
    public int F;
}
public class Demo
{
    public static int Loop(ref string? s, List<int> items, bool flag)
    {
        if (s == null) return 0;
        var total = 0;
        if (flag)
        {
            foreach (var item in items) total += item;
        }
        else if (total == 0)
        {
            return s.Length + 1;
        }
        else
        {
            return s.Length + 2;
        }
        return total;
    }
    public static int Write(ref string? s, Box box, bool flag)
    {
        if (s == null) return 0;
        if (flag)
        {
            box.F = 1;
        }
        else
        {
            return s.Length + 3;
        }
        return box.F;
    }
    public static int Section(ref string? s, List<int> items, int k)
    {
        if (s == null) return 0;
        var total = 0;
        switch (k)
        {
            case 1:
                foreach (var item in items) total += item;
                break;
            default:
                return s.Length + 4;
        }
        return total;
    }
    public static int ForwardGotoExit(ref string? s, Box box, bool flag)
    {
        if (s == null) return 0;
        if (flag)
        {
            box.F = 1;
            goto Done;
        }
        else
        {
        Unused:
            return s.Length + 5;
        }
    Done:
        return box.F;
    }
    public static int ForwardGotoInThen(ref string? s, Box box, bool flag)
    {
        if (s == null) return 0;
        if (flag)
        {
            box.F = 1;
            goto Step;
        Step:
            return 1;
        }
        else
        {
            return s.Length + 7;
        }
    }
    public static int BackwardGotoInThen(ref string? s, Box box, bool flag, bool step)
    {
        if (s == null) return 0;
        if (flag)
        {
        Loop:
            box.F = 1;
            if (step)
            {
                step = false;
                goto Loop;
            }
        }
        else
        {
            return s.Length + 8;
        }
        return box.F;
    }
    public static int MergedBackwardGotoSpan(ref string? s, Box box, bool flag, bool a, bool b)
    {
        if (s == null) return 0;
    L1:
        if (a)
        {
            a = false;
            goto L1;
        }
        if (flag)
        {
            box.F = 1;
        }
        else
        {
            return s.Length + 9;
        }
    L2:
        if (b)
        {
            b = false;
            goto L2;
        }
        return box.F;
    }
    public static int LoweredGotoCase(ref string? s, Box box, bool flag, int k)
    {
        if (s == null) return 0;
        switch (k)
        {
            case 0:
                break;
            default:
                goto case 0;
        }
        if (flag)
        {
            box.F = 1;
        }
        else
        {
            return s.Length + 10;
        }
        switch (k)
        {
            case 0:
                break;
            default:
                goto case 0;
        }
        return box.F;
    }
    public static int DefaultFirstSection(ref string? s, Box box, int k)
    {
        if (s == null) return 0;
        switch (k)
        {
            default:
                box.F = 1;
                break;
            case 1:
                return s.Length + 6;
        }
        return box.F;
    }
    public static string Run()
    {
        string? text = "abc";
        var items = new List<int> { 1 };
        return Loop(ref text, items, false) + "," + Loop(ref text, items, true) + "," +
            Write(ref text, new Box(), false) + "," + Section(ref text, items, 2) + "," +
            ForwardGotoExit(ref text, new Box(), false) + "," + ForwardGotoInThen(ref text, new Box(), false) + "," +
            BackwardGotoInThen(ref text, new Box(), false, false) + "," +
            MergedBackwardGotoSpan(ref text, new Box(), false, false, false) + "," +
            LoweredGotoCase(ref text, new Box(), false, 1) + "," +
            DefaultFirstSection(ref text, new Box(), 1);
    }
}`)
        Assert.Contains("return s.Length + 1", printed)
        Assert.Contains("return s.Length + 2", printed)
        Assert.Contains("return s.Length + 3", printed)
        Assert.Contains("return s.Length + 4", printed)
        Assert.Contains("return s.Length + 5", printed)
        Assert.Contains("return s.Length + 6", printed)
        Assert.Contains("return s.Length + 7", printed)
        Assert.Contains("return s.Length + 8", printed)
        Assert.Contains("return s!!.Length + 9", printed)
        Assert.Contains("return s.Length + 10", printed)
    }

    /// The collection of a `for ... in` and the initializer of a `for` run once, before the loop's region, so effects
    /// in the loop do not reach a read in them (ADR-0213 table T5). A collection read in a loop that is nested in
    /// another loop is in the enclosing loop's region.
    @Fact
    func RefParameter_ReadInALoopCollectionOrInitializer_IsAssertedOnlyInAnEnclosingLoop() {
        let printed = AssertRunsLikeCSharp(`
using System.Collections.Generic;
public sealed class Box
{
    public int F;
}
public class Demo
{
    static List<int> Make(int n) => new List<int> { n, 2 };
    public static int Collection(ref string? s, Box box)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var item in Make(s.Length)) { total += item; box.F = item; }
        return total;
    }
    public static int Initializer(ref string? s, int[] inner)
    {
        if (s == null) return 0;
        var total = 0;
        for (var n = s.Length; n < 5; n++)
        {
            foreach (var i in inner) total += i;
        }
        return total;
    }
    public static int Nested(ref string? s, int[] outer)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var o in outer)
        {
            foreach (var item in Make(s.Length + 1)) total += item;
        }
        return total;
    }
    public static string Run()
    {
        string? text = "abc";
        return Collection(ref text, new Box()) + "," + Initializer(ref text, new[] { 2 }) + "," +
            Nested(ref text, new[] { 1 });
    }
}`)
        Assert.Contains("Make(s.Length)", printed)
        Assert.Contains("Make(s!!.Length + 1)", printed)
        Assert.Equal(1, Regex.Matches(printed, `s!!`).Count)
    }

    /// Issue #5692 (1): a numeric conversion in a loop that cs2gs emits as `T(x)` counts as a construction call in
    /// gsc's region scanner (`CallIsIndirect`), which removes a by-reference fact at loop entry and after the loop.
    /// Outside a loop, or after a guard inside the same loop body, the fact stays.
    @Fact
    func RefParameter_ReadAroundALoopWithAConversionCall_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public class Base { public int V = 1; }
public sealed class Derived : Base { }
public partial class Demo
{
    static partial void ElidedTrace(long n);
    public static void TakeUint(uint value) { }
    public static int ForEachCharToInt(ref string? s, string text)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var c in text) total += c;
        return s.Length + total;
    }
    public static long WhileIntToLong(ref string? s)
    {
        if (s == null) return 0;
        long total = 0;
        var i = 0;
        while (i < 2)
        {
            total += s.Length;
            i++;
        }
        return total + s.Length;
    }
    public static int ArrayLengthLongToInt(ref string? s, long n)
    {
        if (s == null) return 0;
        var total = 0;
        var i = 0;
        while (i < 1)
        {
            var buf = new byte[n];
            total += buf.Length;
            i++;
        }
        return s.Length + total;
    }
    public static int CovariantArrayInLoop(ref string? s, string[] strings)
    {
        if (s == null) return 0;
        var total = 0;
        var i = 0;
        while (i < 1)
        {
            object[] copy = strings;
            total += copy.Length;
            i++;
        }
        return s.Length + total + 2;
    }
    public static int CoalesceAssignCovariantArrayInLoop(ref string? s, string[] strings)
    {
        if (s == null) return 0;
        object[]? copy = null;
        var i = 0;
        while (i < 1)
        {
            copy ??= strings;
            i++;
        }
        return s.Length + copy!.Length + 3;
    }
    static void Touch<T>() { }
    public static int BareGenericStaticCallInLoop(ref string? s)
    {
        if (s == null) return 0;
        var i = 0;
        while (i < 1)
        {
            Touch<int>();
            i++;
        }
        return s.Length + 4;
    }
    public static int ConditionalReferenceUpcastInLoop(ref string? s, Derived d, Base b, bool flag)
    {
        if (s == null) return 0;
        var total = 0;
        var i = 0;
        while (i < 1)
        {
            var picked = flag ? d : b;
            total += picked.V;
            i++;
        }
        return s.Length + total + 5;
    }
    public static int SwitchReferenceUpcastInLoop(ref string? s, Derived d, Base b, int k)
    {
        if (s == null) return 0;
        var total = 0;
        var i = 0;
        while (i < 1)
        {
            var picked = k switch { 0 => d, _ => b };
            total += picked.V;
            i++;
        }
        return s.Length + total + 6;
    }
    public static int CollectionElementConversionInLoop(ref string? s)
    {
        if (s == null) return 0;
        var total = 0;
        var i = 0;
        while (i < 1)
        {
            byte[] bytes = [1];
            total += bytes.Length;
            i++;
        }
        return s.Length + total + 8;
    }
    public static int RelationalPatternConversionInLoop(ref string? s, byte b)
    {
        if (s == null) return 0;
        var total = 0;
        var i = 0;
        while (i < 1)
        {
            if (b is > 1) total++;
            if (b is 2) total++;
            i++;
        }
        return s.Length + total + 9;
    }
    public static int CoalesceAssignNumericInLoop(ref string? s)
    {
        if (s == null) return 0;
        long? n = null;
        var i = 0;
        while (i < 1)
        {
            n ??= 1;
            i++;
        }
        return n == null ? 0 : s.Length + 10;
    }
    public static uint UnsignedReturnControl(ref string? s, bool exitEarly)
    {
        if (s == null) return 0;
        var i = 0;
        while (i < 1)
        {
            if (exitEarly) return 0;
            i++;
        }
        return (uint)s.Length;
    }
    public static int ElidedPartialAndUnsignedLiteralControls(ref string? s, byte b)
    {
        if (s == null) return 0;
        var i = 0;
        while (i < 1)
        {
            ElidedTrace((long)i);
            Demo.TakeUint(5);
            switch (b)
            {
                case > 1:
                    break;
            }
            i++;
        }
        return s.Length + 7;
    }
    public static int GuardInsideLoop(ref string? s, string text)
    {
        var total = 0;
        foreach (var c in text)
        {
            if (s == null) continue;
            total += c;
            total += s.Length + 1;
        }
        return total;
    }
    public static long OutsideLoop(ref string? s, int n)
    {
        if (s == null) return 0;
        long wide = (long)n;
        return s.Length + wide;
    }
    public static string Run()
    {
        string? text = "abc";
        return ForEachCharToInt(ref text, "xy") + "," + WhileIntToLong(ref text) + "," +
            ArrayLengthLongToInt(ref text, 2L) + "," + CovariantArrayInLoop(ref text, new[] { "a" }) + "," +
            CoalesceAssignCovariantArrayInLoop(ref text, new[] { "b" }) + "," +
            BareGenericStaticCallInLoop(ref text) + "," +
            ConditionalReferenceUpcastInLoop(ref text, new Derived(), new Base(), true) + "," +
            SwitchReferenceUpcastInLoop(ref text, new Derived(), new Base(), 0) + "," +
            CollectionElementConversionInLoop(ref text) + "," +
            RelationalPatternConversionInLoop(ref text, 3) + "," +
            CoalesceAssignNumericInLoop(ref text) + "," +
            UnsignedReturnControl(ref text, false) + "," +
            ElidedPartialAndUnsignedLiteralControls(ref text, 3) + "," +
            GuardInsideLoop(ref text, "z") + "," + OutsideLoop(ref text, 4);
    }
}`)
        Assert.Contains("return s!!.Length + total\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("total += int64(s!!.Length)", printed)
        Assert.Contains("return total + int64(s!!.Length)", printed)
        Assert.Contains("[int32(n)]uint8", printed)
        Assert.Contains("cast[[]object](strings)", printed)
        Assert.Contains("return s!!.Length + total + 2", printed)
        Assert.Contains("return s!!.Length + copy!!.Length + 3", printed)
        Assert.Contains("return s!!.Length + 4", printed)
        Assert.Contains("return s!!.Length + total + 5", printed)
        Assert.Contains("return s!!.Length + total + 6", printed)
        Assert.Contains("return s!!.Length + total + 8", printed)
        Assert.Contains("return s!!.Length + total + 9", printed)
        Assert.Contains("s!!.Length + 10", printed)
        Assert.Contains("return uint32(s.Length)", printed)
        Assert.Contains("return s.Length + 7", printed)
        Assert.Contains("total += s.Length + 1", printed)
        Assert.Contains("return int64(s.Length) + wide", printed)
    }

    /// Issue #5692 (2): gsc's region scanner gives no origin to the variables of a deconstructing `for (a, b) in items`
    /// loop, so using a deconstructed variable (or an inferred copy or pattern-bound alias of it) in the body removes
    /// a by-reference fact at loop entry and after it. Unused deconstructed variables, an unused `var` or same-typed
    /// copy, a dropped `_ = a` discard statement, and a pure type test keep the fact.
    @Fact
    func RefParameter_ReadAroundAForEachThatUsesADeconstructedLoopVariable_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public class Demo
{
    public static int AfterLoop(ref string? s, (int, int)[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (a, b) in items) total += a + b;
        return s.Length + total;
    }
    public static int InsideLoop(ref string? s, (int, int)[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (a, b) in items) total += a + s.Length;
        return total;
    }
    public static int UsedThroughCopy(ref string? s, (int, int)[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (a, b) in items)
        {
            var copy = a;
            total += copy;
        }
        return s.Length + total + 2;
    }
    public static int UsedThroughPatternAlias(ref string? s, (int, int)[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (a, b) in items)
        {
            if (a is var copy) total += copy;
        }
        return s.Length + total + 5;
    }
    public static int UsedThroughTupleCopy(ref string? s, (int, int)[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (a, b) in items)
        {
            var pair = (a, b);
            total += pair.a;
        }
        return s.Length + total + 6;
    }
    public static int UnusedVariables(ref string? s, (int, int)[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (a, b) in items) total += s.Length + 1;
        return s.Length + total;
    }
    static void Touch(ref int value) { }
    public static int UnusedCopyOnly(ref string? s, (int, int)[] items)
    {
        if (s == null) return 0;
        foreach (var (a, b) in items)
        {
            _ = a;
            var copy = a;
            _ = copy;
            Demo.Touch(ref copy);
            var unusedPair = (a, b);
            _ = unusedPair;
            int typedCopy = b;
            if (b is var unusedAlias)
            {
                _ = unusedAlias;
            }
            for (var i = 0; i < 1; i++, _ = a)
            {
            }
        }
        return s.Length + 3;
    }
    public static int PureTypeTestOnly(ref string? s, (object, int)[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (a, b) in items)
        {
            if (a is string) total += 1;
        }
        return s.Length + total + 4;
    }
    public static string Run()
    {
        string? text = "abc";
        var items = new[] { (1, 2) };
        return AfterLoop(ref text, items) + "," + InsideLoop(ref text, items) + "," +
            UsedThroughCopy(ref text, items) + "," + UsedThroughPatternAlias(ref text, items) + "," +
            UsedThroughTupleCopy(ref text, items) + "," +
            UnusedVariables(ref text, items) + "," + UnusedCopyOnly(ref text, items) + "," +
            PureTypeTestOnly(ref text, new (object, int)[] { ("x", 1) });
    }
}`)
        Assert.Contains("return s!!.Length + total\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("total += a + s!!.Length", printed)
        Assert.Contains("return s!!.Length + total + 2", printed)
        Assert.Contains("return s!!.Length + total + 5", printed)
        Assert.Contains("return s!!.Length + total + 6", printed)
        Assert.Contains("total += s.Length + 1", printed)
        Assert.Contains("return s.Length + 3", printed)
        Assert.Contains("return s.Length + total + 4", printed)
        Assert.Equal(5, Regex.Matches(printed, `s!!`).Count)
    }

    /// Issue #5692 (3): gsc's region scanner cannot resolve the element origin of an untyped `for x in call()` loop
    /// when an extension method of that name can bind (`"a,b".Split(',')` or a source extension on `ShadowedBox`),
    /// when a source generic type's method returns `T[]` (`GenericBox<int>.GetItems()`), when type arguments are
    /// emitted on the call (`box.Collide(new Unrelated())`), or when the call is an unqualified static class method
    /// (`Parts()`), so reading a member of `x` in the body counts as a read on an untyped receiver (W5) and removes a
    /// by-reference fact. Over a parameter slice `parts`, a qualified static call `Box.Parts()` or
    /// `QualifiedNs.StaticHolder.MakeSeed()`, an instance member call `box.InstanceParts()` or inferred generic
    /// `box.InstanceParts(1)` or chained `box.Self().InstanceParts(1)`, a source extension `word.WordParts()` or
    /// `values.Entries()`, or a pure string concatenation, the fact stays.
    @Fact
    func RefParameter_ReadAroundAForEachOverACallWhoseLoopVariableIsRead_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
namespace System
{
    public static class MergedSystemExtensions
    {
        public static void InstanceParts(this int value) { }
    }
}
namespace OtherNs
{
    public static class ShadowExtensions
    {
        public static void ShadowedParts(this ShadowedBox box, int n) { }
    }
#pragma warning disable CS8618
    public static class StaticHolder
    {
        public static string[] Seed;
        public static Box Instance;
        public static string[] MakeSeed(string[] seed) => seed;
    }
#pragma warning restore CS8618
}
public interface IParent
{
    T Parts<T>(T value);
}
public interface IChild : IParent
{
    string[] Parts();
}
public sealed class ChildImpl : IChild
{
    public T Parts<T>(T value) => value;
    public string[] Parts() => new[] { "f" };
}
public sealed class GenericBox<T>
{
#pragma warning disable CS8618
    public System.Collections.Generic.List<T> StoredList;
#pragma warning restore CS8618
    public T[] GetItems(T item) => new[] { item };
    public System.Collections.Generic.List<T> Items() => StoredList;
}
public sealed class SelectBox
{
    public string[] Select() => new[] { "g" };
}
public sealed class Holder
{
    public object? Tag = "t";
    public Box Child = new Box();
}
public sealed class Unrelated { }
public sealed class DisposableBox : System.IDisposable
{
    public void Dispose() { }
    public string[] ConstrainedParts() => new[] { "z" };
}
public sealed class ChildA
{
    public string Child = "x";
}
public sealed class ChildB
{
    public int Child = 1;
}
public sealed class MixedBox
{
    public string[] MixedParts() => new[] { "x" };
    public int[] MixedParts(int n) => new[] { 1 };
    public ChildA[] MixedChildren() => new[] { new ChildA() };
    public ChildB[] MixedChildren(int n) => new[] { new ChildB() };
    public Box MixedSelf() => new Box();
    public Unrelated MixedSelf(int n) => new Unrelated();
}
public interface IBox
{
    void Ping();
}
public static class WordExtensions
{
    public static string[] WordParts(this string text) => new[] { text };
    public static string[] WordParts<T>(this string text, T tag) => new[] { text };
    public static void WordParts(this Unrelated other) { }
    public static void InstanceParts(this Unrelated other) { }
    public static void InstanceParts<T>(this T value) where T : System.IDisposable { }
    public static void ConstrainedParts<T>(this T value) where T : System.IDisposable { }
    public static int[] Entries(this int[] values) => values;
    public static string[] GenericArrayParts<T>(this T[] values) => new[] { "p" };
    public static string[] NewableParts<T>(this System.Collections.Generic.List<T> values) where T : new() => new[] { "r" };
    public static void NewablePing<T>(this T[] values) where T : new() { }
    public static string[] LibExtParts(this OtherNs.LibBox box) => new[] { "n" };
}
public sealed class Box : IBox
{
    public static string[] Parts() => new[] { "a", "b" };
    public Box Self() => this;
    public void Ping() { }
    public string[] InstanceParts() => new[] { "c" };
    public string[] InstanceParts<T>(T tag) => new[] { "c" };
    public string[] Collide(System.Collections.Generic.List<object> tags) => new[] { "k" };
    public string[] Collide<T>(System.Collections.Generic.List<T> tags) => new[] { "k" };
}
public sealed class ShadowedBox
{
    public string[] ShadowedParts() => new[] { "e" };
}
public class Demo
{
    static string[] UnqualifiedParts() => new[] { "d" };
    public static int AfterCallCollection(ref string? s)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in "a,b".Split(',')) total += part.Length;
        return s.Length + total;
    }
    public static int InsideCallCollection(ref string? s)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in "a,b".Split(','))
        {
            total += part.Length;
            total += s.Length;
        }
        return total;
    }
    public static int OverUnqualifiedStaticCall(ref string? s)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in UnqualifiedParts()) total += part.Length;
        return s.Length + total + 3;
    }
    public static int OverSourceShadowedMemberCall(ref string? s, ShadowedBox shadowed)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in shadowed.ShadowedParts()) total += part.Length;
        return s.Length + total + 5;
    }
    public static int OverInheritedInterfaceGenericOverload(ref string? s, IChild child)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in child.Parts()) total += part.Length;
        return s.Length + total + 6;
    }
    public static int OverConstructedSourceGenericReturn(ref string? s, GenericBox<string> genericBox)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in genericBox.GetItems("h")) total += part.Length;
        return s.Length + total + 7;
    }
    public static int OverSynthesizedLinqImportConflict(
        ref string? s,
        SelectBox selectBox,
        System.Linq.IOrderedEnumerable<int>? unused = null
    )
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in selectBox.Select()) total += part.Length;
        return s.Length + total + 8;
    }
    public static int OverSynthesizedGenericCollisionCall(
        ref string? s,
        Box box,
        System.Collections.Generic.List<Unrelated> tags
    )
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in box.Collide(tags)) total += part.Length;
        return s.Length + total + 9;
    }
    public static int ConditionalCopyReceiverCall(ref string? s, Box a, Box b, bool flag)
    {
        if (s == null) return 0;
        var i = 0;
        while (i < 1)
        {
            var copy = flag ? a : b;
            copy.Ping();
            i++;
        }
        return s.Length + 10;
    }
    public static int TypeTestedCopyReceiverCall(ref string? s, Box box)
    {
        if (s == null) return 0;
        var i = 0;
        while (i < 1)
        {
            var copy = box;
            if (copy is Box) copy.Ping();
            i++;
        }
        return s.Length + 14;
    }
    public static int OverMixedReturnOverloads(ref string? s, MixedBox mixed)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in mixed.MixedParts()) total += part.Length;
        return s.Length + total + 11;
    }
    public static int OverMixedChainedReceiverOverloads(ref string? s, MixedBox mixed)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in mixed.MixedSelf().InstanceParts()) total += part.Length;
        return s.Length + total + 12;
    }
    public static int OverMixedChainedFieldOverloads(ref string? s, MixedBox mixed)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in mixed.MixedChildren()) total += part.Child.Length;
        return s.Length + total + 20;
    }
    public static int OverMixedReturnEqualityControl(ref string? s, MixedBox mixed)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in mixed.MixedParts())
        {
            if (part == "x") total += 1;
        }
        return s.Length + total + 21;
    }
    public static int ForInitializerMemberTypeTestControl(ref string? s, Holder holder)
    {
        if (s == null) return 0;
        var i = 0;
        for (var unused = holder.Tag is string; i < 1; i++, i++)
        {
            holder.Child.Ping();
        }
        return s.Length + 22;
    }
    public static int OverConstrainedExtensionConflict(ref string? s, DisposableBox dbox)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in dbox.ConstrainedParts()) total += part.Length;
        return s.Length + total + 13;
    }
    public static int ExplicitGenericLocalReceiverCall(
        ref string? s,
        System.Collections.Generic.Stack<Box> stack
    )
    {
        if (s == null) return 0;
        var i = 0;
        while (i < 1)
        {
            System.Collections.Generic.Stack<Box>? copy = stack;
            copy.Peek().Ping();
            i++;
        }
        return s.Length + 17;
    }
    public static int MemberTypeTestInvalidatesMemberReceiverCall(ref string? s, Holder holder)
    {
        if (s == null) return 0;
        var i = 0;
        while (i < 1)
        {
            if (holder.Tag is string) holder.Child.Ping();
            i++;
        }
        return s.Length + 18;
    }
    public static int ForHeaderConditionalInitializerControl(ref string? s, Box a, Box b, bool flag)
    {
        if (s == null) return 0;
        var i = 0;
        for (var copy = flag ? a : b; i < 1; i++, i++)
        {
            copy.Ping();
        }
        return s.Length + 19;
    }
    public static int ConstrainedReceiverControl<T>(ref string? s, T constrainedBox, Holder holder) where T : class, IBox
    {
        if (s == null) return 0;
        var run = true;
        while (run)
        {
            if (holder.Tag is string) constrainedBox.Ping();
            run = false;
        }
        return s.Length + 15;
    }
    public static int NewableAndStaticExtensionControl<T>(
        ref string? s,
        T[] newableItems,
        System.Collections.Generic.List<T> newableList,
        System.Collections.Generic.List<T>[] lists,
        string word
    ) where T : new()
    {
        if (s == null) return 0;
        var run = true;
        while (run)
        {
            newableItems.NewablePing();
            run = false;
        }
        var total = 0;
        foreach (var list in lists) list.Clear();
        foreach (var part in newableList.NewableParts()) total += part.Length;
        foreach (var part in WordExtensions.WordParts(word)) total += part.Length;
        return s.Length + total + 16;
    }
    public static int OverParameterArray(ref string? s, string[] parts)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in parts) total += part.Length;
        return s.Length + total + 1;
    }
    public static int OverResolvableMemberCalls(
        ref string? s,
        Box box,
        string word,
        int[] values,
        string[] parts,
        GenericBox<int> genericIntBox,
        OtherNs.LibBox libBox
    )
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in Box.Parts()) total += part.Length;
        foreach (var part in box.InstanceParts()) total += part.Length;
        foreach (var part in box.InstanceParts(1)) total += part.Length;
        foreach (var part in box.Self().InstanceParts(1)) total += part.Length;
        foreach (var part in word.WordParts()) total += part.Length;
        foreach (var entry in values.Entries()) total += entry;
        foreach (var part in values.GenericArrayParts()) total += part.Length;
        foreach (var part in libBox.LibParts()) total += part.Length;
        foreach (var part in libBox.LibExtParts()) total += part.Length;
        foreach (var part in OtherNs.StaticHolder.Seed) total += part.Length;
        foreach (var part in OtherNs.StaticHolder.MakeSeed(parts)) total += part.Length;
        foreach (var c in string.Empty) { if (c == 'a') total += 1; }
        foreach (var c in string.Intern("x"))
        {
            var copyBox = box;
            copyBox.Ping();
            Box? annotatedCopy = box;
            annotatedCopy.Ping();
            genericIntBox.Items().Clear();
            System.String.Intern("x");
            box.Self().Ping();
            OtherNs.StaticHolder.Instance.Ping();
            if (c == 'x') total += 1;
        }
        return s.Length + total + 2;
    }
    public static int OverPureStringConcatenation(ref string? s)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var c in "a" + "b")
        {
            if (c == 'a') total += 1;
        }
        return s.Length + total + 4;
    }
    public static int OverImportedByRefMemberStepCall(ref string? s, OtherNs.LibBox libBox, ChildB holder)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var part in libBox.LibParts(in holder.Child)) total += part.Length;
        return s.Length + total + 23;
    }
    public static string Run()
    {
        OtherNs.StaticHolder.Seed = new[] { "q" };
        OtherNs.StaticHolder.Instance = new Box();
        var genericIntBox = new GenericBox<int> { StoredList = new System.Collections.Generic.List<int>() };
        var stack = new System.Collections.Generic.Stack<Box>();
        stack.Push(new Box());
        string? text = "abc";
        return AfterCallCollection(ref text) + "," + InsideCallCollection(ref text) + "," +
            OverUnqualifiedStaticCall(ref text) + "," +
            OverSourceShadowedMemberCall(ref text, new ShadowedBox()) + "," +
            OverInheritedInterfaceGenericOverload(ref text, new ChildImpl()) + "," +
            OverConstructedSourceGenericReturn(ref text, new GenericBox<string>()) + "," +
            OverSynthesizedLinqImportConflict(ref text, new SelectBox()) + "," +
            OverSynthesizedGenericCollisionCall(ref text, new Box(), new System.Collections.Generic.List<Unrelated>()) + "," +
            ConditionalCopyReceiverCall(ref text, new Box(), new Box(), true) + "," +
            TypeTestedCopyReceiverCall(ref text, new Box()) + "," +
            OverMixedReturnOverloads(ref text, new MixedBox()) + "," +
            OverMixedChainedReceiverOverloads(ref text, new MixedBox()) + "," +
            OverMixedChainedFieldOverloads(ref text, new MixedBox()) + "," +
            OverMixedReturnEqualityControl(ref text, new MixedBox()) + "," +
            ForInitializerMemberTypeTestControl(ref text, new Holder()) + "," +
            OverConstrainedExtensionConflict(ref text, new DisposableBox()) + "," +
            ExplicitGenericLocalReceiverCall(ref text, stack) + "," +
            MemberTypeTestInvalidatesMemberReceiverCall(ref text, new Holder()) + "," +
            ForHeaderConditionalInitializerControl(ref text, new Box(), new Box(), true) + "," +
            ConstrainedReceiverControl(ref text, new Box(), new Holder()) + "," +
            NewableAndStaticExtensionControl(
                ref text,
                new[] { new Box() },
                new System.Collections.Generic.List<Box> { new Box() },
                new[] { new System.Collections.Generic.List<Box>() },
                "hi"
            ) + "," +
            OverParameterArray(ref text, new[] { "a", "b" }) + "," +
            OverResolvableMemberCalls(
                ref text,
                new Box(),
                "hi",
                new[] { 1 },
                new[] { "q" },
                genericIntBox,
                new OtherNs.LibBox()
            ) + "," +
            OverPureStringConcatenation(ref text) + "," +
            OverImportedByRefMemberStepCall(ref text, new OtherNs.LibBox(), new ChildB());
    }
}`, library: `
namespace OtherNs
{
    public class LibBox
    {
        public string[] LibParts() => new[] { "m" };
        public string[] LibParts(in int n) => new[] { "m" };
        protected void LibParts(int n) { }
        protected void LibExtParts() { }
    }
    public static class LibBoxExtensions
    {
        public static void LibParts(this LibBox box, string unused) { }
    }
}`)
        Assert.Contains("return s.Length + total\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("total += s.Length", printed)
        Assert.Contains("return s!!.Length + total + 3", printed)
        Assert.Contains("return s.Length + total + 5", printed)
        Assert.Contains("return s!!.Length + total + 6", printed)
        Assert.Contains("return s!!.Length + total + 7", printed)
        Assert.Contains("return s.Length + total + 8", printed)
        Assert.Contains("return s!!.Length + total + 9", printed)
        Assert.Contains("return s!!.Length + 10", printed)
        Assert.Contains("return s!!.Length + 14", printed)
        Assert.Contains("return s!!.Length + total + 11", printed)
        Assert.Contains("return s!!.Length + total + 12", printed)
        Assert.Contains("return s!!.Length + total + 20", printed)
        Assert.Contains("return s.Length + total + 21", printed)
        Assert.Contains("return s.Length + 22", printed)
        Assert.Contains("return s.Length + total + 13", printed)
        Assert.Contains("return s!!.Length + 17", printed)
        Assert.Contains("return s!!.Length + 18", printed)
        Assert.Contains("return s.Length + 19", printed)
        Assert.Contains("return s.Length + 15", printed)
        Assert.Contains("return s.Length + total + 16", printed)
        Assert.Contains("return s.Length + total + 1", printed)
        Assert.Contains("return s.Length + total + 2", printed)
        Assert.Contains("return s.Length + total + 4", printed)
        Assert.Contains("return s!!.Length + total + 23", printed)
        Assert.Equal(12, Regex.Matches(printed, `s!!`).Count)
    }

    /// Issue #5697: gsc narrows after a `do ... while`, `while`, or `for` loop whose exit condition proves non-null
    /// when the loop has no emitted `break` (`RecordLoopExitFacts`, ADR-0213 R7 (f)). A loop with a `break` (targeting
    /// it, a nested loop, a non-terminal switch break, a lowered `goto case` to an empty arm, or inside a lambda), a
    /// loop whose condition lowers to a hoisted `break` guard, a loop in a function with a lowered `goto case` or a
    /// synthesized `forContinue` label, or a loop whose condition runs an accessor or triggers an enclosing catch
    /// filter that writes the variable does not get the loop-exit fact on main, so its read after the loop stays
    /// asserted.
    @Fact
    func RefParameter_ReadAfterALoopWhoseExitConditionProvesNonNull_StaysBare() {
        let printed = AssertRunsLikeCSharp(`
using System;
public sealed class FieldValue
{
    public int Value = 1;
}
public sealed class ComputedValue
{
    public int Value => 1;
}
public sealed class Box
{
    public int F;
    public bool Again() => false;
    public static bool AgainNamed(bool repeat) => repeat;
    public FieldValue Pick() => new FieldValue();
    public ComputedValue Pick(int n) => new ComputedValue();
}
public sealed class Holder
{
    public object? Tag = "t";
    public Box Child = new Box();
}
public sealed class HidingHolder
{
    public new Func<int> GetHashCode = () => 0;
}
public partial class Demo
{
    static partial void ElidedHook(Action a);
    static bool Clear(ref string? s) { s = null; return false; }
    public static int DoLoop(ref string? s, Box box)
    {
        do { box.F = 1; s = box.F > 0 ? "abc" : null; } while (s == null);
        return s.Length + 1;
    }
    public static int DoLoopWithGuardAndForEach(ref string? s, Box box, int[] items)
    {
        if (s == null) return 0;
        do
        {
            foreach (var i in items) { box.F = i; s = i > 0 ? "abc" : null; }
        } while (s == null);
        return s.Length + 2;
    }
    public static int WhileLoop(ref string? s, Box box)
    {
        s = null;
        while (s == null)
        {
            ElidedHook(() => { while (true) { break; } });
            box.F = 1;
            s = box.F > 0 ? "abc" : null;
        }
        return s.Length + 3;
    }
    public static int ForLoop(ref string? s, Box box)
    {
        s = null;
        for (var i = 0; s == null; i++)
        {
            box.F = 1;
            s = i >= 0 ? "abc" : null;
        }
        return s.Length + 4;
    }
    public static int WhileLoopWithBreak(ref string? s, Box box, Lazy<int> lazy)
    {
        while (s == null)
        {
            s = "abc";
            if (lazy.Value > 0) break;
            s = box.F > 0 ? "abc" : null;
        }
        return s.Length + 5;
    }
    public static int WhileConditionRunsAccessor(ref string? s, Lazy<int> lazy)
    {
        while (lazy.Value < 0 || s == null)
        {
            s = "abc";
        }
        return s.Length + 6;
    }
    public static int WhileLoopWithNestedBreak(ref string? s, Box box)
    {
        s = null;
        while (s == null)
        {
            while (true) { break; }
            box.F = 1;
            s = box.F > 0 ? "abc" : null;
        }
        return s.Length + 7;
    }
    public static int WhileConditionHoistsOutPattern(ref string? s, object probe)
    {
        s = null;
        while (!(probe is int y && s != null))
        {
            y = 2;
            s = "abc";
        }
        return s.Length + 8;
    }
    public static int WhileConditionHoistsOutReferencePattern(ref string? s, object probe)
    {
        s = null;
        while (!(probe is Box y && s != null))
        {
            y = new Box();
            s = "abc";
        }
        return s.Length + 30;
    }
    public static int WhileLoopWithLambdaBreak(ref string? s, Box box)
    {
        s = null;
        while (s == null)
        {
            Action a = () => { while (true) { break; } };
            a();
            box.F = 1;
            s = box.F > 0 ? "abc" : null;
        }
        return s.Length + 9;
    }
    public static int WhileLoopWithNonTerminalSwitchBreak(ref string? s, Box box, int k)
    {
        s = null;
        while (s == null)
        {
            switch (k)
            {
                case 0:
                    if (box.F == 0) break;
                    box.F = 2;
                    break;
            }
            box.F = 1;
            s = box.F > 0 ? "abc" : null;
        }
        return s.Length + 10;
    }
    public static int WhileLoopInSwitchGotoFunction(ref string? s, Box box, int k)
    {
        switch (k)
        {
            case 0:
                box.F = 1;
                break;
            case 1:
                box.F = 2;
                break;
            default:
                goto case 0;
        }
        s = null;
        while (s == null)
        {
            box.F = 1;
            s = box.F > 0 ? "abc" : null;
        }
        return s.Length + 11;
    }
    public static int WhileLoopAfterSynthesizedForContinueLabel(ref string? s, Box box)
    {
        for (var i = 0; i < 1; i++, i++)
        {
            try { continue; } catch (Exception) { }
        }
        s = null;
        while (s == null)
        {
            box.F = 1;
            s = box.F > 0 ? "abc" : null;
        }
        return s.Length + 12;
    }
    public static int WhileLoopWithGotoCaseToEmptyArm(ref string? s, Box box, int k)
    {
        s = null;
        while (s == null)
        {
            switch (k)
            {
                case 0:
                    goto case 2;
                case 1:
                    box.F = 2;
                    break;
                case 2:
                    break;
            }
            box.F = 1;
            s = box.F > 0 ? "abc" : null;
        }
        return s.Length + 13;
    }
    public static int WhileLoopInTryWithEnclosingFilterWrite(ref string? s, Box box)
    {
        try
        {
            s = null;
            while (box.Again() || s == null)
            {
                s = "abc";
            }
            return s.Length + 14;
        }
        catch (Exception) when (Clear(ref s))
        {
            return 0;
        }
    }
    public static int WhileConditionWithConditionalReceiver(ref string? s, Box a, Box b, bool flag)
    {
        s = null;
        while ((flag ? a : b).Again() || s == null)
        {
            s = "abc";
        }
        return s.Length + 15;
    }
    public static int WhileLoopAfterPatternGuardEndLabel(ref string? s, Box box, object probe)
    {
        if (probe is int n && n > 0)
        {
            n++;
        }
        else
        {
        }
        s = null;
        while (s == null)
        {
            box.F = 1;
            s = box.F > 0 ? "abc" : null;
        }
        return s.Length + 16;
    }
    public static int WhileConditionCoalesceAssignNumeric(ref string? s)
    {
        long? n = null;
        s = null;
        while ((n ??= 1) < 0L || s == null)
        {
            s = "abc";
        }
        return s.Length + 17;
    }
    public static int WhileConditionRelationalPatternConversion(ref string? s, byte b)
    {
        s = null;
        while (b is > 250 || s == null)
        {
            s = "abc";
        }
        return s.Length + 18;
    }
    public static int WhileConditionWithMemberTypeTestAndMemberCall(ref string? s, Holder holder)
    {
        s = null;
        while ((holder.Tag is string && holder.Child.Again()) || s == null)
        {
            s = "abc";
        }
        return s.Length + 19;
    }
    public static int WhileConditionWithNullConditionalReceiver(ref string? s, Box? a, Box? b, bool flag)
    {
        s = null;
        while ((flag ? a : b)?.Again() == true || s == null)
        {
            s = "abc";
        }
        return s.Length + 20;
    }
    public static int WhileConditionWithDelegateInvoke(ref string? s, Func<bool> callback, bool direct)
    {
        s = null;
        while ((direct ? callback() : callback.Invoke()) || s == null)
        {
            s = "abc";
        }
        return s.Length + 21;
    }
    public static int WhileConditionWithTestedHidingFieldReceiver(ref string? s, object o)
    {
        s = null;
        while ((o is HidingHolder && o.GetHashCode() < 0) || s == null)
        {
            s = "abc";
        }
        return s.Length + 22;
    }
    public static int WhileConditionWithConditionalFieldRead(ref string? s, Box a, Box b, bool flag)
    {
        s = null;
        while ((flag ? a : b).F < 0 || s == null)
        {
            s = "abc";
        }
        return s.Length + 23;
    }
    public static int WhileConditionWithObjectNilComparison(ref string? s, object? probe)
    {
        s = null;
        while (probe == null || s == null)
        {
            probe = new object();
            s = "abc";
        }
        return s.Length + 24;
    }
    public static int WhileConditionWithNamedArgumentCall(ref string? s)
    {
        s = null;
        while (Box.AgainNamed(repeat: false) || s == null)
        {
            s = "abc";
        }
        return s.Length + 25;
    }
    public static int WhileConditionWithDominatingHidingFieldReceiver(ref string? s, object o)
    {
        if (o is HidingHolder)
        {
            s = null;
            while (o.GetHashCode() < 0 || s == null)
            {
                s = "abc";
            }
            return s.Length + 26;
        }
        return 0;
    }
    public static int WhileConditionAfterExpiredHidingFieldTypeTestControl(ref string? s, object o)
    {
        if (o is HidingHolder)
        {
        }
        s = null;
        while (o.GetHashCode() < 0 || s == null)
        {
            s = "abc";
        }
        return s.Length + 29;
    }
    public static int WhileConditionWithOverloadedReadCandidate(ref string? s, Box box)
    {
        s = null;
        while (box.Pick().Value < 0 || s == null)
        {
            s = "abc";
        }
        return s.Length + 27;
    }
    public static int WhileRefObjectExitCondition(ref object? obj)
    {
        obj = null;
        while (obj == null)
        {
            obj = "abc";
        }
        return obj.GetHashCode() > int.MinValue ? 28 : 0;
    }
    public static string Run()
    {
        string? text = "abc";
        object? obj = "abc";
        return DoLoop(ref text, new Box()) + "," + DoLoopWithGuardAndForEach(ref text, new Box(), new[] { 1 }) + "," +
            WhileLoop(ref text, new Box()) + "," + ForLoop(ref text, new Box()) + "," +
            WhileLoopWithBreak(ref text, new Box(), new Lazy<int>(() => 1)) + "," +
            WhileConditionRunsAccessor(ref text, new Lazy<int>(() => 1)) + "," +
            WhileLoopWithNestedBreak(ref text, new Box()) + "," +
            WhileConditionHoistsOutPattern(ref text, 1) + "," +
            WhileConditionHoistsOutReferencePattern(ref text, new Box()) + "," +
            WhileLoopWithLambdaBreak(ref text, new Box()) + "," +
            WhileLoopWithNonTerminalSwitchBreak(ref text, new Box(), 0) + "," +
            WhileLoopInSwitchGotoFunction(ref text, new Box(), 2) + "," +
            WhileLoopAfterSynthesizedForContinueLabel(ref text, new Box()) + "," +
            WhileLoopWithGotoCaseToEmptyArm(ref text, new Box(), 0) + "," +
            WhileLoopInTryWithEnclosingFilterWrite(ref text, new Box()) + "," +
            WhileConditionWithConditionalReceiver(ref text, new Box(), new Box(), true) + "," +
            WhileLoopAfterPatternGuardEndLabel(ref text, new Box(), 1) + "," +
            WhileConditionCoalesceAssignNumeric(ref text) + "," +
            WhileConditionRelationalPatternConversion(ref text, 3) + "," +
            WhileConditionWithMemberTypeTestAndMemberCall(ref text, new Holder()) + "," +
            WhileConditionWithNullConditionalReceiver(ref text, new Box(), new Box(), true) + "," +
            WhileConditionWithDelegateInvoke(ref text, () => false, true) + "," +
            WhileConditionWithTestedHidingFieldReceiver(ref text, new HidingHolder()) + "," +
            WhileConditionWithConditionalFieldRead(ref text, new Box(), new Box(), true) + "," +
            WhileConditionWithObjectNilComparison(ref text, null) + "," +
            WhileConditionWithNamedArgumentCall(ref text) + "," +
            WhileConditionWithDominatingHidingFieldReceiver(ref text, new HidingHolder()) + "," +
            WhileConditionAfterExpiredHidingFieldTypeTestControl(ref text, new HidingHolder()) + "," +
            WhileConditionWithOverloadedReadCandidate(ref text, new Box()) + "," +
            WhileRefObjectExitCondition(ref obj);
    }
}`)
        Assert.Contains("return s.Length + 1\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("return s.Length + 2", printed)
        Assert.Contains("return s.Length + 3", printed)
        Assert.Contains("return s.Length + 4", printed)
        Assert.Contains("return s!!.Length + 5", printed)
        Assert.Contains("return s!!.Length + 6", printed)
        Assert.Contains("return s.Length + 7", printed)
        Assert.Contains("return s.Length + 8", printed)
        Assert.Contains("return s!!.Length + 30", printed)
        Assert.Contains("return s.Length + 9", printed)
        Assert.Contains("return s.Length + 10", printed)
        Assert.Contains("return s!!.Length + 11", printed)
        Assert.Contains("return s!!.Length + 12", printed)
        Assert.Contains("return s.Length + 13", printed)
        Assert.Contains("return s!!.Length + 14", printed)
        Assert.Contains("return s!!.Length + 15", printed)
        Assert.Contains("return s!!.Length + 16", printed)
        Assert.Contains("return s!!.Length + 17", printed)
        Assert.Contains("return s!!.Length + 18", printed)
        Assert.Contains("return s!!.Length + 19", printed)
        Assert.Contains("return s!!.Length + 20", printed)
        Assert.Contains("return s!!.Length + 21", printed)
        Assert.Contains("return s!!.Length + 22", printed)
        Assert.Contains("return s!!.Length + 23", printed)
        Assert.Contains("return s!!.Length + 24", printed)
        Assert.Contains("return s!!.Length + 25", printed)
        Assert.Contains("return s!!.Length + 26", printed)
        Assert.Contains("return s.Length + 29", printed)
        Assert.Contains("return s!!.Length + 27", printed)
        Assert.Contains("obj!!.GetHashCode()", printed)
        Assert.Equal(19, Regex.Matches(printed, `s!!`).Count)
    }

    /// Issues #5637 and #5238: an accessor in an earlier operand of the same expression removes a by-reference fact
    /// for a later operand (`b.P + s.Length`, `b.Auto + s.Length`), and an enclosing `catch ... when` filter that
    /// writes a local removes its fact after a call in an earlier operand (`Resume() + s.Length`) or in an `if`
    /// condition (`if (Resume() == 0) return s.Length;`), while a read in the first operand before the call stays bare.
    @Fact
    func SameExpressionOperandOrderAndEnclosingCatchFilter_AssertsOnlyAfterEffect() {
        let printed = AssertRunsLikeCSharp(`
using System;
public class Base
{
    private int count;
    public int P => ++count;
    public virtual int Auto { get; set; } = 1;
}
public sealed class Bag : System.Collections.IEnumerable
{
    public int Count;
    public void Add(int x) => Count += x;
    public System.Collections.IEnumerator GetEnumerator() => System.Array.Empty<int>().GetEnumerator();
}
public class Demo
{
    static int Resume()
    {
        try { throw new FormatException(); }
        catch (Exception) { return 0; }
    }
    static bool Touch(ref string? s)
    {
        s = "xy";
        return false;
    }
    public static int AfterComputed(ref string? s, Base b)
    {
        if (s == null) return 0;
        return b.P + s.Length;
    }
    public static int AfterOpenAuto(ref string? s, Base b)
    {
        if (s == null) return 0;
        return b.Auto + s.Length;
    }
    public static int BeforeComputed(ref string? s, Base b)
    {
        if (s == null) return 0;
        return s.Length + b.P;
    }
    public static int FilterOperand(string? seed)
    {
        var s = seed;
        if (s == null) return 0;
        try
        {
            return Resume() + s.Length;
        }
        catch (FormatException) when (Touch(ref s))
        {
            return -1;
        }
    }
    public static int FilterCondition(string? seed)
    {
        var s = seed;
        if (s == null) return 0;
        try
        {
            if (Resume() == 0) return s.Length;
            return 0;
        }
        catch (FormatException) when (Touch(ref s))
        {
            return -1;
        }
    }
    public static int FilterControlBeforeCall(string? seed)
    {
        var s = seed;
        if (s == null) return 0;
        try
        {
            return s.Length + Resume();
        }
        catch (FormatException) when (Touch(ref s))
        {
            return -1;
        }
    }
    public static int FilterControlUninvokedLocalFunction(string? seed)
    {
        var s = seed;
        if (s == null) return 0;
        try
        {
            int Local() => Resume();
            return s.Length + Local();
        }
        catch (FormatException) when (Touch(ref s))
        {
            return -1;
        }
    }
    public static int FilterControlTernaryBranch(string? seed, bool flag)
    {
        var s = seed;
        if (s == null) return 0;
        try
        {
            return flag ? Resume() : s.Length;
        }
        catch (FormatException) when (Touch(ref s))
        {
            return -1;
        }
    }
    public static int AfterSwitchArmGetter(ref string? s, Base b, int k)
    {
        if (s == null) return 0;
        var v = k switch { 0 => b.P, _ => 1 };
        return v + s.Length;
    }
    public static int FilterCollectionAddBeforeRead(string? seed)
    {
        var s = seed;
        if (s == null) return 0;
        try
        {
            var list = new System.Collections.Generic.List<int> { 1, s.Length };
            return list.Count;
        }
        catch (FormatException) when (Touch(ref s))
        {
            return -1;
        }
    }
    public static int FilterFirstCollectionElementAfterCtor(string? seed)
    {
        var s = seed;
        if (s == null) return 0;
        try
        {
            var bag = new Bag { s.Length };
            return bag.Count;
        }
        catch (FormatException) when (Touch(ref s))
        {
            return -1;
        }
    }
    public static int FilterControlCallFreeSwitchExpression(string? seed, int k)
    {
        var s = seed;
        if (s == null) return 0;
        try
        {
            var v = k switch { 0 => 1, _ => 2 };
            return v + s.Length;
        }
        catch (FormatException) when (Touch(ref s))
        {
            return -1;
        }
    }
    static T Id<T>(T value) => value;
    public static int FilterControlGenericFirstArgument(string? seed)
    {
        var s = seed;
        if (s == null) return 0;
        try
        {
            return Id<int>(value: s.Length);
        }
        catch (FormatException) when (Touch(ref s))
        {
            return -1;
        }
    }
    public static int ClosureAssignedAfterObjectCaseLabel(string? seed, object o)
    {
        var s = seed;
        System.Action reset = () => s = null;
        if (s == null) return 0;
        var v = 0;
        switch (o)
        {
            case 1:
                v = 2;
                break;
            default:
                v = 3;
                break;
        }
        return v + s.Length;
    }
    public static string Run()
    {
        string? text = "abc";
        var b = new Base();
        return AfterComputed(ref text, b) + "," + AfterOpenAuto(ref text, b) + "," + BeforeComputed(ref text, b) + "," +
            FilterOperand("abc") + "," + FilterCondition("abc") + "," + FilterControlBeforeCall("abc") + "," +
            FilterControlUninvokedLocalFunction("abc") + "," + FilterControlTernaryBranch("abc", false) + "," +
            AfterSwitchArmGetter(ref text, b, 0) + "," + FilterCollectionAddBeforeRead("abc") + "," +
            FilterFirstCollectionElementAfterCtor("abc") + "," + FilterControlCallFreeSwitchExpression("abc", 0) + "," +
            ClosureAssignedAfterObjectCaseLabel("abc", 1) + "," + FilterControlGenericFirstArgument("abc");
    }
}`)
        Assert.Contains("return b.P + s!!.Length", printed)
        Assert.Contains("return b.Auto + s!!.Length", printed)
        Assert.Contains("return s.Length + b.P", printed)
        Assert.Contains("return Resume() + s!!.Length", printed)
        Assert.Contains("return s!!.Length\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("return s.Length + Resume()", printed)
        Assert.Contains("return s.Length + Local()", printed)
        Assert.Contains("return if flag { Resume() } else { s.Length }", printed)
        Assert.Contains("return v + s!!.Length", printed)
        Assert.Contains("{ 1, s!!.Length }", printed)
        Assert.Contains("Bag(){ s!!.Length }", printed)
        Assert.Contains("return v + s.Length", printed)
        Assert.Contains("Id[int32](value: s.Length)", printed)
        Assert.Equal(2, Regex.Matches(printed, `return v \+ s!!\.Length`).Count)
    }

    /// Issue #5693: a C# struct or class with a source-declared `Deconstruct` method (instance or extension)
    /// translates to G# that compiles and runs for `var (a, b) = p`, `(a, b) = p`, and `foreach (var (a, b) in items)`,
    /// and a deconstructing `foreach` over it asserts a narrowed by-reference parameter while a straight-line
    /// deconstruction keeps it bare (amendment A3).
    @Fact
    func SourceDeconstruct_InDeclarationAssignmentAndForEach_CompilesAndMatchesNarrowing() {
        let printed = AssertRunsLikeCSharp(`
public struct Pair
{
    public int A;
    public int B;
    public void Deconstruct(out int a, out int b)
    {
        a = A;
        b = B;
    }
}
public sealed class Box<T> where T : notnull
{
    public T Value;
    public int Count;
    public Box(T value, int count)
    {
        Value = value;
        Count = count;
    }
    public void Deconstruct(out T value, out int count)
    {
        value = Value;
        count = Count;
    }
}
public struct ExtPair
{
    public int X;
    public int Y;
}
public record RecordPoint(int X, int Y);
public static class PairExtensions
{
    public static void Deconstruct(this ExtPair p, out int x, out int y)
    {
        x = p.X;
        y = p.Y;
    }
    public static void Deconstruct(this RecordPoint p, out int x, out int y, out int sum)
    {
        x = p.X;
        y = p.Y;
        sum = p.X + p.Y;
    }
}
public class Demo
{
    public static int StraightLine(ref string? s, Pair p, Box<string> box, ExtPair ep)
    {
        if (s == null) return 0;
        var (a, b) = p;
        int x, y;
        (x, y) = p;
        var (text, count) = box;
        var (ex, ey) = ep;
        return s.Length + a + b + x + y + text.Length + count + ex + ey;
    }
    public static int LoopItems(ref string? s, Pair[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (a, b) in items) total += a + b + s.Length;
        return s.Length + total;
    }
    public static int LoopDiscards(ref string? s, Pair[] items)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (_, _) in items) total += 1;
        return s.Length + total + 1;
    }
    public static int LoopRecordExtensionDiscards(ref string? s, RecordPoint[] points)
    {
        if (s == null) return 0;
        var total = 0;
        foreach (var (_, _, _) in points) total += 1;
        return s.Length + total + 2;
    }
    public static string Run()
    {
        string? text = "abc";
        var p = new Pair { A = 2, B = 3 };
        var items = new[] { p, new Pair { A = 4, B = 5 } };
        return StraightLine(ref text, p, new Box<string>("hi", 6), new ExtPair { X = 7, Y = 8 }) + "," +
            LoopItems(ref text, items) + "," + LoopDiscards(ref text, items) + "," +
            LoopRecordExtensionDiscards(ref text, new[] { new RecordPoint(1, 2) });
    }
}`)
        Assert.Contains("return s.Length + a + b + x + y + text!!.Length + count + ex + ey", printed)
        Assert.Contains("total += a + b + s!!.Length", printed)
        Assert.Contains("return s!!.Length + total\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("return s!!.Length + total + 1", printed)
        Assert.Contains("return s!!.Length + total + 2", printed)
        Assert.Equal(4, Regex.Matches(printed, `s!!`).Count)
    }

    shared {
        /// Runs `Demo.Run()` of the C# and of its translation and compares the output. [`library`](paramref) is C#
        /// that both reference as a prebuilt assembly (`Lib5617`), so its types are imported in the G#.
        internal func AssertRunsLikeCSharp(
            source string,
            library string? = nil,
            rejectConditionalIndexWarnings bool = false
        ) string {
            let libraryImage = if library == nil {
                Array.Empty[byte]()
            } else {
                EmitCSharp("Lib5617", library)
            }
            let references = List[MetadataReference](CSharpProjectLoader.RuntimeReferences())
            if libraryImage.Length > 0 {
                references.Add(MetadataReference.CreateFromImage(libraryImage))
            }
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: "Snippet.cs"
            )
            let compilation = CSharpCompilation.Create(
                "Snippet" + Guid.NewGuid().ToString("N"),
                []SyntaxTree{tree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
                    .WithAllowUnsafe(true)
            )
            using let peStream = MemoryStream()
            let emitted = compilation.Emit(peStream)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            let loadContext = AssemblyLoadContext("Issue5617", isCollectible: true)
            try {
                if libraryImage.Length > 0 {
                    loadContext.LoadFromStream(MemoryStream(libraryImage))
                }
                peStream.Position = 0
                let expected = cast[string](
                    loadContext.LoadFromStream(peStream).GetType("Demo", throwOnError: true)!!.GetMethod(
                        "Run"
                    )!!.Invoke(nil, nil)
                )
                let model = compilation.GetSemanticModel(tree)
                let document = LoadedDocument("Snippet.cs", tree, model)
                let context = TranslationContext(compilation, model, document.FilePath)
                let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
                Assert.Equal(expected, CompileAndRun(printed, libraryImage, rejectConditionalIndexWarnings).Trim())
                return printed
            } finally {
                loadContext.Unload()
            }
        }

        private func EmitCSharp(name string, source string)[]byte {
            let compilation = CSharpCompilation.Create(
                name,
                []SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            using let stream = MemoryStream()
            let emitted = compilation.Emit(stream)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            return stream.ToArray()
        }

        private func CompileAndRun(
            printed string,
            libraryImage[]byte,
            rejectConditionalIndexWarnings bool = false
        ) string {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(
                AppContext.BaseDirectory,
                "Issue5617ByReferenceAccessorNarrowingTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(workDir)
            try {
                let gsPath = Path.Combine(workDir, "Snippet.gs")
                let mainPath = Path.Combine(workDir, "Main.gs")
                let dllPath = Path.Combine(workDir, "Snippet.dll")
                File.WriteAllText(gsPath, printed)
                File.WriteAllText(
                    mainPath,
                    "import System${Environment.NewLine}Console.WriteLine(Demo.Run())${Environment.NewLine}"
                )
                let arguments = List[string]{compiler!!, "/target:exe", "/out:$dllPath", gsPath, mainPath}
                if libraryImage.Length > 0 {
                    let libraryPath = Path.Combine(workDir, "Lib5617.dll")
                    File.WriteAllBytes(libraryPath, libraryImage)
                    arguments.Add("/r:" + libraryPath)
                }
                let (compileExit, compileOutput) = RunDotnet(arguments.ToArray())
                Assert.True(
                    compileExit == 0 && !compileOutput.Contains("error", StringComparison.OrdinalIgnoreCase),
                    "gsc must compile the translated snippet. Output:\n" +
                        compileOutput +
                        "\n\nTranslated G#:\n" +
                        printed
                )
                if rejectConditionalIndexWarnings {
                    Assert.DoesNotContain("GS0300", compileOutput)
                }
                // A `!!` on the by-reference read where gsc keeps the fact is GS0536.
                let lines = printed.Replace("\r\n", "\n").Split('\n')
                for diagnostic in Regex.Matches(compileOutput, `Snippet\.gs\((\d+),\d+,\d+,\d+\): warning GS0536`) {
                    let line = lines[int32.Parse(diagnostic.Groups[1].Value) - 1]
                    Assert.False(line.Contains("s!!"), "gsc keeps the fact here (GS0536): " + line)
                }
                let (runExit, runOutput) = RunDotnet(dllPath)
                Assert.True(runExit == 0, "The translated snippet must run. Output:\n" + runOutput)
                return runOutput
            } finally {
                try {
                    Directory.Delete(workDir, recursive: true)
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }

        private func RunDotnet(arguments ...string)(Exit int32, Output string) {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            for argument in arguments {
                startInfo.ArgumentList.Add(argument)
            }
            using let process = Process.Start(startInfo) ?? throw InvalidOperationException("failed to start dotnet")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(TimeSpan.FromMinutes(5)) {
                process.Kill(entireProcessTree: true)
                Assert.Fail("dotnet " + string.Join(' ', arguments) + " did not exit within 5 minutes.")
            }
            let output = StringBuilder()
            output.Append(stdout.GetAwaiter().GetResult())
            output.Append(stderr.GetAwaiter().GetResult())
            return (process.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }
    }
}
