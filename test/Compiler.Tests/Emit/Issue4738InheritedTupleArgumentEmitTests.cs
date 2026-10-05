// <copyright file="Issue4738InheritedTupleArgumentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4738InheritedTupleArgumentEmitTests
{
    private const string ContractSource = """
        #nullable enable
        namespace Issue4738.Contracts;
        public class Reordered<A, B> : System.Collections.Generic.List<B> { }
        public sealed class Marker
        {
            public Marker(int label) => Label = label;
            public int Label { get; }
        }
        public class PairOwner<A, B>
        {
            public (B, int) Keep((B, int) value) => value;
            public object Mix<U>((B, U) value) => value;
        }
        public class ReturnOwner<A, B>
        {
            public (B, U) Mix<U>((B, U) value) => value;
            public (B, V, U, A) Vector<U, V>((B, V, U, A) value) => value;
            public (B, U) Reference<U>((B, U) value) where U : class => value;
            public (B, U) Value<U>((B, U) value) where U : struct => value;
        }
        public class ReorderedReturnOwner<A, B> : ReturnOwner<B, A> { }
        public class NestedReturnOwner<A, B> : ReturnOwner<A, System.Collections.Generic.List<B>> { }
        public static class Native
        {
            public static T Identity<T>(T value) => value;
        }
        """;

    [Theory]
    [InlineData(0, 0, false)]
    [InlineData(0, 1, false)]
    [InlineData(0, 2, false)]
    [InlineData(1, 0, false)]
    [InlineData(1, 1, false)]
    [InlineData(1, 2, false)]
    [InlineData(2, 0, false)]
    [InlineData(2, 1, false)]
    [InlineData(2, 2, false)]
    [InlineData(0, 0, true)]
    [InlineData(0, 1, true)]
    [InlineData(0, 2, true)]
    [InlineData(1, 0, true)]
    [InlineData(1, 1, true)]
    [InlineData(1, 2, true)]
    [InlineData(2, 0, true)]
    [InlineData(2, 1, true)]
    [InlineData(2, 2, true)]
    public void InheritedOwner_LiteralPreservesPhysicalTupleAndOrderedEffects(int owner, int shape, bool valueElement)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, nameof(Issue4738InheritedTupleArgumentEmitTests), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var contractPath = CompileContract(directory);

            var declarations = owner switch
            {
                0 => "class Leaf[T] : List[T] {}",
                1 => "open class Middle[A, B] : List[B] {}\nclass Leaf[T] : Middle[int32, T] {}",
                _ => "class Leaf[T] : Reordered[string, T] {}",
            };
            var tuple = shape switch
            {
                0 => "(entry Item, number int32)",
                1 => "(outer int32, inner (entry Item, number int32))",
                _ => "(int32, int32, int32, int32, int32, int32, int32, Item, int32)",
            };
            var literal = shape switch
            {
                0 => "(counter.NextItem(2), counter.Mark(3))",
                1 => "(counter.Mark(2), (counter.NextItem(3), counter.Mark(4)))",
                _ => "(counter.Mark(2), counter.Mark(3), counter.Mark(4), counter.Mark(5), counter.Mark(6), counter.Mark(7), counter.Mark(8), counter.NextItem(9), counter.Mark(0))",
            };
            var source = $$"""
                package Issue4738.Consumer
                import System.Collections.Generic
                import Issue4738.Contracts
                {{(valueElement ? "struct" : "class")}} Item(Label int32) {}
                {{declarations}}
                class Counter(Values Leaf[{{tuple}}], Entry Item) {
                    var Trace int32 = 0
                    func Mark(digit int32) int32 {
                        Trace = Trace * 10 + digit
                        return digit
                    }
                    func Receiver() Leaf[{{tuple}}] {
                        Mark(1)
                        return Values
                    }
                    func NextItem(digit int32) Item {
                        Mark(digit)
                        return Entry
                    }
                }
                public func Producer(counter Counter) Leaf[{{tuple}}] {
                    counter.Receiver().Add({{literal}})
                    return counter.Values
                }
                public func RoundTrip(value {{tuple}}) {{tuple}} -> Native.Identity(value)
                public func Box(value {{tuple}}) object -> value
                public func NewItem() Item -> Item(37)
                """;
            var outputPath = Compile(directory, source, contractPath);
            IlVerifier.Verify(outputPath, additionalReferences: new[] { contractPath });
            var assembly = EmittedFixture.LoadTogether(contractPath, outputPath)[1];
            var itemType = Assert.Single(assembly.GetTypes(), type => type.Name == "Item");
            var leafDefinition = Assert.Single(assembly.GetTypes(), type => type.Name == "Leaf`1");
            var pair = typeof(ValueTuple<,>).MakeGenericType(itemType, typeof(int));
            var expectedTuple = shape switch
            {
                0 => pair,
                1 => typeof(ValueTuple<,>).MakeGenericType(typeof(int), pair),
                _ => typeof(ValueTuple<,,,,,,,>).MakeGenericType(
                    typeof(int), typeof(int), typeof(int), typeof(int), typeof(int), typeof(int), typeof(int), pair),
            };
            var expectedLeaf = leafDefinition.MakeGenericType(expectedTuple);
            var producer = FindMethod(assembly, "Producer");
            var roundTrip = FindMethod(assembly, "RoundTrip");
            var box = FindMethod(assembly, "Box");
            Assert.Equal(expectedLeaf, producer.ReturnType);
            Assert.Equal(expectedTuple, roundTrip.ReturnType);
            Assert.Equal(expectedTuple, Assert.Single(roundTrip.GetParameters()).ParameterType);
            Assert.Equal(expectedTuple, Assert.Single(box.GetParameters()).ParameterType);
            var values = Assert.IsAssignableFrom<IList>(Activator.CreateInstance(expectedLeaf));
            var item = Assert.IsAssignableFrom<object>(FindMethod(assembly, "NewItem").Invoke(null, null));
            var counterType = Assert.Single(assembly.GetTypes(), type => type.Name == "Counter");
            var counter = Assert.IsAssignableFrom<object>(Activator.CreateInstance(counterType, values, item));
            Assert.Same(values, producer.Invoke(null, new[] { counter }));
            Assert.Equal(shape switch { 0 => 123, 1 => 1234, _ => 1234567890 }, counterType.GetField("Trace").GetValue(counter));
            var result = Assert.Single(values.Cast<object>());
            Assert.Equal(expectedTuple, result.GetType());
            Assert.Equal(result, roundTrip.Invoke(null, new[] { result }));
            Assert.Equal(result, box.Invoke(null, new[] { result }));
            var storedPair = shape switch
            {
                0 => result,
                1 => expectedTuple.GetField("Item2").GetValue(result),
                _ => expectedTuple.GetField("Rest").GetValue(result),
            };
            Assert.Equal(itemType, pair.GetField("Item1").FieldType);
            Assert.Equal(typeof(int), pair.GetField("Item2").FieldType);
            var storedItem = pair.GetField("Item1").GetValue(storedPair);
            if (valueElement)
            {
                Assert.Equal(item, storedItem);
            }
            else
            {
                Assert.Same(item, storedItem);
            }

            Assert.Equal(37, itemType.GetField("Label").GetValue(storedItem));
            Assert.Equal(shape switch { 0 => 3, 1 => 4, _ => 0 }, pair.GetField("Item2").GetValue(storedPair));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void OpenInheritedOwnerAndGenericMethod_PreserveBothSymbolicArgumentVectors()
    {
        var directory = Path.Combine(AppContext.BaseDirectory, nameof(Issue4738InheritedTupleArgumentEmitTests), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var contractPath = CompileContract(directory);
            var outputPath = Compile(directory, """
                        package Issue4738.OpenConsumer
                        import System.Collections.Generic
                        import Issue4738.Contracts
                        class Item(Label int32) {}
                        class Leaf[T] : List[(entry T, number int32)] {}
                        class PairLeaf[T] : PairOwner[string, T] {}
                        public func Producer[T](item T) Leaf[T] {
                            let leaf = Leaf[T]()
                            leaf.Add((item, 7))
                            return leaf
                        }
                        public func Keep(item Item) (Item, int32) -> PairLeaf[Item]().Keep((item, 11))
                        public func Mix[U](item Item, value U) object -> PairLeaf[Item]().Mix[U]((item, value))
                        public func NewItem() Item -> Item(37)
                        """, contractPath);
            IlVerifier.Verify(outputPath, additionalReferences: new[] { contractPath });
            var loaded = EmittedFixture.LoadTogether(contractPath, outputPath);
            var assembly = loaded[1];
            var item = Assert.IsAssignableFrom<object>(FindMethod(assembly, "NewItem").Invoke(null, null));
            var markerType = Assert.Single(loaded[0].GetTypes(), type => type.Name == "Marker");
            var marker = Assert.IsAssignableFrom<object>(Activator.CreateInstance(markerType, 41));
            var producer = FindMethod(assembly, "Producer");
            var genericArgument = Assert.Single(producer.GetGenericArguments());
            Assert.Equal(
                typeof(ValueTuple<,>).MakeGenericType(genericArgument, typeof(int)),
                Assert.Single(producer.ReturnType.BaseType.GetGenericArguments()));
            foreach (var value in new[] { item, marker, (object)43 })
            {
                var values = Assert.IsAssignableFrom<IList>(
                    producer.MakeGenericMethod(value.GetType()).Invoke(null, new[] { value }));
                var pair = Assert.Single(values.Cast<object>());
                var tuple = typeof(ValueTuple<,>).MakeGenericType(value.GetType(), typeof(int));
                Assert.Equal(tuple, pair.GetType());
                Assert.Equal(value.GetType(), tuple.GetField("Item1").FieldType);
                if (value is int)
                {
                    Assert.Equal(value, tuple.GetField("Item1").GetValue(pair));
                }
                else
                {
                    Assert.Same(value, tuple.GetField("Item1").GetValue(pair));
                }

                Assert.Equal(7, tuple.GetField("Item2").GetValue(pair));
            }

            var keep = Assert.IsAssignableFrom<object>(FindMethod(assembly, "Keep").Invoke(null, new[] { item }));
            Assert.Same(item, keep.GetType().GetField("Item1").GetValue(keep));
            Assert.Equal(11, keep.GetType().GetField("Item2").GetValue(keep));
            var mix = FindMethod(assembly, "Mix");
            Assert.Equal(typeof(object), mix.ReturnType);
            foreach (var value in new[] { marker, (object)47 })
            {
                var pair = Assert.IsAssignableFrom<object>(mix.MakeGenericMethod(value.GetType()).Invoke(null, new[] { item, value }));
                Assert.Equal(typeof(ValueTuple<,>).MakeGenericType(item.GetType(), value.GetType()), pair.GetType());
                Assert.Same(item, pair.GetType().GetField("Item1").GetValue(pair));
                Assert.Equal(value, pair.GetType().GetField("Item2").GetValue(pair));
            }
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Theory]
    [InlineData("class Leaf[T] : List[T] {}")]
    [InlineData("class Leaf[T] : Reordered[string, T] {}")]
    public void InheritedOwner_ErasedObjectTupleCannotReachOpenSlot(string declaration)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, nameof(Issue4738InheritedTupleArgumentEmitTests), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var contractPath = CompileContract(directory);
            var sourcePath = Path.Combine(directory, "Rejected.gs");
            var outputPath = Path.Combine(directory, "Rejected.dll");
            File.WriteAllText(sourcePath, $$"""
                        package Issue4738.Rejected
                        import System.Collections.Generic
                        import Issue4738.Contracts
                        {{declaration}}
                        public func Unsafe[T](leaf Leaf[(T, int32)], pair (object, int32)) {
                            leaf.Add(pair)
                        }
                        """);
            var (exitCode, output) = RunCompiler(sourcePath, outputPath, contractPath);
            Assert.NotEqual(0, exitCode);
            Assert.Contains("error GS0155:", output, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal);
            Assert.False(File.Exists(outputPath));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    internal static string CompileContract(string directory)
    {
        var contractPath = Path.Combine(directory, "Issue4738.Contracts.dll");
        var compilation = CSharpCompilation.Create(
            "Issue4738.Contracts",
            new[] { CSharpSyntaxTree.ParseText(ContractSource) },
            ReferenceResolver.HostTrustedPlatformAssemblyPaths().Select(path => MetadataReference.CreateFromFile(path)),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var result = compilation.Emit(contractPath);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return contractPath;
    }

    internal static MethodInfo FindMethod(Assembly assembly, string name) =>
        Assert.Single(assembly.GetTypes().SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.Static)), method => method.Name == name);

    internal static string Compile(string directory, string source, string contractPath)
    {
        var sourcePath = Path.Combine(directory, "Consumer.gs");
        var outputPath = Path.Combine(directory, "Consumer.dll");
        File.WriteAllText(sourcePath, source);
        var (exitCode, output) = RunCompiler(sourcePath, outputPath, contractPath);
        Assert.True(exitCode == 0, output);
        return outputPath;
    }

    internal static (int ExitCode, string Output) RunCompiler(string sourcePath, string outputPath, string contractPath)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        int exitCode;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            exitCode = Program.Main(new[]
            {
                sourcePath,
                "/target:library",
                "/targetframework:net10.0",
                "/r:" + contractPath,
                "/out:" + outputPath,
            });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        return (exitCode, stdout.ToString() + stderr);
    }
}
