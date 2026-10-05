// <copyright file="Issue4790StaticExtensionHolderAbiTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Core.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

public class Issue4790StaticExtensionHolderAbiTests
{
    private const string Source = """
        #nullable enable
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
        }
        """;

    private const string Consumer = """
        using System;
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
        }
        """;

    [Fact]
    public void OwnedExtensions_PreserveNativeHolderAndOnceCompiledConsumer()
    {
        WithProducts((native, emitted, consumer) =>
        {
            Assert.Equal("14,13,44,-9,10,1,6", RunConsumer(native, consumer));
            Assert.Equal("14,13,44,-9,10,1,6", RunConsumer(emitted, consumer));

            Assembly[] images = {
                consumer.LoadTogether(File.ReadAllBytes(native))[0],
                consumer.LoadTogether(File.ReadAllBytes(emitted))[0],
            };
            Type nativeOwner = images[0].GetType("Issue4790.Contracts.Holder", throwOnError: true);
            Type emittedOwner = images[1].GetType("Issue4790.Contracts.Holder", throwOnError: true);
            Assert.True(nativeOwner.IsAbstract && nativeOwner.IsSealed);
            Assert.True(emittedOwner.IsAbstract && emittedOwner.IsSealed);
            Assert.Single(emittedOwner.GetCustomAttributes<ExtensionAttribute>());
            MethodInfo[] methods = nativeOwner.GetMethods(
                BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly);
            Assert.Equal(5, methods.Length);
            foreach (MethodInfo method in methods)
            {
                MethodInfo actual = Assert.Single(
                    emittedOwner.GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly),
                    candidate => candidate.Name == method.Name);
                Assert.Equal(Contract(method), Contract(actual));
                Assert.Equal(
                    method.IsDefined(typeof(ExtensionAttribute)),
                    actual.IsDefined(typeof(ExtensionAttribute)));
            }

            Type receiver = images[1].GetType("Issue4790.Contracts.Node", throwOnError: true);
            MethodInfo bridge = Assert.Single(receiver.GetMethods(BindingFlags.Public | BindingFlags.Instance),
                method => method.Name == "Read" && method.GetParameters().Length == 1
                    && method.GetParameters()[0].ParameterType == typeof(int));
            Assert.False(bridge.IsStatic);
            Assert.False(bridge.IsVirtual);
        });
    }

    [Fact]
    public void HostedBodies_KeepNativePrivateHelpersAndFields()
    {
        WithProducts((native, emitted, consumer) =>
        {
            Assert.Equal(RunConsumer(native, consumer), RunConsumer(emitted, consumer));
            Assembly[] images = {
                consumer.LoadTogether(File.ReadAllBytes(native))[0],
                consumer.LoadTogether(File.ReadAllBytes(emitted))[0],
            };
            foreach (Assembly image in images)
            {
                Type owner = image.GetType("Issue4790.Contracts.Holder", throwOnError: true);
                MethodInfo[] helpers = owner.GetMethods(
                    BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.DeclaredOnly);
                Assert.NotEmpty(helpers);
                Assert.True(Assert.Single(helpers, method => method.Name == "Help").IsPrivate);
                FieldInfo field = owner.GetField("Bias", BindingFlags.NonPublic | BindingFlags.Static);
                Assert.NotNull(field);
                Assert.True(field.IsPrivate);
                Assert.Null(owner.GetMethod("Help", BindingFlags.Public | BindingFlags.Static));
            }
        });
    }

    [Fact]
    public void PrivateOwnedExtension_KeepsItsBodyAndVisibilityOnOriginalHolder()
    {
        const string source = """
            namespace Issue4790.Contracts;
            public sealed class Item { public int Value = 4; }
            public static class Holder
            {
                private static int Secret(this Item item) => item.Value + 7;
                public static int Exercise(Item item) => item.Secret();
            }
            """;
        const string consumerSource = """
            using Issue4790.Contracts;
            public static class NativeConsumer
            {
                public static string Run() => Holder.Exercise(new Item()).ToString();
            }
            """;
        WithProducts((native, emitted, consumer) =>
        {
            Assert.Equal("11", RunConsumer(native, consumer));
            Assert.Equal("11", RunConsumer(emitted, consumer));
            Assembly image = consumer.LoadTogether(File.ReadAllBytes(emitted))[0];
            Type owner = image.GetType("Issue4790.Contracts.Holder", throwOnError: true);
            MethodInfo helper = owner.GetMethod("Secret", BindingFlags.Static | BindingFlags.NonPublic);
            Assert.NotNull(helper);
            Assert.True(helper.IsPrivate);
            Type receiver = image.GetType("Issue4790.Contracts.Item", throwOnError: true);
            Assert.Null(receiver.GetMethod("Secret", BindingFlags.Instance | BindingFlags.NonPublic));
        }, source, consumerSource);
    }

    [Fact]
    public void OverloadsArraysAndGenericReceivers_KeepOriginalStaticContracts()
    {
        const string source = """
            namespace Issue4790.Contracts;
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
            }
            """;
        const string consumerSource = """
            using System;
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
            }
            """;
        WithProducts((native, emitted, consumer) =>
        {
            Assert.Equal("14,v4,14,11,box,28,1", RunConsumer(native, consumer));
            Assert.Equal("14,v4,14,11,box,28,1", RunConsumer(emitted, consumer));
            Assembly[] images = {
                consumer.LoadTogether(File.ReadAllBytes(native))[0],
                consumer.LoadTogether(File.ReadAllBytes(emitted))[0],
            };
            MethodInfo[][] methods = images.Select(image =>
                image.GetType("Issue4790.Contracts.Holder", throwOnError: true)
                    .GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly))
                .ToArray();
            Assert.Equal(6, methods[0].Length);
            Assert.Equal(methods[0].Select(Contract).OrderBy(contract => contract, StringComparer.Ordinal),
                methods[1].Select(Contract).OrderBy(contract => contract, StringComparer.Ordinal));
            foreach (MethodInfo method in methods[1])
            {
                Assert.Equal("Issue4790.Contracts.Holder", method.DeclaringType.FullName);
            }

            ParameterInfo nativeParams = Assert.Single(methods[0], method => method.Name == "Sum")
                .GetParameters()[1];
            ParameterInfo emittedParams = Assert.Single(methods[1], method => method.Name == "Sum")
                .GetParameters()[1];
            Assert.True(nativeParams.IsDefined(typeof(ParamArrayAttribute)));
            Assert.True(emittedParams.IsDefined(typeof(ParamArrayAttribute)));
        }, source, consumerSource);
    }

    private static string Contract(MethodInfo method) =>
        string.Join("|", method.Name, method.Attributes, method.ReturnType,
            string.Join(";", method.GetParameters().Select(parameter =>
                string.Join(":", parameter.Name, parameter.ParameterType, parameter.Attributes,
                    parameter.HasDefaultValue ? parameter.DefaultValue : "<none>",
                    string.Join(",", parameter.GetRequiredCustomModifiers().Select(type => type.FullName)),
                    string.Join(",", parameter.GetOptionalCustomModifiers().Select(type => type.FullName))))),
            string.Join(";", method.GetGenericArguments().Select(parameter =>
                string.Join(":", parameter.Name, parameter.GenericParameterAttributes,
                    string.Join(",", parameter.GetGenericParameterConstraints().Select(type => type.FullName))))));

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void RefReturningOwnedExtensions_PreserveHolderAndCanonicalLiveAliases(bool readOnly)
    {
        string returnKind = readOnly ? "ref readonly" : "ref";
        string source = $$"""
            namespace Issue4790.Contracts;
            public sealed class Node { public int Value = 4; }
            public static class Holder
            {
                public static {{returnKind}} int Slot(this Node node) => ref node.Value;
                public static {{returnKind}} int BlockSlot(this Node node) { return ref node.Value; }
                public static int Exercise(Node node)
                {
                    {{returnKind}} int alias = ref node.Slot();
                    node.Value += 3;
                    return alias;
                }
            }
            """;
        string write = readOnly ? "node.Value = 24;" : "alias = 24;";
        string consumerSource = $$"""
            using System;
            using Issue4790.Contracts;
            public static class NativeConsumer
            {
                private delegate {{returnKind}} int OriginalSlot(Node node);
                public static string Run()
                {
                    var node = new Node();
                    OriginalSlot original = Holder.Slot;
                    {{returnKind}} int alias = ref original(node);
                    {{returnKind}} int block = ref Holder.BlockSlot(node);
                    node.Value = 23;
                    int observed = alias;
                    {{write}}
                    return string.Join(",", new object[] {
                        observed, Holder.Exercise(node), block,
                        original.Method.IsStatic && original.Method.DeclaringType == typeof(Holder) ? 1 : 0 });
                }
            }
            """;
        WithProducts((native, emitted, consumer) =>
        {
            Assert.Equal("23,27,27,1", RunConsumer(native, consumer));
            Assert.Equal("23,27,27,1", RunConsumer(emitted, consumer));
            Assembly[] images = {
                consumer.LoadTogether(File.ReadAllBytes(native))[0],
                consumer.LoadTogether(File.ReadAllBytes(emitted))[0],
            };
            foreach (string name in new[] { "Slot", "BlockSlot" })
            {
                MethodInfo expected = images[0].GetType("Issue4790.Contracts.Holder", throwOnError: true)
                    .GetMethod(name, BindingFlags.Public | BindingFlags.Static);
                MethodInfo original = images[1].GetType("Issue4790.Contracts.Holder", throwOnError: true)
                    .GetMethod(name, BindingFlags.Public | BindingFlags.Static);
                MethodInfo canonical = images[1].GetType("Issue4790.Contracts.Node", throwOnError: true)
                    .GetMethod(name, BindingFlags.Public | BindingFlags.Instance);
                Assert.NotNull(expected);
                Assert.NotNull(original);
                Assert.NotNull(canonical);
                Assert.True(expected.ReturnType.IsByRef);
                Assert.Equal(Contract(expected), Contract(original));
                Assert.True(canonical.ReturnType.IsByRef);
                Assert.False(canonical.IsStatic);
                Assert.Equal(
                    expected.ReturnParameter.GetRequiredCustomModifiers().Select(type => type.FullName),
                    original.ReturnParameter.GetRequiredCustomModifiers().Select(type => type.FullName));
                Assert.Equal(
                    expected.ReturnParameter.GetRequiredCustomModifiers().Select(type => type.FullName),
                    canonical.ReturnParameter.GetRequiredCustomModifiers().Select(type => type.FullName));
            }
        }, source, consumerSource);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void IteratorOwnedExtensions_PreserveLazyHolderAndCanonicalEnumeration(bool asyncIterator)
    {
        string envelope = asyncIterator ? "IAsyncEnumerable" : "IEnumerable";
        string modifier = asyncIterator ? "async " : string.Empty;
        string awaitFirst = asyncIterator
            ? "await System.Threading.Tasks.Task.Delay(1).ConfigureAwait(false);"
            : string.Empty;
        string getCursor = asyncIterator ? "GetAsyncEnumerator()" : "GetEnumerator()";
        string advance = asyncIterator ? "MoveNextAsync().AsTask().GetAwaiter().GetResult()" : "MoveNext()";
        string dispose = asyncIterator ? "DisposeAsync().AsTask().GetAwaiter().GetResult()" : "Dispose()";
        string source = $$"""
            using System.Collections.Generic;
            namespace Issue4790.Contracts;
            public sealed class Node { public int Value = 4; public int Moves; }
            public static class Holder
            {
                public static {{modifier}}{{envelope}}<int> Values(this Node node)
                {
                    {{awaitFirst}}
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
                    var cursor = values.{{getCursor}};
                    if (!cursor.{{advance}}) return -1;
                    int first = cursor.Current;
                    node.Value = 20;
                    if (!cursor.{{advance}}) return -2;
                    int second = cursor.Current;
                    if (cursor.{{advance}}) return -3;
                    cursor.{{dispose}};
                    return before * 100000 + first * 1000 + second * 10 + node.Moves;
                }
            }
            """;
        string consumerSource = $$"""
            using System;
            using System.Collections.Generic;
            using Issue4790.Contracts;
            public static class NativeConsumer
            {
                public static string Run()
                {
                    var node = new Node();
                    Func<Node, {{envelope}}<int>> original = Holder.Values;
                    var values = original(node);
                    int before = node.Moves;
                    var cursor = values.{{getCursor}};
                    if (!cursor.{{advance}}) return "missing-first";
                    int first = cursor.Current;
                    node.Value = 20;
                    if (!cursor.{{advance}}) return "missing-second";
                    int second = cursor.Current;
                    bool extra = cursor.{{advance}};
                    cursor.{{dispose}};
                    return string.Join(",", new object[] {
                        before, first, second, node.Moves, extra ? 1 : 0,
                        Holder.Exercise(new Node()),
                        original.Method.IsStatic && original.Method.DeclaringType == typeof(Holder) ? 1 : 0 });
                }
            }
            """;
        WithProducts((native, emitted, consumer) =>
        {
            Assert.Equal("0,4,23,2,0,4232,1", RunConsumer(native, consumer));
            Assert.Equal("0,4,23,2,0,4232,1", RunConsumer(emitted, consumer));
            Assembly expected = consumer.LoadTogether(File.ReadAllBytes(native))[0];
            Assembly actual = consumer.LoadTogether(File.ReadAllBytes(emitted))[0];
            MethodInfo original = actual.GetType("Issue4790.Contracts.Holder", throwOnError: true)
                .GetMethod("Values", BindingFlags.Public | BindingFlags.Static);
            MethodInfo canonical = actual.GetType("Issue4790.Contracts.Node", throwOnError: true)
                .GetMethod("Values", BindingFlags.Public | BindingFlags.Instance);
            Assert.NotNull(original);
            Assert.NotNull(canonical);
            Assert.Equal(Contract(expected.GetType("Issue4790.Contracts.Holder", throwOnError: true)
                .GetMethod("Values", BindingFlags.Public | BindingFlags.Static)), Contract(original));
            Assert.Equal(asyncIterator
                ? typeof(System.Collections.Generic.IAsyncEnumerable<int>)
                : typeof(System.Collections.Generic.IEnumerable<int>), canonical.ReturnType);
            Assert.False(canonical.IsStatic);
            Assert.Empty(canonical.GetParameters());
        }, source, consumerSource);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void TaskEnvelopeForwarding_PreservesOriginalContinuationContext(bool generic)
    {
        string envelope = generic ? "Task<int>" : "Task";
        string returned = generic ? "return 23;" : string.Empty;
        string source = $$"""
            using System.Threading.Tasks;
            namespace Issue4790.Contracts;
            public sealed class Node {
                public TaskCompletionSource<int> Gate = new TaskCompletionSource<int>();
                public int Calls;
            }
            public static class Holder {
                public static async {{envelope}} Value(this Node node) {
                    node.Calls++;
                    await node.Gate.Task.ConfigureAwait(false);
                    {{returned}}
                }
                public static {{envelope}} Reduced(Node node) => node.Value();
            }
            """;
        string consumerSource = """
            using System;
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
            }
            """;
        WithProducts((native, emitted, consumer) =>
        {
            Assert.Equal("1,1,0", RunConsumer(native, consumer));
            Assert.Equal("1,1,0", RunConsumer(emitted, consumer));
            Assembly actual = consumer.LoadTogether(File.ReadAllBytes(emitted))[0];
            MethodInfo canonical = actual.GetType("Issue4790.Contracts.Node", throwOnError: true)
                .GetMethod("Value", BindingFlags.Public | BindingFlags.Instance);
            Assert.NotNull(canonical);
            Assert.False(canonical.IsStatic);
            Assert.Equal(generic ? typeof(System.Threading.Tasks.Task<int>) : typeof(System.Threading.Tasks.Task),
                canonical.ReturnType);
        }, source, consumerSource);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void TaskLikeForwarding_ReturnsTheOriginalEnvelope(bool valueTask)
    {
        string envelope = valueTask ? "ValueTask<int>" : "Task<int>";
        string returned = valueTask ? "new ValueTask<int>(node.Promise.Task)" : "node.Promise.Task";
        string observed = valueTask ? "reduced.Equals(new ValueTask<int>(node.Promise.Task))"
            : "object.ReferenceEquals(reduced, node.Promise.Task)";
        string source = $$"""
            using System.Threading.Tasks;
            namespace Issue4790.Contracts;
            public sealed class Node {
                public TaskCompletionSource<int> Promise = new TaskCompletionSource<int>();
                public int Calls;
            }
            public static class Holder {
                public static {{envelope}} Value(this Node node) {
                    node.Calls++;
                    return {{returned}};
                }
                public static {{envelope}} Reduced(Node node) => node.Value();
            }
            """;
        string consumerSource = $$"""
            using System;
            using System.Threading.Tasks;
            using Issue4790.Contracts;
            public static class NativeConsumer {
                public static string Run() {
                    var node = new Node();
                    var reduced = Holder.Reduced(node);
                    bool same = {{observed}};
                    int before = node.Calls;
                    node.Promise.SetResult(23);
                    return string.Join(",", new object[] { same ? 1 : 0, before,
                        reduced.GetAwaiter().GetResult(), node.Calls });
                }
            }
            """;
        WithProducts((native, emitted, consumer) =>
        {
            Assert.Equal("1,1,23,1", RunConsumer(native, consumer));
            Assert.Equal("1,1,23,1", RunConsumer(emitted, consumer));
        }, source, consumerSource);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void IteratorForwarding_PreservesReplayAndDisposal(bool asyncIterator)
    {
        string envelope = asyncIterator ? "IAsyncEnumerable" : "IEnumerable";
        string modifier = asyncIterator ? "async " : string.Empty;
        string awaitFirst = asyncIterator
            ? "await System.Threading.Tasks.Task.Delay(1).ConfigureAwait(false);" : string.Empty;
        string getCursor = asyncIterator ? "GetAsyncEnumerator()" : "GetEnumerator()";
        string advance = asyncIterator ? "MoveNextAsync().AsTask().GetAwaiter().GetResult()" : "MoveNext()";
        string dispose = asyncIterator ? "DisposeAsync().AsTask().GetAwaiter().GetResult()" : "Dispose()";
        string source = $$"""
            using System.Collections.Generic;
            namespace Issue4790.Contracts;
            public sealed class Node { public int Value = 4; public int Starts; public int Disposals; }
            public static class Holder {
                public static {{modifier}}{{envelope}}<int> Values(this Node node) {
                    {{awaitFirst}}
                    node.Starts++;
                    try {
                        yield return node.Value;
                        node.Value += 3;
                        yield return node.Value;
                    }
                    finally { node.Disposals++; }
                }
                public static {{envelope}}<int> Reduced(Node node) => node.Values();
            }
            """;
        string consumerSource = $$"""
            using System;
            using Issue4790.Contracts;
            public static class NativeConsumer {
                public static string Run() {
                    var node = new Node();
                    var values = Holder.Reduced(node);
                    int before = node.Starts;
                    var cursor = values.{{getCursor}};
                    if (!cursor.{{advance}}) return "missing-first";
                    int first = cursor.Current;
                    cursor.{{dispose}};
                    int early = node.Disposals;
                    node.Value = 9;
                    cursor = values.{{getCursor}};
                    if (!cursor.{{advance}}) return "missing-replay";
                    int replay = cursor.Current;
                    node.Value = 20;
                    if (!cursor.{{advance}}) return "missing-second";
                    int second = cursor.Current;
                    if (cursor.{{advance}}) return "extra";
                    cursor.{{dispose}};
                    return string.Join(",", new object[] {
                        before, first, early, replay, second, node.Starts, node.Disposals });
                }
            }
            """;
        WithProducts((native, emitted, consumer) =>
        {
            Assert.Equal("0,4,1,9,23,2,2", RunConsumer(native, consumer));
            Assert.Equal("0,4,1,9,23,2,2", RunConsumer(emitted, consumer));
        }, source, consumerSource);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void IteratorForwarding_PreservesHostedElementPromotion(bool explicitNullable)
    {
        string nullable = explicitNullable ? "#nullable enable" : "#nullable disable";
        string element = explicitNullable ? "string?" : "string";
        string source = $$"""
            {{nullable}}
            using System.Collections.Generic;
            namespace Issue4790.Contracts;
            public sealed class Node { public {{element}} Text = null; }
            public static class Holder {
                public static IEnumerable<{{element}}> Values(this Node node) { yield return node.Text; }
                public static bool Exercise(Node node) {
                    foreach (var value in node.Values()) return value == null;
                    return false;
                }
            }
            """;
        string consumerSource = """
            using Issue4790.Contracts;
            public static class NativeConsumer {
                public static string Run() => Holder.Exercise(new Node()) ? "1" : "0";
            }
            """;
        WithProducts((native, emitted, consumer) =>
        {
            Assert.Equal("1", RunConsumer(native, consumer));
            Assert.Equal("1", RunConsumer(emitted, consumer));
            string workspace = Path.GetDirectoryName(Path.GetDirectoryName(native));
            string translated = File.ReadAllText(Path.Combine(workspace, "Producer.gs"));
            Assert.Contains("func Values() IEnumerable[string?]", translated);
            Assert.Contains("func (node Node) Values() sequence[string?]", translated);
        }, source, consumerSource);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void WithProducts_DeletesWorkspaceAfterAssertions(bool failAssertion)
    {
        string workspace = null;
        var expected = new InvalidOperationException("cleanup witness");
        void Run() => WithProducts((native, emitted, consumer) =>
        {
            workspace = Path.GetDirectoryName(Path.GetDirectoryName(native));
            Assert.True(Directory.Exists(workspace));
            Assert.Equal(RunConsumer(native, consumer), RunConsumer(emitted, consumer));
            if (failAssertion)
            {
                throw expected;
            }
        });

        if (failAssertion)
        {
            Assert.Same(expected, Assert.Throws<InvalidOperationException>(Run));
        }
        else
        {
            Run();
        }

        Assert.NotNull(workspace);
        Assert.False(Directory.Exists(workspace));
    }

    private static string RunConsumer(string target, CSharpFixture consumer)
    {
        Assembly[] images = consumer.LoadTogether(
            File.ReadAllBytes(target), File.ReadAllBytes(consumer.AssemblyPath));
        Type type = images[1].GetType("NativeConsumer", throwOnError: true);
        MethodInfo run = type.GetMethod("Run", BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(run);
        return Assert.IsType<string>(run.Invoke(null, null));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void HostedReceiverAttributes_PreserveNativeParameterMetadata(bool privateExtension)
    {
        string source = """
            #nullable enable
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
            }
            """.Replace("ACCESS", privateExtension ? "private" : "public", StringComparison.Ordinal);
        const string consumerSource = """
            using System;
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
            }
            """;
        WithProducts((native, emitted, consumer) =>
        {
            string expected = privateExtension ? "True,1,receiver,17,True,True" : "True,0,receiver,17,True,True";
            Assert.Equal(expected, RunConsumer(native, consumer));
            Assembly[] images = {
                consumer.LoadTogether(File.ReadAllBytes(native))[0],
                consumer.LoadTogether(File.ReadAllBytes(emitted))[0],
            };
            MethodInfo[] methods = images.Select(image =>
                image.GetType("Issue4790.Contracts.Holder", throwOnError: true)
                    .GetMethod("Try", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static))
                .ToArray();
            Assert.All(methods, method =>
            {
                Assert.NotNull(method);
                Assert.True(method.IsStatic);
                Assert.Equal(privateExtension, method.IsPrivate);
                Assert.Equal(2, method.GetParameters().Length);
            });
            ParameterInfo[] nativeParameters = methods[0].GetParameters();
            ParameterInfo[] emittedParameters = methods[1].GetParameters();
            Assert.Equal(2, nativeParameters[0].GetCustomAttributesData().Count(attribute =>
                attribute.AttributeType.FullName is
                    "System.Diagnostics.CodeAnalysis.NotNullWhenAttribute" or "Issue4790.Contracts.StampAttribute"));
            for (int index = 0; index < nativeParameters.Length; index++)
            {
                string[] Attributes(ParameterInfo parameter) => parameter.GetCustomAttributesData()
                    .Where(attribute => attribute.AttributeType.FullName is
                        "System.Diagnostics.CodeAnalysis.NotNullWhenAttribute" or "Issue4790.Contracts.StampAttribute")
                    .Select(attribute => attribute.AttributeType.FullName + ":" +
                        string.Join(",", attribute.ConstructorArguments.Select(argument => argument.Value)) + ":" +
                        string.Join(",", attribute.NamedArguments.Select(argument =>
                            argument.MemberName + "=" + argument.TypedValue.Value)))
                    .OrderBy(value => value, StringComparer.Ordinal).ToArray();
                Assert.Equal(Attributes(nativeParameters[index]), Attributes(emittedParameters[index]));
                Assert.Equal(nativeParameters[index].Attributes, emittedParameters[index].Attributes);
            }

            Assert.Equal(expected, RunConsumer(emitted, consumer));
        }, source, consumerSource);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void SuspendingOwnedExtensions_PreserveDeclaredContextAndLogicalCompanion(bool marked)
    {
        string attribute = marked ? "[Suspending]" : string.Empty;
        string source = $$"""
            using System.Diagnostics.CodeAnalysis;
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
                {{attribute}}
                public static async ValueTask<int> Read([NotNull] this Node node, Context context)
                {
                    node.Calls++;
                    return await node.Gate.Task;
                }
                {{attribute}}
                public static async ValueTask Drain([NotNull] this Node node, Context context)
                {
                    node.Calls++;
                    await node.Gate.Task;
                }
            }
            """;
        const string consumerSource = """
            using Gsharp.Concurrency;
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
            }
            """;
        WithProducts(source: source, consumerSource: consumerSource, assertion: (native, emitted, consumer) =>
        {
            Assert.Equal("1,False,17,1,1,False,1", RunConsumer(native, consumer));
            Assert.Equal("1,False,17,1,1,False,1", RunConsumer(emitted, consumer));
            Assembly nativeImage = consumer.LoadTogether(File.ReadAllBytes(native))[0];
            Assembly emittedImage = consumer.LoadTogether(File.ReadAllBytes(emitted))[0];
            Type nativeOwner = nativeImage.GetType("Issue4790.Suspension.Holder", throwOnError: true);
            Type emittedOwner = emittedImage.GetType("Issue4790.Suspension.Holder", throwOnError: true);
            Type receiver = emittedImage.GetType("Issue4790.Suspension.Node", throwOnError: true);
            foreach (string name in new[] { "Read", "Drain" })
            {
                MethodInfo original = nativeOwner.GetMethod(name);
                MethodInfo hosted = emittedOwner.GetMethod(name);
                Assert.Equal(Contract(original), Contract(hosted));
                Assert.True(hosted.IsPublic && hosted.IsStatic);
                Assert.Equal(2, hosted.GetParameters().Length);
                Assert.Single(hosted.GetCustomAttributesData(),
                    a => a.AttributeType == typeof(Gsharp.Concurrency.SuspendingAttribute));
                Assert.Equal(original.GetParameters()[0].GetCustomAttributesData().Select(a => a.AttributeType.FullName),
                    hosted.GetParameters()[0].GetCustomAttributesData().Select(a => a.AttributeType.FullName));
                MethodInfo companion = receiver.GetMethod(name);
                Assert.Equal(hosted.ReturnType, companion.ReturnType);
                Assert.Single(companion.GetParameters());
                Assert.Equal(typeof(Gsharp.Concurrency.Context), companion.GetParameters()[0].ParameterType);
                Assert.NotNull(companion.GetCustomAttribute<AsyncStateMachineAttribute>());
                Assert.Single(companion.GetCustomAttributesData(),
                    a => a.AttributeType == typeof(Gsharp.Concurrency.SuspendingAttribute));
                object node = Activator.CreateInstance(receiver);
                var gate = (TaskCompletionSource<int>)receiver.GetField("Gate").GetValue(node);
                object pending = companion.Invoke(node, new object[] { Gsharp.Concurrency.Context.None });
                Assert.Equal(1, receiver.GetField("Calls").GetValue(node));
                if (name == "Read")
                {
                    var value = (ValueTask<int>)pending;
                    Assert.False(value.IsCompleted);
                    gate.SetResult(31);
                    Assert.Equal(31, value.AsTask().GetAwaiter().GetResult());
                }
                else
                {
                    var value = (ValueTask)pending;
                    Assert.False(value.IsCompleted);
                    gate.SetResult(31);
                    value.AsTask().GetAwaiter().GetResult();
                }

                Assert.Equal(1, receiver.GetField("Calls").GetValue(node));
            }
        });
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void NonGenericTaskLikeForwarding_ReturnsTheOriginalEnvelope(bool valueTask)
    {
        string envelope = valueTask ? "ValueTask" : "Task";
        string returned = valueTask ? "new ValueTask(node.Envelope)" : "node.Envelope";
        string source = $$"""
            using System.Threading.Tasks;
            namespace Issue4790.NonGeneric;
            public sealed class Node
            {
                public Task Envelope;
                public int Calls;
                public Node(Task envelope) { Envelope = envelope; }
            }
            public static class Holder
            {
                public static {{envelope}} Pass(this Node node)
                {
                    node.Calls++;
                    return {{returned}};
                }
            }
            """;
        string task = valueTask ? "pending.AsTask()" : "pending";
        string consumerSource = $$"""
            using System;
            using System.Threading.Tasks;
            using Issue4790.NonGeneric;
            public static class NativeConsumer
            {
                public static string Run()
                {
                    var gate = new TaskCompletionSource<int>();
                    var node = new Node(gate.Task);
                    var pending = node.Pass();
                    return ReferenceEquals(gate.Task, {{task}}) + "," + node.Calls + "," + pending.IsCompleted;
                }
            }
            """;
        WithProducts(source: source, consumerSource: consumerSource, assertion: (native, emitted, consumer) =>
        {
            Assert.Equal("True,1,False", RunConsumer(native, consumer));
            Assert.Equal("True,1,False", RunConsumer(emitted, consumer));
            Assembly image = consumer.LoadTogether(File.ReadAllBytes(emitted))[0];
            Type receiver = image.GetType("Issue4790.NonGeneric.Node", throwOnError: true);
            var gate = new TaskCompletionSource<int>();
            object node = Activator.CreateInstance(receiver, gate.Task);
            MethodInfo companion = receiver.GetMethod("Pass");
            Assert.Null(companion.GetCustomAttribute<AsyncStateMachineAttribute>());
            object pending = companion.Invoke(node, null);
            Task actual = valueTask ? ((ValueTask)pending).AsTask() : (Task)pending;
            Assert.Same(gate.Task, actual);
            Assert.False(actual.IsCompleted);
            Assert.Equal(1, receiver.GetField("Calls").GetValue(node));
        });
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void SuspendingOwnedExtensionWithoutContext_ReportsLocatedUnsupportedAbi(bool marked)
    {
        string attribute = marked ? "[Suspending]" : string.Empty;
        string source = $$"""
            using System.Threading.Tasks;
            using Gsharp.Concurrency;
            namespace Issue4790.Unrepresentable;
            public sealed class Node { }
            public static class Holder
            {
                {{attribute}}
                public static async ValueTask<int> Read(this Node node)
                {
                    var context = Context.None;
                    await Task.CompletedTask;
                    return 17;
                }
            }
            """;
        MetadataReference runtime = MetadataReference.CreateFromFile(typeof(Gsharp.Concurrency.Context).Assembly.Location);
        using var native = new CSharpFixture(source, new[] { runtime });
        MethodInfo original = native.Load().GetType("Issue4790.Unrepresentable.Holder").GetMethod("Read");
        Assert.Single(original.GetParameters());
        Assert.True(original.IsPublic && original.IsStatic);
        Assert.Equal(typeof(ValueTask<int>), original.ReturnType);
        var tree = CSharpSyntaxTree.ParseText(source, path: "Producer.cs");
        var references = CSharpProjectLoader.RuntimeReferences().Concat(new[] { runtime });
        var compilation = CSharpCompilation.Create("UnsupportedSuspend", new[] { tree }, references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        Assert.DoesNotContain(compilation.GetDiagnostics(), d => d.Severity == DiagnosticSeverity.Error);
        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument(tree.FilePath, tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        string rendered = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        TranslationDiagnostic diagnostic = Assert.Single(context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("native static-holder signature", diagnostic.Message, StringComparison.Ordinal);
        Assert.Equal("Producer.cs", diagnostic.Location.GetLineSpan().Path);
        Assert.Contains("ValueTask<int> Read", source.Substring(
            diagnostic.Location.SourceSpan.Start, diagnostic.Location.SourceSpan.Length), StringComparison.Ordinal);
        Assert.DoesNotContain("func Read(", rendered, StringComparison.Ordinal);
    }

    private static void WithProducts(
        Action<string, string, CSharpFixture> assertion,
        string source = Source,
        string consumerSource = Consumer)
    {
        string runtime = typeof(Gsharp.Concurrency.Context).Assembly.Location;
        MetadataReference runtimeReference = MetadataReference.CreateFromFile(runtime);
        using var native = new CSharpFixture(source, new[] { runtimeReference });
        using var consumer = new CSharpFixture(consumerSource,
            new[] { MetadataReference.CreateFromFile(native.AssemblyPath), runtimeReference });
        string directory = Path.Combine(AppContext.BaseDirectory, "issue4790-fixtures",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            string nativeDirectory = Path.Combine(directory, "native");
            string emittedDirectory = Path.Combine(directory, "gs");
            Directory.CreateDirectory(nativeDirectory);
            Directory.CreateDirectory(emittedDirectory);
            string nativePath = Path.Combine(nativeDirectory, Path.GetFileName(native.AssemblyPath));
            string emittedPath = Path.Combine(emittedDirectory, Path.GetFileName(native.AssemblyPath));
            string consumerPath = Path.Combine(directory, Path.GetFileName(consumer.AssemblyPath));
            File.Copy(native.AssemblyPath, nativePath);
            File.Copy(consumer.AssemblyPath, consumerPath);
            File.WriteAllText(Path.Combine(directory, "Producer.cs.txt"), source);
            File.WriteAllText(Path.Combine(directory, "Consumer.cs.txt"), consumerSource);

            Microsoft.CodeAnalysis.SyntaxTree tree = CSharpSyntaxTree.ParseText(source,
                new CSharpParseOptions(LanguageVersion.Latest), path: "Producer.cs");
            string[] references = Directory.GetFiles(RuntimeEnvironment.GetRuntimeDirectory(), "*.dll")
                .Append(runtime).ToArray();
            Assert.NotEmpty(references);
            CSharpCompilation compilation = CSharpCompilation.Create(
                Path.GetFileNameWithoutExtension(native.AssemblyPath), new[] { tree },
                references.Select(path => MetadataReference.CreateFromFile(path)),
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
            Assert.DoesNotContain(compilation.GetDiagnostics(),
                diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);
            SemanticModel model = compilation.GetSemanticModel(tree);
            var document = new LoadedDocument(tree.FilePath, tree, model);
            var context = new TranslationContext(compilation, model, document.FilePath);
            string translated = GSharpPrinter.Print(
                new CSharpToGSharpTranslator().TranslateDocument(document, context));
            Assert.DoesNotContain(context.Diagnostics,
                diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
            string gs = Path.Combine(directory, "Producer.gs");
            File.WriteAllText(gs, translated);
            string compiler = GscInvoker.Resolve(null, "Release", AppContext.BaseDirectory);
            Assert.NotNull(compiler);
            string[] arguments = new[] {
                compiler, "/target:library", "/out:" + emittedPath,
                "/assemblyname:" + Path.GetFileNameWithoutExtension(nativePath),
            }.Concat(references.Select(reference => "/reference:" + reference))
                .Concat(new[] { gs }).ToArray();
            ProcessRunResult result = ProcessRunner.Run("dotnet", arguments);
            File.WriteAllText(Path.Combine(directory, "gsc.stdout"), result.Output);
            File.WriteAllText(Path.Combine(directory, "products.json"), JsonSerializer.Serialize(new
            {
                NativeProducer = new { Kind = "Explicit Roslyn CSharpFixture", Source = source },
                ConsumerProducer = new { Kind = "Explicit Roslyn CSharpFixture, compiled once", Consumer = consumerSource },
                Compiler = new { Path = compiler, Sha256 = Hash(compiler) },
                Translator = new {
                    Path = typeof(CSharpToGSharpTranslator).Assembly.Location,
                    Sha256 = Hash(typeof(CSharpToGSharpTranslator).Assembly.Location),
                },
                TestAssemblySha256 = Hash(typeof(Issue4790StaticExtensionHolderAbiTests).Assembly.Location),
                Native = new { Path = nativePath, Sha256 = Hash(nativePath) },
                Consumer = new { Path = consumerPath, Sha256 = Hash(consumerPath) },
                Emitted = File.Exists(emittedPath) ? new {
                    Path = emittedPath, Sha256 = Hash(emittedPath),
                    Identity = AssemblyName.GetAssemblyName(emittedPath).FullName,
                } : null,
                GscArgv = arguments,
                FrameworkReferences = references.Select(reference => new {
                    Path = reference, Sha256 = Hash(reference),
                    Identity = AssemblyName.GetAssemblyName(reference).FullName,
                }),
                result.ExitCode,
            }, new JsonSerializerOptions { WriteIndented = true }));
            Assert.True(result.ExitCode == 0, result.Output + Environment.NewLine + translated);
            Assert.True(File.Exists(emittedPath));
            assertion(nativePath, emittedPath, consumer);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string Hash(string path) => Convert.ToHexString(
        SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();
}
