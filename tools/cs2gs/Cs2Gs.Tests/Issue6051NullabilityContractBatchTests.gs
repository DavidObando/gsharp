// <copyright file="Issue6051NullabilityContractBatchTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import Xunit

/// Regression and control tests for cohesive cs2gs nullability-contract fixes:
/// #6051 (nullable-result delegate fields), #6046 (implicit collection Add flow),
/// and #6035 (synchronous awaiter GetAwaiter().GetResult() task payload flow).
open class Issue6051NullabilityContractBatchTests {
    @Fact
    func NullableResultDelegateField_PreservesNonNullReceiverAndInvocation() {
        let source = `
#nullable enable
using System;
public static class P
{
    static Func<object?> saved = () => "old";
    static Func<object?> methodGroup = Old;
    static object? Old() => "old";
    static void Remember(Func<object?> read) { saved = read; methodGroup = read; }
    public static void Main()
    {
        Remember(() => null);
        Console.Write((saved() == null) + "|" + (methodGroup() == null));
    }
}`
        LiteralConstructionRuntimeParity.AssertMatches(
            source,
            verifyTranslation: (printed string) -> {
                Assert.Contains("private var saved () -> object? =", printed, StringComparison.Ordinal)
                Assert.Contains("private var methodGroup () -> object? =", printed, StringComparison.Ordinal)
                Assert.DoesNotContain("(() -> object?)?", printed, StringComparison.Ordinal)
                Assert.DoesNotContain("saved!!()", printed, StringComparison.Ordinal)
                Assert.DoesNotContain("methodGroup!!()", printed, StringComparison.Ordinal)
            },
            verifyIL: true,
            nullableContextOptions: NullableContextOptions.Enable,
            expectedOutput: "True|True"
        )

        let mixedMethodGroup = `
#nullable enable
using System;
using System.Diagnostics.CodeAnalysis;
using System.Threading.Tasks;
public class Resolver
{
    public Type? MapClrTypeToReferences(Type? hostType) => hostType;
}
#nullable disable
public static class P
{
    static string Maybe() => null;
    [return: MaybeNull] static Task<int> MissingTask() => null;
    static async Task<string> AsyncMissing() { await Task.Yield(); return null; }
    public static void Main()
    {
        var resolver = new Resolver();
        var mapClrType = resolver.MapClrTypeToReferences;
        var unusedMap = resolver.MapClrTypeToReferences;
        var local = Maybe;
        var readTask = MissingTask;
        var readAsync = AsyncMissing;
        Console.Write((mapClrType(null) == null) + "|" + (local() == null) + "|" + (readTask() == null) + "|" + (readAsync().GetAwaiter().GetResult() == null));
    }
}`
        LiteralConstructionRuntimeParity.AssertMatches(
            mixedMethodGroup,
            verifyTranslation: (printed string) -> {
                Assert.Contains(
                    "let mapClrType (Type?) -> Type? = resolver.MapClrTypeToReferences",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "let unusedMap (Type?) -> Type? = resolver.MapClrTypeToReferences",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains("let local () -> string? = Maybe", printed, StringComparison.Ordinal)
                Assert.Contains("let readTask () -> Task[int32]? = MissingTask", printed, StringComparison.Ordinal)
                Assert.Contains("let readAsync () -> Task[string?] = AsyncMissing", printed, StringComparison.Ordinal)
                Assert.DoesNotContain("((Type?) -> Type?)?", printed, StringComparison.Ordinal)
                Assert.DoesNotContain("(() -> string?)?", printed, StringComparison.Ordinal)
                Assert.DoesNotContain("async () -> int32?", printed, StringComparison.Ordinal)
            },
            verifyIL: true,
            nullableContextOptions: NullableContextOptions.Disable,
            expectedOutput: "True|True|True|True"
        )
    }

    @Fact
    func GenuinelyNullableDelegateField_UnconditionalInvocationBridgesReceiver() {
        let enabledNullableField = `
#nullable enable
using System;
public static class P
{
    static Func<object?>? saved = () => "old";
    static void Remember(Func<object?> read) { saved = read; }
    public static void Main()
    {
        Remember(() => null);
        Console.Write(saved() == null);
    }
}`
        LiteralConstructionRuntimeParity.AssertMatches(
            enabledNullableField,
            verifyTranslation: (printed string) -> {
                Assert.Contains("private var saved (() -> object?)? =", printed, StringComparison.Ordinal)
                Assert.Contains("saved!!()", printed, StringComparison.Ordinal)
            },
            verifyIL: true,
            nullableContextOptions: NullableContextOptions.Enable,
            expectedOutput: "True"
        )

        let obliviousNullableField = `
#nullable disable
using System;
public static class P
{
    static Func<object> saved = null;
    static void Remember(Func<object> read) { saved = read; }
    public static void Main()
    {
        Remember(() => "x");
        Console.Write(saved() == null);
    }
}`
        LiteralConstructionRuntimeParity.AssertMatches(
            obliviousNullableField,
            verifyTranslation: (printed string) -> {
                Assert.Contains("private var saved (() -> object)? =", printed, StringComparison.Ordinal)
                Assert.Contains("saved!!()", printed, StringComparison.Ordinal)
            },
            verifyIL: true,
            nullableContextOptions: NullableContextOptions.Disable,
            expectedOutput: "False"
        )

        let initializerPromotedField = `
#nullable enable
using System;
#pragma warning disable CS8601
public static class P
{
    static Func<object?>? Maybe(bool missing) => missing ? null : () => null;
    static Func<object?> saved = Maybe(false);
    public static void Main()
    {
        Console.Write(saved() == null);
    }
}`
        LiteralConstructionRuntimeParity.AssertMatches(
            initializerPromotedField,
            verifyTranslation: (printed string) -> {
                Assert.Contains("private var saved (() -> object?)? =", printed, StringComparison.Ordinal)
                Assert.Contains("saved!!()", printed, StringComparison.Ordinal)
            },
            verifyIL: true,
            nullableContextOptions: NullableContextOptions.Enable,
            expectedOutput: "True"
        )

        let liftedRecordStructField = `
#nullable enable
using System;
#pragma warning disable CS8601
public static class P
{
    static Func<object?>? Maybe() => null;
    public record struct S
    {
        public Func<object?> Saved = Maybe();
        public S() { Saved = () => "old"; }
    }
    public static void Main()
    {
        var s = new S();
        Console.Write(s.Saved() == null);
    }
}`
        LiteralConstructionRuntimeParity.AssertMatches(
            liftedRecordStructField,
            verifyTranslation: (printed string) -> {
                Assert.Contains("var Saved () -> object? = () -> \"old\"", printed, StringComparison.Ordinal)
                Assert.DoesNotContain("Saved!!()", printed, StringComparison.Ordinal)
            },
            verifyIL: true,
            nullableContextOptions: NullableContextOptions.Enable,
            expectedOutput: "False"
        )
    }

    @Fact
    func ImplicitCollectionInitializerAdd_PropagatesObliviousNullableStorage() {
        let source = `
#nullable disable
using System;
using System.Collections;
public class Node { }
public class Holder { public Node Item; }
public class Reset : IEnumerable
{
    public Node Value;
    public Reset(out Node target) { target = null; }
    public void Add(Node value) { Value = value; }
    public IEnumerator GetEnumerator() => Array.Empty<object>().GetEnumerator();
}
public static class P
{
    public static void Main()
    {
        var holder = new Holder { Item = new Node() };
        if (holder is { Item: Node p })
        {
            Reset reset = new Reset(out p) { p };
            Console.Write(reset.Value == null);
        }
    }
}`
        LiteralConstructionRuntimeParity.AssertMatches(
            source,
            verifyTranslation: (printed string) -> {
                Assert.Contains("func Add(value Node?)", printed, StringComparison.Ordinal)
                Assert.DoesNotContain("p!!", printed, StringComparison.Ordinal)
            },
            verifyIL: true,
            nullableContextOptions: NullableContextOptions.Disable,
            expectedOutput: "True"
        )

        let multiArgAndNested = `
#nullable disable
using System;
using System.Collections;
public class Node { }
public class Holder { public Node Item; }
public class Bag : IEnumerable
{
    public Node First;
    public Node Second;
    public void Add(Node key, Node value) { First = key; Second = value; }
    public IEnumerator GetEnumerator() => Array.Empty<object>().GetEnumerator();
}
public class Wrapper
{
    public Bag Items { get; } = new Bag();
}
public class Reset : IEnumerable
{
    public Node Value;
    public Reset(out Node target) { target = null; }
    public void Add(Node value) { Value = value; }
    public IEnumerator GetEnumerator() => Array.Empty<object>().GetEnumerator();
}
public static class P
{
    public static void Main()
    {
        var holder = new Holder { Item = new Node() };
        if (holder is { Item: Node p })
        {
            Reset reset = new Reset(out p) { p };
            Wrapper wrapper = new Wrapper { Items = { { p, new Node() } } };
            Console.Write((reset.Value == null) + "|" + (wrapper.Items.First == null && wrapper.Items.Second != null));
        }
    }
}`
        LiteralConstructionRuntimeParity.AssertMatches(
            multiArgAndNested,
            verifyTranslation: (printed string) -> {
                Assert.Contains("func Add(key Node?, value Node)", printed, StringComparison.Ordinal)
                Assert.DoesNotContain("p!!", printed, StringComparison.Ordinal)
            },
            verifyIL: true,
            nullableContextOptions: NullableContextOptions.Disable,
            expectedOutput: "True|True"
        )

        let nullableSinkControl = `
#nullable enable
using System;
using System.Collections;
public class Node { }
public class Reset : IEnumerable
{
    public Node? Value;
    public Reset(out Node? target) { target = null; }
    public void Add(Node? value) { Value = value; }
    public IEnumerator GetEnumerator() => Array.Empty<object>().GetEnumerator();
}
public static class P
{
    public static void Main()
    {
        Node? p = new Node();
        Reset reset = new Reset(out p) { p };
        Console.Write(reset.Value == null);
    }
}`
        LiteralConstructionRuntimeParity.AssertMatches(
            nullableSinkControl,
            verifyTranslation: (printed string) -> {
                Assert.Contains("func Add(value Node?)", printed, StringComparison.Ordinal)
                Assert.DoesNotContain("p!!", printed, StringComparison.Ordinal)
            },
            verifyIL: true,
            nullableContextOptions: NullableContextOptions.Enable,
            expectedOutput: "True"
        )
    }

    @Fact
    func ImplicitCollectionInitializerAdd_EnabledNonNullContract_PreservesBridge() {
        let source = `
#nullable enable
using System;
using System.Collections;
#pragma warning disable CS8604
public class Node { }
public class Reset : IEnumerable
{
    public Node? Value;
    public void Add(Node value) { Value = value; }
    public IEnumerator GetEnumerator() => Array.Empty<object>().GetEnumerator();
}
public static class P
{
    static Node? Maybe(bool missing) => missing ? null : new Node();
    public static void Main()
    {
        Node? p = Maybe(false);
        Reset reset = new Reset { p };
        Console.Write(reset.Value == null);
    }
}`
        LiteralConstructionRuntimeParity.AssertMatches(
            source,
            verifyTranslation: (printed string) -> {
                Assert.Contains("func Add(value Node)", printed, StringComparison.Ordinal)
                Assert.DoesNotContain("func Add(value Node?)", printed, StringComparison.Ordinal)
                Assert.Contains("p!!", printed, StringComparison.Ordinal)
            },
            verifyIL: true,
            nullableContextOptions: NullableContextOptions.Enable,
            expectedOutput: "False"
        )
    }

    @Fact
    func ImplicitCollectionInitializerAdd_ParamsElementInference_DistinguishesExpandedFromArrayControl() {
        let source = `
#nullable disable
using System;
using System.Collections;
public class ExpandedBag : IEnumerable
{
    public string First;
    public int Count;
    public void Add(params string[] values) { First = values[0]; Count += values.Length; }
    public IEnumerator GetEnumerator() => Array.Empty<object>().GetEnumerator();
}
public class NormalArrayBag : IEnumerable
{
    public string First;
    public int Count;
    public void Add(params string[] values) { First = values[0]; Count += values.Length; }
    public IEnumerator GetEnumerator() => Array.Empty<object>().GetEnumerator();
}
public static class P
{
    static string Maybe() => null;
    public static void Main()
    {
        var single = new ExpandedBag { Maybe() };
        var multi = new ExpandedBag { { Maybe(), "x" } };
        var arr = new string[] { "ok" };
        var normal = new NormalArrayBag { arr };
        Console.Write((single.First == null) + "|" + single.Count + "|" + (multi.First == null) + "|" + multi.Count + "|" + normal.First.Length + "|" + normal.Count);
    }
}`
        LiteralConstructionRuntimeParity.AssertMatches(
            source,
            verifyTranslation: (printed string) -> {
                Assert.Contains("func Add(values ...string?)", printed, StringComparison.Ordinal)
                Assert.Contains("func Add(values ...string)", printed, StringComparison.Ordinal)
                Assert.DoesNotContain("Maybe()!!", printed, StringComparison.Ordinal)
                Assert.DoesNotContain("(...string?)?", printed, StringComparison.Ordinal)
            },
            verifyIL: true,
            nullableContextOptions: NullableContextOptions.Disable,
            expectedOutput: "True|1|True|2|2|1"
        )
    }

    @Fact
    func SynchronousAwaiterGetResult_PropagatesInferredNullableTaskPayload() {
        let source = `
#nullable disable
using System;
using System.Threading.Tasks;
public static class P
{
    static async Task<string> Missing() { await Task.Yield(); return null; }
    static string Read(Task<string> value) => value.GetAwaiter().GetResult();
    public static void Main() => Console.WriteLine(Read(Missing()) == null);
}`
        LiteralConstructionRuntimeParity.AssertMatches(
            source,
            verifyTranslation: (printed string) -> {
                Assert.Contains(
                    "private func Read(value Task[string?]) string? -> value.GetAwaiter().GetResult()",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
            },
            verifyIL: true,
            nullableContextOptions: NullableContextOptions.Disable,
            expectedOutput: "True" + Environment.NewLine
        )

        let configuredAndBlock = `
#nullable disable
using System;
using System.Threading.Tasks;
public static class P
{
    static async Task<string> Missing() { await Task.Yield(); return null; }
    static async Task<string> Present() { await Task.Yield(); return "ok"; }
    static string ReadConfigured(Task<string> value) => value.ConfigureAwait(false).GetAwaiter().GetResult();
    static string ReadViaLocal(Task<string> value)
    {
        var text = value.GetAwaiter().GetResult();
        return text;
    }
    static int ReadLengthGuarded(Task<string> value)
    {
        var text = value.GetAwaiter().GetResult();
        return text == null ? -1 : text.Length;
    }
    static int ReadLengthDirect(Task<string> value) => value.GetAwaiter().GetResult().Length;
    public static void Main() => Console.WriteLine(
        (ReadConfigured(Missing()) == null) + "|" +
        (ReadViaLocal(Missing()) == null) + "|" +
        ReadLengthGuarded(Missing()) + "|" +
        ReadLengthDirect(Present()));
}`
        LiteralConstructionRuntimeParity.AssertMatches(
            configuredAndBlock,
            verifyTranslation: (printed string) -> {
                Assert.Contains(
                    "private func ReadConfigured(value Task[string?]) string?",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.Contains(
                    "private func ReadViaLocal(value Task[string?]) string?",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.DoesNotContain("ReadConfigured(Missing())!!", printed, StringComparison.Ordinal)
                Assert.DoesNotContain("ReadViaLocal(Missing())!!", printed, StringComparison.Ordinal)
            },
            verifyIL: true,
            nullableContextOptions: NullableContextOptions.Disable,
            expectedOutput: "True|True|-1|2" + Environment.NewLine
        )
    }

    @Fact
    func SynchronousAwaiterGetResult_NonNullTaskPayload_RemainsNonNullable() {
        let source = `
#nullable disable
using System;
using System.Threading.Tasks;
public static class P
{
    static async Task<string> Present() { await Task.Yield(); return "ok"; }
    static string Read(Task<string> value) => value.GetAwaiter().GetResult();
    public static void Main() => Console.WriteLine(Read(Present()).Length);
}`
        LiteralConstructionRuntimeParity.AssertMatches(
            source,
            verifyTranslation: (printed string) -> {
                Assert.Contains(
                    "private func Read(value Task[string]) string -> value.GetAwaiter().GetResult()",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.DoesNotContain("string?", printed, StringComparison.Ordinal)
            },
            verifyIL: true,
            nullableContextOptions: NullableContextOptions.Disable,
            expectedOutput: "2" + Environment.NewLine
        )
    }
}
