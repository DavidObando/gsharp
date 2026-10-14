// <copyright file="Issue4790StaticExtensionHolderAbiTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.Tests
import Gsharp.Concurrency
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.CompilerServices
import System.Runtime.InteropServices
import System.Security.Cryptography
import System.Text.Json
import System.Threading.Tasks
import Xunit

open class Issue4790StaticExtensionHolderAbiTests {
    @Fact
    func OwnedExtensions_PreserveNativeHolderAndOnceCompiledConsumer() {
        WithProducts(
            (native string, emitted string, consumer CSharpFixture) -> {
                Assert.Equal("14,13,44,-9,10,1,6", RunConsumer(native, consumer))
                Assert.Equal("14,13,44,-9,10,1,6", RunConsumer(emitted, consumer))
                let images[]Assembly = []Assembly{
                    consumer.LoadTogether(File.ReadAllBytes(native))[0],
                    consumer.LoadTogether(File.ReadAllBytes(emitted))[0]
                }
                let nativeOwner Type? = images[0].GetType("Issue4790.Contracts.Holder", throwOnError: true)
                let emittedOwner Type? = images[1].GetType("Issue4790.Contracts.Holder", throwOnError: true)
                Assert.True(nativeOwner!!.IsAbstract && nativeOwner!!.IsSealed)
                Assert.True(emittedOwner!!.IsAbstract && emittedOwner!!.IsSealed)
                Assert.Single(emittedOwner!!.GetCustomAttributes[ExtensionAttribute]())
                let methods = nativeOwner!!.GetMethods(
                    BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly
                )
                Assert.Equal(5, methods.Length)
                for method in methods {
                    let actual = Assert.Single(
                        emittedOwner!!.GetMethods(
                            BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly
                        ),
                        (candidate MethodInfo) -> candidate.Name == method.Name
                    )
                    Assert.Equal(
                        Issue4790StaticExtensionHolderAbiTests.Contract(method),
                        Issue4790StaticExtensionHolderAbiTests.Contract(actual)
                    )
                    Assert.Equal(
                        method.IsDefined(typeof(ExtensionAttribute)),
                        actual.IsDefined(typeof(ExtensionAttribute))
                    )
                }
                let receiver Type? = images[1].GetType("Issue4790.Contracts.Node", throwOnError: true)
                Assert.DoesNotContain(
                    receiver!!.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly),
                    (method MethodInfo) -> (method.Name is "Read" or "Echo" or "NullAllowed")
                )
            }
        )
    }

    @Fact
    func HostedBodies_KeepNativePrivateHelpersAndFields() {
        WithProducts(
            (native string, emitted string, consumer CSharpFixture) -> {
                Assert.Equal(RunConsumer(native, consumer), RunConsumer(emitted, consumer))
                let images[]Assembly = []Assembly{
                    consumer.LoadTogether(File.ReadAllBytes(native))[0],
                    consumer.LoadTogether(File.ReadAllBytes(emitted))[0]
                }
                for image in images {
                    let owner Type? = image.GetType("Issue4790.Contracts.Holder", throwOnError: true)
                    let helpers = owner!!.GetMethods(
                        BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.DeclaredOnly
                    )
                    Assert.NotEmpty(helpers)
                    Assert.True(Assert.Single(helpers, (method MethodInfo) -> method.Name == "Help").IsPrivate)
                    let field FieldInfo? = owner!!.GetField("Bias", BindingFlags.NonPublic | BindingFlags.Static)
                    Assert.NotNull(field)
                    Assert.True(field!!.IsPrivate)
                    Assert.Null(owner!!.GetMethod("Help", BindingFlags.Public | BindingFlags.Static))
                }
            }
        )
    }

    @Fact
    func PrivateOwnedExtension_KeepsItsBodyAndVisibilityOnOriginalHolder() {
        const source = `namespace Issue4790.Contracts;
public sealed class Item { public int Value = 4; }
public static class Holder
{
    private static int Secret(this Item item) => item.Value + 7;
    public static int Exercise(Item item) => item.Secret();
}`
        const consumerSource = `using Issue4790.Contracts;
public static class NativeConsumer
{
    public static string Run() => Holder.Exercise(new Item()).ToString();
}`
        WithProducts(
            (native string, emitted string, consumer CSharpFixture) -> {
                Assert.Equal("11", RunConsumer(native, consumer))
                Assert.Equal("11", RunConsumer(emitted, consumer))
                let image = consumer.LoadTogether(File.ReadAllBytes(emitted))[0]
                let owner Type? = image.GetType("Issue4790.Contracts.Holder", throwOnError: true)
                let helper MethodInfo? = owner!!.GetMethod("Secret", BindingFlags.Static | BindingFlags.NonPublic)
                Assert.NotNull(helper)
                Assert.True(helper!!.IsPrivate)
                let receiver Type? = image.GetType("Issue4790.Contracts.Item", throwOnError: true)
                Assert.Null(receiver!!.GetMethod("Secret", BindingFlags.Instance | BindingFlags.NonPublic))
            },
            source,
            consumerSource
        )
    }

    @Fact
    func OverloadsArraysAndGenericReceivers_KeepOriginalStaticContracts() {
        const source = `namespace Issue4790.Contracts;
public sealed class Item { public int Value = 4; }
public sealed class Box<T> { public T Value; public Box(T value) { Value = value; } }
public static class Holder
{
    private static int Help(int value) => value + 7;
    public static int Read(this Item item, int delta = 3) => Help(item.Value) + delta;
    public static string Read(this Item item, string prefix) => prefix + item.Value;
    public static int Sum(this Item item, params int[] values)
    {
        int sum = item.Value;
        foreach (int value in values) sum += value;
        return Help(sum);
    }
    public static int Read(this Item[] items) => Help(items[0].Value);
    public static T Read<T>(this Box<T> box) where T : class => box.Value;
    public static int Exercise(Item item) => item.Read() + item.Sum(1, 2);
}`
        const consumerSource = `using System;
using Issue4790.Contracts;
public static class NativeConsumer
{
    public static string Run()
    {
        var item = new Item();
        Func<Item, int, int> original = Holder.Read;
        bool owner = original.Method.IsStatic && original.Method.DeclaringType == typeof(Holder);
        return string.Join(",", new object[] {
            Holder.Read(item), Holder.Read(item, "v"), Holder.Sum(item, 1, 2),
            Holder.Read(new[] { item }), Holder.Read(new Box<string>("box")),
            Holder.Exercise(item), owner ? 1 : 0 });
    }
}`
        WithProducts(
            (native string, emitted string, consumer CSharpFixture) -> {
                Assert.Equal("14,v4,14,11,box,28,1", RunConsumer(native, consumer))
                Assert.Equal("14,v4,14,11,box,28,1", RunConsumer(emitted, consumer))
                let images[]Assembly = []Assembly{
                    consumer.LoadTogether(File.ReadAllBytes(native))[0],
                    consumer.LoadTogether(File.ReadAllBytes(emitted))[0]
                }
                let methods = images.Select(
                    func (image Assembly)[]MethodInfo {
                        return image.GetType("Issue4790.Contracts.Holder", throwOnError: true)!!.GetMethods(
                            BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly
                        )
                    }
                )
                    .ToArray()
                Assert.Equal(6, methods[0].Length)
                Assert.Equal(
                    methods[0].Select(Contract).OrderBy((contract string) -> contract, StringComparer.Ordinal),
                    methods[1].Select(Contract).OrderBy((contract string) -> contract, StringComparer.Ordinal)
                )
                for method in methods[1] {
                    Assert.Equal("Issue4790.Contracts.Holder", method.DeclaringType!!.FullName)
                }
                let nativeParams = Assert.Single(methods[0], (method MethodInfo) -> method.Name == "Sum")
                    .GetParameters()[1]
                let emittedParams = Assert.Single(methods[1], (method MethodInfo) -> method.Name == "Sum")
                    .GetParameters()[1]
                Assert.True(nativeParams.IsDefined(typeof(ParamArrayAttribute)))
                Assert.True(emittedParams.IsDefined(typeof(ParamArrayAttribute)))
            },
            source,
            consumerSource
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func RefReturningOwnedExtensions_PreserveHolderAndCanonicalLiveAliases(readOnly bool) {
        let returnKind = if readOnly {
            "ref readonly"
        } else {
            "ref"
        }
        let source = (`namespace Issue4790.Contracts;
public sealed class Node { public int Value = 4; }
public static class Holder
{
    public static ` + "$returnKind" + ` int Slot(this Node node) => ref node.Value;
    public static ` + "$returnKind" + ` int BlockSlot(this Node node) { return ref node.Value; }
    public static int Exercise(Node node)
    {
        ` + "$returnKind" + ` int alias = ref node.Slot();
        node.Value += 3;
        return alias;
    }
}`)
        let write = if readOnly {
            "node.Value = 24;"
        } else {
            "alias = 24;"
        }
        let consumerSource = (`using System;
using Issue4790.Contracts;
public static class NativeConsumer
{
    private delegate ` + "$returnKind" + ` int OriginalSlot(Node node);
    public static string Run()
    {
        var node = new Node();
        OriginalSlot original = Holder.Slot;
        ` + "$returnKind" + ` int alias = ref original(node);
        ` + "$returnKind" + ` int block = ref Holder.BlockSlot(node);
        node.Value = 23;
        int observed = alias;
        ` + "$write" + `
        return string.Join(",", new object[] {
            observed, Holder.Exercise(node), block,
            original.Method.IsStatic && original.Method.DeclaringType == typeof(Holder) ? 1 : 0 });
    }
}`)
        WithProducts(
            (native string, emitted string, consumer CSharpFixture) -> {
                Assert.Equal("23,27,27,1", RunConsumer(native, consumer))
                Assert.Equal("23,27,27,1", RunConsumer(emitted, consumer))
                let images[]Assembly = []Assembly{
                    consumer.LoadTogether(File.ReadAllBytes(native))[0],
                    consumer.LoadTogether(File.ReadAllBytes(emitted))[0]
                }
                for name in[]string{"Slot", "BlockSlot"} {
                    let expected MethodInfo? = images[0].GetType(
                        "Issue4790.Contracts.Holder",
                        throwOnError: true
                    )!!.GetMethod(name, BindingFlags.Public | BindingFlags.Static)
                    let original MethodInfo? = images[1].GetType(
                        "Issue4790.Contracts.Holder",
                        throwOnError: true
                    )!!.GetMethod(name, BindingFlags.Public | BindingFlags.Static)
                    Assert.NotNull(expected)
                    Assert.NotNull(original)
                    Assert.True(expected!!.ReturnType.IsByRef)
                    Assert.Equal(
                        Issue4790StaticExtensionHolderAbiTests.Contract(expected),
                        Issue4790StaticExtensionHolderAbiTests.Contract(original)
                    )
                    Assert.Equal(
                        expected!!.ReturnParameter.GetRequiredCustomModifiers().Select((type Type) -> type.FullName),
                        original!!.ReturnParameter.GetRequiredCustomModifiers().Select((type Type) -> type.FullName)
                    )
                    Assert.Null(
                        images[1].GetType("Issue4790.Contracts.Node", throwOnError: true)!!.GetMethod(
                            name,
                            BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly
                        )
                    )
                }
            },
            source,
            consumerSource
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func IteratorOwnedExtensions_PreserveLazyHolderAndCanonicalEnumeration(asyncIterator bool) {
        let envelope = if asyncIterator {
            "IAsyncEnumerable"
        } else {
            "IEnumerable"
        }
        let modifier = if asyncIterator {
            "async "
        } else {
            string.Empty
        }
        let awaitFirst = if asyncIterator {
            "await System.Threading.Tasks.Task.Delay(1).ConfigureAwait(false);"
        } else {
            string.Empty
        }
        let getCursor = if asyncIterator {
            "GetAsyncEnumerator()"
        } else {
            "GetEnumerator()"
        }
        let advance = if asyncIterator {
            "MoveNextAsync().AsTask().GetAwaiter().GetResult()"
        } else {
            "MoveNext()"
        }
        let dispose = if asyncIterator {
            "DisposeAsync().AsTask().GetAwaiter().GetResult()"
        } else {
            "Dispose()"
        }
        let source = (`using System.Collections.Generic;
namespace Issue4790.Contracts;
public sealed class Node { public int Value = 4; public int Moves; }
public static class Holder
{
    public static ` + "$modifier" + "$envelope" + `<int> Values(this Node node)
    {
        ` + "$awaitFirst" + `
        node.Moves++;
        yield return node.Value;
        node.Value += 3;
        node.Moves++;
        yield return node.Value;
    }
    public static int Exercise(Node node)
    {
        var values = node.Values();
        int before = node.Moves;
        var cursor = values.` + "$getCursor" + `;
        if (!cursor.` + "$advance" + `) return -1;
        int first = cursor.Current;
        node.Value = 20;
        if (!cursor.` + "$advance" + `) return -2;
        int second = cursor.Current;
        if (cursor.` + "$advance" + `) return -3;
        cursor.` + "$dispose" + `;
        return before * 100000 + first * 1000 + second * 10 + node.Moves;
    }
}`)
        let consumerSource = (`using System;
using System.Collections.Generic;
using Issue4790.Contracts;
public static class NativeConsumer
{
    public static string Run()
    {
        var node = new Node();
        Func<Node, ` + "$envelope" + `<int>> original = Holder.Values;
        var values = original(node);
        int before = node.Moves;
        var cursor = values.` + "$getCursor" + `;
        if (!cursor.` + "$advance" + `) return "missing-first";
        int first = cursor.Current;
        node.Value = 20;
        if (!cursor.` + "$advance" + `) return "missing-second";
        int second = cursor.Current;
        bool extra = cursor.` + "$advance" + `;
        cursor.` + "$dispose" + `;
        return string.Join(",", new object[] {
            before, first, second, node.Moves, extra ? 1 : 0,
            Holder.Exercise(new Node()),
            original.Method.IsStatic && original.Method.DeclaringType == typeof(Holder) ? 1 : 0 });
    }
}`)
        WithProducts(
            (native string, emitted string, consumer CSharpFixture) -> {
                Assert.Equal("0,4,23,2,0,4232,1", RunConsumer(native, consumer))
                Assert.Equal("0,4,23,2,0,4232,1", RunConsumer(emitted, consumer))
                let expected = consumer.LoadTogether(File.ReadAllBytes(native))[0]
                let actual = consumer.LoadTogether(File.ReadAllBytes(emitted))[0]
                let original MethodInfo? = actual.GetType("Issue4790.Contracts.Holder", throwOnError: true)!!.GetMethod(
                    "Values",
                    BindingFlags.Public | BindingFlags.Static
                )
                Assert.NotNull(original)
                Assert.Equal(
                    Issue4790StaticExtensionHolderAbiTests.Contract(
                        expected.GetType("Issue4790.Contracts.Holder", throwOnError: true)!!.GetMethod(
                            "Values",
                            BindingFlags.Public | BindingFlags.Static
                        )
                    ),
                    Issue4790StaticExtensionHolderAbiTests.Contract(original)
                )
                Assert.Null(
                    actual.GetType("Issue4790.Contracts.Node", throwOnError: true)!!.GetMethod(
                        "Values",
                        BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly
                    )
                )
            },
            source,
            consumerSource
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func TaskEnvelopeForwarding_PreservesOriginalContinuationContext(generic bool) {
        let envelope = if generic {
            "Task<int>"
        } else {
            "Task"
        }
        let returned = if generic {
            "return 23;"
        } else {
            string.Empty
        }
        let source = (`using System.Threading.Tasks;
namespace Issue4790.Contracts;
public sealed class Node {
    public TaskCompletionSource<int> Gate = new TaskCompletionSource<int>();
    public int Calls;
}
public static class Holder {
    public static async ` + "$envelope" + ` Value(this Node node) {
        node.Calls++;
        await node.Gate.Task.ConfigureAwait(false);
        ` + "$returned" + `
    }
    public static ` + "$envelope" + ` Reduced(Node node) => node.Value();
}`)
        let consumerSource = `using System;
using System.Threading;
using Issue4790.Contracts;
public static class NativeConsumer {
    private sealed class CountingContext : SynchronizationContext {
        public int Posts;
        public override void Post(SendOrPostCallback callback, object state) {
            Interlocked.Increment(ref Posts);
            ThreadPool.QueueUserWorkItem(_ => callback(state));
        }
    }
    public static string Run() {
        var node = new Node();
        var context = new CountingContext();
        var previous = SynchronizationContext.Current;
        SynchronizationContext.SetSynchronizationContext(context);
        System.Threading.Tasks.Task task;
        try { task = Holder.Reduced(node); }
        finally { SynchronizationContext.SetSynchronizationContext(previous); }
        int before = node.Calls;
        node.Gate.SetResult(23);
        task.GetAwaiter().GetResult();
        return string.Join(",", new object[] { before, node.Calls, context.Posts });
    }
}`
        WithProducts(
            (native string, emitted string, consumer CSharpFixture) -> {
                Assert.Equal("1,1,0", RunConsumer(native, consumer))
                Assert.Equal("1,1,0", RunConsumer(emitted, consumer))
                let actual = consumer.LoadTogether(File.ReadAllBytes(emitted))[0]
                Assert.Null(
                    actual.GetType("Issue4790.Contracts.Node", throwOnError: true)!!.GetMethod(
                        "Value",
                        BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly
                    )
                )
            },
            source,
            consumerSource
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func TaskLikeForwarding_ReturnsTheOriginalEnvelope(valueTask bool) {
        let envelope = if valueTask {
            "ValueTask<int>"
        } else {
            "Task<int>"
        }
        let returned = if valueTask {
            "new ValueTask<int>(node.Promise.Task)"
        } else {
            "node.Promise.Task"
        }
        let observed = if valueTask {
            "reduced.Equals(new ValueTask<int>(node.Promise.Task))"
        } else {
            "object.ReferenceEquals(reduced, node.Promise.Task)"
        }
        let source = (`using System.Threading.Tasks;
namespace Issue4790.Contracts;
public sealed class Node {
    public TaskCompletionSource<int> Promise = new TaskCompletionSource<int>();
    public int Calls;
}
public static class Holder {
    public static ` + "$envelope" + ` Value(this Node node) {
        node.Calls++;
        return ` + "$returned" + `;
    }
    public static ` + "$envelope" + ` Reduced(Node node) => node.Value();
}`)
        let consumerSource = (`using System;
using System.Threading.Tasks;
using Issue4790.Contracts;
public static class NativeConsumer {
    public static string Run() {
        var node = new Node();
        var reduced = Holder.Reduced(node);
        bool same = ` + "$observed" + `;
        int before = node.Calls;
        node.Promise.SetResult(23);
        return string.Join(",", new object[] { same ? 1 : 0, before,
            reduced.GetAwaiter().GetResult(), node.Calls });
    }
}`)
        WithProducts(
            (native string, emitted string, consumer CSharpFixture) -> {
                Assert.Equal("1,1,23,1", RunConsumer(native, consumer))
                Assert.Equal("1,1,23,1", RunConsumer(emitted, consumer))
            },
            source,
            consumerSource
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func IteratorForwarding_PreservesReplayAndDisposal(asyncIterator bool) {
        let envelope = if asyncIterator {
            "IAsyncEnumerable"
        } else {
            "IEnumerable"
        }
        let modifier = if asyncIterator {
            "async "
        } else {
            string.Empty
        }
        let awaitFirst = if asyncIterator {
            "await System.Threading.Tasks.Task.Delay(1).ConfigureAwait(false);"
        } else {
            string.Empty
        }
        let getCursor = if asyncIterator {
            "GetAsyncEnumerator()"
        } else {
            "GetEnumerator()"
        }
        let advance = if asyncIterator {
            "MoveNextAsync().AsTask().GetAwaiter().GetResult()"
        } else {
            "MoveNext()"
        }
        let dispose = if asyncIterator {
            "DisposeAsync().AsTask().GetAwaiter().GetResult()"
        } else {
            "Dispose()"
        }
        let source = (`using System.Collections.Generic;
namespace Issue4790.Contracts;
public sealed class Node { public int Value = 4; public int Starts; public int Disposals; }
public static class Holder {
    public static ` + "$modifier" + "$envelope" + `<int> Values(this Node node) {
        ` + "$awaitFirst" + `
        node.Starts++;
        try {
            yield return node.Value;
            node.Value += 3;
            yield return node.Value;
        }
        finally { node.Disposals++; }
    }
    public static ` + "$envelope" + `<int> Reduced(Node node) => node.Values();
}`)
        let consumerSource = (`using System;
using Issue4790.Contracts;
public static class NativeConsumer {
    public static string Run() {
        var node = new Node();
        var values = Holder.Reduced(node);
        int before = node.Starts;
        var cursor = values.` + "$getCursor" + `;
        if (!cursor.` + "$advance" + `) return "missing-first";
        int first = cursor.Current;
        cursor.` + "$dispose" + `;
        int early = node.Disposals;
        node.Value = 9;
        cursor = values.` + "$getCursor" + `;
        if (!cursor.` + "$advance" + `) return "missing-replay";
        int replay = cursor.Current;
        node.Value = 20;
        if (!cursor.` + "$advance" + `) return "missing-second";
        int second = cursor.Current;
        if (cursor.` + "$advance" + `) return "extra";
        cursor.` + "$dispose" + `;
        return string.Join(",", new object[] {
            before, first, early, replay, second, node.Starts, node.Disposals });
    }
}`)
        WithProducts(
            (native string, emitted string, consumer CSharpFixture) -> {
                Assert.Equal("0,4,1,9,23,2,2", RunConsumer(native, consumer))
                Assert.Equal("0,4,1,9,23,2,2", RunConsumer(emitted, consumer))
            },
            source,
            consumerSource
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func IteratorForwarding_PreservesHostedElementPromotion(explicitNullable bool) {
        let nullable = if explicitNullable {
            "#nullable enable"
        } else {
            "#nullable disable"
        }
        let element = if explicitNullable {
            "string?"
        } else {
            "string"
        }
        let source = ("" + "$nullable" + `
using System.Collections.Generic;
namespace Issue4790.Contracts;
public sealed class Node { public ` + "$element" + ` Text = null; }
public static class Holder {
    public static IEnumerable<` + "$element" + `> Values(this Node node) { yield return node.Text; }
    public static bool Exercise(Node node) {
        foreach (var value in node.Values()) return value == null;
        return false;
    }
}`)
        let consumerSource = `using Issue4790.Contracts;
public static class NativeConsumer {
    public static string Run() => Holder.Exercise(new Node()) ? "1" : "0";
}`
        WithProducts(
            (native string, emitted string, consumer CSharpFixture) -> {
                Assert.Equal("1", RunConsumer(native, consumer))
                Assert.Equal("1", RunConsumer(emitted, consumer))
                let workspace string? = Path.GetDirectoryName(Path.GetDirectoryName(native))
                let translated = File.ReadAllText(Path.Combine(workspace!!, "Producer.gs"))
                Assert.Contains("func (node Node) Values() sequence[string?]", translated)
                Assert.Equal(1, translated.Split(" Values()", StringSplitOptions.None).Length - 1)
            },
            source,
            consumerSource
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func WithProducts_DeletesWorkspaceAfterAssertions(failAssertion bool) {
        var workspace string? = nil
        let expected = InvalidOperationException("cleanup witness")
        let Run = func () {
            WithProducts(
                (native string, emitted string, consumer CSharpFixture) -> {
                    workspace = Path.GetDirectoryName(Path.GetDirectoryName(native))
                    Assert.True(Directory.Exists(workspace))
                    Assert.Equal(RunConsumer(native, consumer), RunConsumer(emitted, consumer))
                    if failAssertion {
                        throw expected
                    }
                }
            )
        }
        if failAssertion {
            Assert.Same(expected, Assert.Throws[InvalidOperationException](Run))
        } else {
            Run()
        }
        Assert.NotNull(workspace)
        Assert.False(Directory.Exists(workspace))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func HostedReceiverAttributes_PreserveNativeParameterMetadata(privateExtension bool) {
        let source = `#nullable enable
using System;
using System.Diagnostics.CodeAnalysis;
namespace Issue4790.Contracts;
[AttributeUsage(AttributeTargets.Parameter)]
public sealed class StampAttribute : Attribute
{
    public StampAttribute(string label, int code, bool visible) { }
}
public sealed class Node { public int Value = 4; }
public static class Holder
{
    ACCESS static bool Try(
        [NotNullWhen(true), Stamp("receiver", 17, true)] this Node node,
        [Stamp("ordinary", 23, false)] int delta = 3) => node.Value + delta == 7;
    public static bool Reduced(Node node) => node.Try();
}`.Replace(
            "ACCESS",
            if privateExtension {
                "private"
            } else {
                "public"
            },
            StringComparison.Ordinal
        )
        const consumerSource = `using System;
using System.Linq;
using System.Reflection;
using Issue4790.Contracts;
public static class NativeConsumer
{
    public static string Run()
    {
        MethodInfo method = typeof(Holder).GetMethod("Try",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        ParameterInfo receiver = method.GetParameters()[0];
        CustomAttributeData stamp = receiver.GetCustomAttributesData().Single(
            attribute => attribute.AttributeType.FullName == "Issue4790.Contracts.StampAttribute");
        CustomAttributeData postcondition = receiver.GetCustomAttributesData().Single(
            attribute => attribute.AttributeType.FullName ==
                "System.Diagnostics.CodeAnalysis.NotNullWhenAttribute");
        return string.Join(",", new object[] { Holder.Reduced(new Node()),
            method.IsPrivate ? 1 : 0, stamp.ConstructorArguments[0].Value,
            stamp.ConstructorArguments[1].Value, stamp.ConstructorArguments[2].Value,
            postcondition.ConstructorArguments[0].Value });
    }
}`
        WithProducts(
            (native string, emitted string, consumer CSharpFixture) -> {
                let expected = if privateExtension {
                    "True,1,receiver,17,True,True"
                } else {
                    "True,0,receiver,17,True,True"
                }
                Assert.Equal(expected, RunConsumer(native, consumer))
                let images[]Assembly = []Assembly{
                    consumer.LoadTogether(File.ReadAllBytes(native))[0],
                    consumer.LoadTogether(File.ReadAllBytes(emitted))[0]
                }
                let methods = images.Select(
                    (image Assembly) -> image.GetType("Issue4790.Contracts.Holder", throwOnError: true)!!.GetMethod(
                        "Try",
                        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
                    )!!
                )
                    .ToArray()
                Assert.All(
                    methods,
                    (method MethodInfo) -> {
                        Assert.NotNull(method)
                        Assert.True(method.IsStatic)
                        Assert.Equal(privateExtension, method.IsPrivate)
                        Assert.Equal(2, method.GetParameters().Length)
                    }
                )
                let nativeParameters = methods[0].GetParameters()
                let emittedParameters = methods[1].GetParameters()
                Assert.Equal(
                    2,
                    nativeParameters[0].GetCustomAttributesData().Count(
                        (attribute CustomAttributeData) -> (
                            attribute
                                .AttributeType
                                .FullName is "System.Diagnostics.CodeAnalysis.NotNullWhenAttribute" or
                                "Issue4790.Contracts.StampAttribute"
                        )
                    )
                )
                for var index = 0; index < nativeParameters.Length; index++ {
                    let Attributes = func (parameter ParameterInfo)[]string {
                        return parameter
                            .GetCustomAttributesData()
                            .Where(
                            (attribute CustomAttributeData) -> (
                                attribute
                                    .AttributeType
                                    .FullName is "System.Diagnostics.CodeAnalysis.NotNullWhenAttribute" or
                                    "Issue4790.Contracts.StampAttribute"
                            )
                        )
                            .Select(
                            (attribute CustomAttributeData) -> (
                                attribute.AttributeType.FullName + ":" + string.Join(
                                    ",",
                                    attribute.ConstructorArguments.Select(
                                        (argument CustomAttributeTypedArgument) -> FormatAttributeArgument(
                                            argument.Value
                                        )
                                    )
                                ) +
                                    ":" +
                                    string
                                    .Join(
                                    ",",
                                    attribute.NamedArguments.Select(
                                        (argument CustomAttributeNamedArgument) -> argument.MemberName +
                                            "=" +
                                            FormatAttributeArgument(argument.TypedValue.Value)
                                    )
                                )
                            )
                        )
                            .OrderBy((value string) -> value, StringComparer.Ordinal)
                            .ToArray()
                    }
                    Assert.Equal(Attributes(nativeParameters[index]), Attributes(emittedParameters[index]))
                    Assert.Equal(nativeParameters[index].Attributes, emittedParameters[index].Attributes)
                }
                Assert.Equal(expected, RunConsumer(emitted, consumer))
            },
            source,
            consumerSource
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func SuspendingOwnedExtensions_PreserveDeclaredContextWithoutReceiverAbi(marked bool) {
        let attribute = if marked {
            "[Suspending]"
        } else {
            string.Empty
        }
        let source = (`using System.Diagnostics.CodeAnalysis;
using System.Threading.Tasks;
using Gsharp.Concurrency;
namespace Issue4790.Suspension;
public sealed class Node
{
    public TaskCompletionSource<int> Gate = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public int Calls;
}
public static class Holder
{
    ` + "$attribute" + `
    public static async ValueTask<int> Read([NotNull] this Node node, Context context)
    {
        node.Calls++;
        return await node.Gate.Task;
    }
    ` + "$attribute" + `
    public static async ValueTask Drain([NotNull] this Node node, Context context)
    {
        node.Calls++;
        await node.Gate.Task;
    }
}`)
        const consumerSource = `using Gsharp.Concurrency;
using Issue4790.Suspension;
public static class NativeConsumer
{
    public static string Run()
    {
        var node = new Node();
        var pending = node.Read(Context.None);
        string before = node.Calls + "," + pending.IsCompleted;
        node.Gate.SetResult(17);
        int result = pending.AsTask().GetAwaiter().GetResult();
        var other = new Node();
        var drain = other.Drain(Context.None);
        string drainBefore = other.Calls + "," + drain.IsCompleted;
        other.Gate.SetResult(23);
        drain.AsTask().GetAwaiter().GetResult();
        return before + "," + result + "," + node.Calls + "," + drainBefore + "," + other.Calls;
    }
}`
        WithProducts(
            source: source,
            consumerSource: consumerSource,
            assertion: (native string, emitted string, consumer CSharpFixture) -> {
                Assert.Equal("1,False,17,1,1,False,1", RunConsumer(native, consumer))
                Assert.Equal("1,False,17,1,1,False,1", RunConsumer(emitted, consumer))
                let nativeImage = consumer.LoadTogether(File.ReadAllBytes(native))[0]
                let emittedImage = consumer.LoadTogether(File.ReadAllBytes(emitted))[0]
                let nativeOwner Type? = nativeImage.GetType("Issue4790.Suspension.Holder", throwOnError: true)
                let emittedOwner Type? = emittedImage.GetType("Issue4790.Suspension.Holder", throwOnError: true)
                let receiver Type? = emittedImage.GetType("Issue4790.Suspension.Node", throwOnError: true)
                for name in[]string{"Read", "Drain"} {
                    let original MethodInfo? = nativeOwner!!.GetMethod(name)
                    let hosted MethodInfo? = emittedOwner!!.GetMethod(name)
                    Assert.Equal(
                        Issue4790StaticExtensionHolderAbiTests.Contract(original),
                        Issue4790StaticExtensionHolderAbiTests.Contract(hosted)
                    )
                    Assert.True(hosted!!.IsPublic && hosted!!.IsStatic)
                    Assert.Equal(2, hosted!!.GetParameters().Length)
                    Assert.Single(
                        hosted!!.GetCustomAttributesData(),
                        (a CustomAttributeData) -> a.AttributeType == typeof(SuspendingAttribute)
                    )
                    Assert.Equal(
                        original!!
                            .GetParameters()[0]
                            .GetCustomAttributesData()
                            .Select((a CustomAttributeData) -> a.AttributeType.FullName),
                        hosted!!
                            .GetParameters()[0]
                            .GetCustomAttributesData()
                            .Select((a CustomAttributeData) -> a.AttributeType.FullName)
                    )
                    Assert.Null(
                        receiver!!.GetMethod(
                            name,
                            BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly
                        )
                    )
                }
            }
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func NonGenericTaskLikeForwarding_ReturnsTheOriginalEnvelope(valueTask bool) {
        let envelope = if valueTask {
            "ValueTask"
        } else {
            "Task"
        }
        let returned = if valueTask {
            "new ValueTask(node.Envelope)"
        } else {
            "node.Envelope"
        }
        let source = (`using System.Threading.Tasks;
namespace Issue4790.NonGeneric;
public sealed class Node
{
    public Task Envelope;
    public int Calls;
    public Node(Task envelope) { Envelope = envelope; }
}
public static class Holder
{
    public static ` + "$envelope" + ` Pass(this Node node)
    {
        node.Calls++;
        return ` + "$returned" + `;
    }
}`)
        let task = if valueTask {
            "pending.AsTask()"
        } else {
            "pending"
        }
        let consumerSource = (`using System;
using System.Threading.Tasks;
using Issue4790.NonGeneric;
public static class NativeConsumer
{
    public static string Run()
    {
        var gate = new TaskCompletionSource<int>();
        var node = new Node(gate.Task);
        var pending = node.Pass();
        return ReferenceEquals(gate.Task, ` + "$task" + `) + "," + node.Calls + "," + pending.IsCompleted;
    }
}`)
        WithProducts(
            source: source,
            consumerSource: consumerSource,
            assertion: (native string, emitted string, consumer CSharpFixture) -> {
                Assert.Equal("True,1,False", RunConsumer(native, consumer))
                Assert.Equal("True,1,False", RunConsumer(emitted, consumer))
                let image = consumer.LoadTogether(File.ReadAllBytes(emitted))[0]
                let receiver Type? = image.GetType("Issue4790.NonGeneric.Node", throwOnError: true)
                Assert.Null(
                    receiver!!.GetMethod(
                        "Pass",
                        BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly
                    )
                )
                let hosted MethodInfo? = image.GetType("Issue4790.NonGeneric.Holder", throwOnError: true)!!.GetMethod(
                    "Pass",
                    BindingFlags.Public | BindingFlags.Static
                )
                Assert.NotNull(hosted)
                Assert.Equal(
                    if valueTask {
                        typeof(ValueTask)
                    } else {
                        typeof(Task)
                    },
                    hosted!!.ReturnType
                )
            }
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func SuspendingOwnedExtensionWithoutContext_ReportsLocatedUnsupportedAbi(marked bool) {
        let attribute = if marked {
            "[Suspending]"
        } else {
            string.Empty
        }
        let source = (`using System.Threading.Tasks;
using Gsharp.Concurrency;
namespace Issue4790.Unrepresentable;
public sealed class Node { }
public static class Holder
{
    ` + "$attribute" + `
    public static async ValueTask<int> Read(this Node node)
    {
        var context = Context.None;
        await Task.CompletedTask;
        return 17;
    }
}`)
        let runtime MetadataReference = MetadataReference.CreateFromFile(typeof(Context).Assembly.Location)
        using let native = CSharpFixture(source, []MetadataReference{runtime})
        let original MethodInfo? = native.Load().GetType("Issue4790.Unrepresentable.Holder")!!.GetMethod("Read")
        Assert.Single(original!!.GetParameters())
        Assert.True(original!!.IsPublic && original!!.IsStatic)
        Assert.Equal(typeof(ValueTask[int32]), original!!.ReturnType)
        let tree = CSharpSyntaxTree.ParseText(source, path: "Producer.cs")
        let references = CSharpProjectLoader.RuntimeReferences().Concat([]MetadataReference{runtime})
        let compilation = CSharpCompilation.Create(
            "UnsupportedSuspend",
            []SyntaxTree{tree},
            references,
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        Assert.DoesNotContain(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let model = compilation.GetSemanticModel(tree)
        let document = LoadedDocument(tree.FilePath, tree, model)
        let context = TranslationContext(compilation, model, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        let diagnostic = Assert.Single(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        Assert.Contains("native static-holder signature", diagnostic.Message, StringComparison.Ordinal)
        Assert.Equal("Producer.cs", diagnostic.Location!!.GetLineSpan().Path)
        Assert.Contains(
            "ValueTask<int> Read",
            source.Substring(diagnostic.Location!!.SourceSpan.Start, diagnostic.Location!!.SourceSpan.Length),
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("func Read(", rendered, StringComparison.Ordinal)
    }

    shared {
        private const Source string = `#nullable enable
using System;
namespace Issue4790.Contracts;

public sealed class Node
{
    public int Value;
    public Node(int value) { Value = value; }
    public int Existing(int value) => Value + value;
    public sealed class Token { }
}

public static class Holder
{
    private static int Bias = 7;
    private static int Help(int value) => value + Bias;
    public static int Read(this Node node, int delta = 3) => Help(node.Value) + delta;
    public static T Echo<T>(this Node node, T result) where T : class, new() => result;
    public static int NullAllowed(this Node? node)
    {
        if (node is null) return -9;
        return Help(node.Value);
    }
    public static int Text(this string text) => Help(text.Length);
    public static int Exercise(Node node)
    {
        int hits = 0;
        Node Next() { hits++; return node; }
        Func<int, int> bound = Next().Read;
        return bound(2) + Read(node, 4) + Next().Read() + hits;
    }
}`

        private const Consumer string = `using System;
using Issue4790.Contracts;
public static class NativeConsumer
{
    public static string Run()
    {
        var node = new Node(4);
        Func<Node, int, int> original = Holder.Read;
        var token = new Node.Token();
        return string.Join(",", new object[] { Holder.Read(node), original(node, 2),
            Holder.Exercise(node), Holder.NullAllowed(null), Holder.Text("abc"),
            Holder.Echo(node, token) == token ? 1 : 0, node.Existing(2) });
    }
}`

        private func Contract(method MethodInfo?) string -> string.Join(
            "|",
            method!!.Name,
            method!!.Attributes,
            method!!.ReturnType,
            string.Join(
                ";",
                method!!.GetParameters().Select(
                    (parameter ParameterInfo) -> string.Join(
                        ":",
                        parameter.Name,
                        parameter.ParameterType,
                        parameter.Attributes,
                        if parameter.HasDefaultValue {
                            parameter.DefaultValue
                        } else {
                            cast[object]("<none>")
                        },
                        string.Join(",", parameter.GetRequiredCustomModifiers().Select((type Type) -> type.FullName)),
                        string.Join(",", parameter.GetOptionalCustomModifiers().Select((type Type) -> type.FullName))
                    )
                )
            ),
            string.Join(
                ";",
                method!!.GetGenericArguments().Select(
                    (parameter Type) -> string.Join(
                        ":",
                        parameter.Name,
                        parameter.GenericParameterAttributes,
                        string.Join(
                            ",",
                            parameter.GetGenericParameterConstraints().Select((type Type) -> type.FullName)
                        )
                    )
                )
            )
        )

        private func RunConsumer(target string, consumer CSharpFixture) string {
            let images = consumer.LoadTogether(File.ReadAllBytes(target), File.ReadAllBytes(consumer.AssemblyPath))
            let type Type? = images[1].GetType("NativeConsumer", throwOnError: true)
            let run MethodInfo? = type!!.GetMethod("Run", BindingFlags.Public | BindingFlags.Static)
            Assert.NotNull(run)
            return Assert.IsType[string](run!!.Invoke(nil, nil))
        }

        private func FormatAttributeArgument(value object?) string -> value?.ToString() ?? string.Empty

        private func WithProducts(assertion(string, string, CSharpFixture) -> void, source string = `#nullable enable
using System;
namespace Issue4790.Contracts;

public sealed class Node
{
    public int Value;
    public Node(int value) { Value = value; }
    public int Existing(int value) => Value + value;
    public sealed class Token { }
}

public static class Holder
{
    private static int Bias = 7;
    private static int Help(int value) => value + Bias;
    public static int Read(this Node node, int delta = 3) => Help(node.Value) + delta;
    public static T Echo<T>(this Node node, T result) where T : class, new() => result;
    public static int NullAllowed(this Node? node)
    {
        if (node is null) return -9;
        return Help(node.Value);
    }
    public static int Text(this string text) => Help(text.Length);
    public static int Exercise(Node node)
    {
        int hits = 0;
        Node Next() { hits++; return node; }
        Func<int, int> bound = Next().Read;
        return bound(2) + Read(node, 4) + Next().Read() + hits;
    }
}`, consumerSource string = `using System;
using Issue4790.Contracts;
public static class NativeConsumer
{
    public static string Run()
    {
        var node = new Node(4);
        Func<Node, int, int> original = Holder.Read;
        var token = new Node.Token();
        return string.Join(",", new object[] { Holder.Read(node), original(node, 2),
            Holder.Exercise(node), Holder.NullAllowed(null), Holder.Text("abc"),
            Holder.Echo(node, token) == token ? 1 : 0, node.Existing(2) });
    }
}`) {
            let runtime = typeof(Context).Assembly.Location
            let runtimeReference MetadataReference = MetadataReference.CreateFromFile(runtime)
            using let native = CSharpFixture(source, []MetadataReference{runtimeReference})
            using let consumer = CSharpFixture(
                consumerSource,
                []MetadataReference{MetadataReference.CreateFromFile(native.AssemblyPath), runtimeReference}
            )
            let directory = Path.Combine(AppContext.BaseDirectory, "issue4790-fixtures", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                let nativeDirectory = Path.Combine(directory, "native")
                let emittedDirectory = Path.Combine(directory, "gs")
                Directory.CreateDirectory(nativeDirectory)
                Directory.CreateDirectory(emittedDirectory)
                let nativePath = Path.Combine(nativeDirectory, Path.GetFileName(native.AssemblyPath))
                let emittedPath = Path.Combine(emittedDirectory, Path.GetFileName(native.AssemblyPath))
                let consumerPath = Path.Combine(directory, Path.GetFileName(consumer.AssemblyPath))
                File.Copy(native.AssemblyPath, nativePath)
                File.Copy(consumer.AssemblyPath, consumerPath)
                File.WriteAllText(Path.Combine(directory, "Producer.cs.txt"), source)
                File.WriteAllText(Path.Combine(directory, "Consumer.cs.txt"), consumerSource)
                let tree = CSharpSyntaxTree.ParseText(
                    source,
                    CSharpParseOptions(LanguageVersion.Latest),
                    path: "Producer.cs"
                )
                let references = Directory
                    .GetFiles(RuntimeEnvironment.GetRuntimeDirectory(), "*.dll")
                    .Append(runtime)
                    .ToArray()
                Assert.NotEmpty(references)
                let compilation = CSharpCompilation.Create(
                    Path.GetFileNameWithoutExtension(native.AssemblyPath),
                    []SyntaxTree{tree},
                    references.Select((path string) -> MetadataReference.CreateFromFile(path)),
                    CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                )
                Assert.DoesNotContain(
                    compilation.GetDiagnostics(),
                    (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
                )
                let model = compilation.GetSemanticModel(tree)
                let document = LoadedDocument(tree.FilePath, tree, model)
                let context = TranslationContext(compilation, model, document.FilePath)
                let translated = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
                Assert.DoesNotContain(
                    context.Diagnostics,
                    (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
                )
                let gs = Path.Combine(directory, "Producer.gs")
                File.WriteAllText(gs, translated)
                let compiler string? = GscInvoker.Resolve(nil, "Release", AppContext.BaseDirectory)
                Assert.NotNull(compiler)
                let arguments = []string{
                    compiler!!,
                    "/target:library",
                    "/out:" + emittedPath,
                    "/assemblyname:" + Path.GetFileNameWithoutExtension(nativePath)
                }
                    .Concat(references.Select((reference string) -> ("/reference:" + reference)))
                    .Concat([]string{gs})
                    .ToArray()
                let result = ProcessRunner.Run("dotnet", arguments)
                File.WriteAllText(Path.Combine(directory, "gsc.stdout"), result.Output)
                File.WriteAllText(
                    Path.Combine(directory, "products.json"),
                    JsonSerializer.Serialize(
                        AnonymousType11_1C913249891F4635(
                            AnonymousType2_A0E35D836E8AFF97("Explicit Roslyn CSharpFixture", source),
                            AnonymousType2_85C1597DC471490F(
                                "Explicit Roslyn CSharpFixture, compiled once",
                                consumerSource
                            ),
                            AnonymousType2_EF761F1D4BC46F08(compiler, Hash(compiler)),
                            AnonymousType2_EF761F1D4BC46F08(
                                typeof(CSharpToGSharpTranslator).Assembly.Location,
                                Hash(typeof(CSharpToGSharpTranslator).Assembly.Location)
                            ),
                            Hash(typeof(Issue4790StaticExtensionHolderAbiTests).Assembly.Location),
                            AnonymousType2_EF761F1D4BC46F08(nativePath, Hash(nativePath)),
                            AnonymousType2_EF761F1D4BC46F08(consumerPath, Hash(consumerPath)),
                            if File.Exists(emittedPath) {
                                AnonymousType3_4DCEF2284799643F(
                                    emittedPath,
                                    Hash(emittedPath),
                                    AssemblyName.GetAssemblyName(emittedPath).FullName
                                )
                            } else {
                                default(AnonymousType3_4DCEF2284799643F?)
                            },
                            arguments,
                            references.Select(
                                (reference string) -> AnonymousType3_4DCEF2284799643F(
                                    reference,
                                    Hash(reference),
                                    AssemblyName.GetAssemblyName(reference).FullName
                                )
                            ),
                            result.ExitCode
                        ),
                        JsonSerializerOptions{WriteIndented: true}
                    )
                )
                Assert.True(result.ExitCode == 0, result.Output + Environment.NewLine + translated)
                Assert.True(File.Exists(emittedPath))
                assertion(nativePath, emittedPath, consumer)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func Hash(path string?) string -> Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path!!)))
            .ToLowerInvariant()
    }
}

internal data class AnonymousType2_A0E35D836E8AFF97(Kind string, Source string) { }

internal data class AnonymousType2_85C1597DC471490F(Kind string, Consumer string) { }

internal data class AnonymousType2_EF761F1D4BC46F08(Path string?, Sha256 string) { }

internal data class AnonymousType3_4DCEF2284799643F(Path string, Sha256 string, Identity string) { }

internal data class AnonymousType11_1C913249891F4635(
    NativeProducer AnonymousType2_A0E35D836E8AFF97,
    ConsumerProducer AnonymousType2_85C1597DC471490F,
    Compiler AnonymousType2_EF761F1D4BC46F08,
    Translator AnonymousType2_EF761F1D4BC46F08,
    TestAssemblySha256 string,
    Native AnonymousType2_EF761F1D4BC46F08,
    Consumer AnonymousType2_EF761F1D4BC46F08,
    Emitted AnonymousType3_4DCEF2284799643F?,
    GscArgv[]string?,
    FrameworkReferences IEnumerable[AnonymousType3_4DCEF2284799643F?],
    ExitCode int32
) { }
