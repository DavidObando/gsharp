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

    private static void WithProducts(
        Action<string, string, CSharpFixture> assertion,
        string source = Source,
        string consumerSource = Consumer)
    {
        using var native = new CSharpFixture(source);
        using var consumer = new CSharpFixture(consumerSource,
            new[] { MetadataReference.CreateFromFile(native.AssemblyPath) });
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
            string[] references = Directory.GetFiles(RuntimeEnvironment.GetRuntimeDirectory(), "*.dll");
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
