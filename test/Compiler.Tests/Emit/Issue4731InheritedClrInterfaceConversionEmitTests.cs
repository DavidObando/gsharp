// <copyright file="Issue4731InheritedClrInterfaceConversionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4731InheritedClrInterfaceConversionEmitTests
{
    [Fact]
    public void SymbolicValueWrapper_ExactDirectAndClosureConsumers_BoxActualValueShape()
    {
        using var fixture = new Fixture();
        var result = fixture.Compile("""
            package Issue4731.SymbolicValueBoxing
            import System
            import System.Collections.Generic
            import System.Collections.Immutable
            import System.Linq
            enum Kind { First, Second }

            public func Direct(left ImmutableArray[Kind], right ImmutableArray[Kind]) bool -> left.SequenceEqual(right)
            public func Closure(left ImmutableArray[Kind]) ((ImmutableArray[Kind]) -> bool?) {
                return (right ImmutableArray[Kind]) -> {
                    return if left.Length == right.Length { left.SequenceEqual(right) } else { nil }
                }
            }

            public func Probe() int32 {
                let values = ImmutableArray.Create(Kind.First, Kind.Second)
                let other = ImmutableArray.Create(Kind.Second, Kind.First)
                let check = Closure(values)
                if !Direct(values, values) || Direct(values, other) { return -1 }
                if check(values) != true || check(other) != false { return -2 }
                if check(ImmutableArray[Kind].Empty) != nil { return -3 }
                return 37
            }
            """);
        Assert.True(result.ExitCode == 0, result.Output);
        IlVerifier.Verify(result.AssemblyPath, additionalReferences: new[] { fixture.AssemblyPath });
        var assembly = EmittedFixture.Load(result.AssemblyPath);
        Assert.Equal(37, FindMethod(assembly, "Probe").Invoke(null, null));
        var kind = Assert.Single(assembly.GetTypes(), type => type.Name == "Kind");
        var wrapper = typeof(ImmutableArray<>).MakeGenericType(kind);
        var enumerable = typeof(IEnumerable<>).MakeGenericType(kind);
        var direct = FindMethod(assembly, "Direct");
        Assert.Equal(new[] { wrapper, wrapper }, direct.GetParameters().Select(parameter => parameter.ParameterType));
        var closure = Assert.Single(assembly.GetTypes(), type => type.Name.StartsWith("<closure_", StringComparison.Ordinal));
        var invoke = Assert.Single(closure.GetMethods(), method => method.Name == "Invoke");
        Assert.Equal(wrapper, Assert.Single(invoke.GetParameters()).ParameterType);
        foreach (var method in new[] { direct, invoke })
        {
            var body = Assert.IsAssignableFrom<MethodBody>(method.GetMethodBody());
            var bytes = Assert.IsType<byte[]>(body.GetILAsByteArray());
            var instructions = IlInstructionReader.Read(bytes).ToArray();
            var boxes = instructions.Where(instruction => instruction.OpCode == OpCodes.Box).ToArray();
            Assert.Equal(2, boxes.Length);
            Assert.All(boxes, instruction => Assert.Equal(wrapper, method.Module.ResolveType(BitConverter.ToInt32(bytes, instruction.Offset + instruction.OpCode.Size))));
            var sequenceEqual = Assert.Single(
                instructions.Where(instruction => instruction.OpCode == OpCodes.Call)
                    .Select(instruction => method.Module.ResolveMethod(instruction.MetadataToken.GetValueOrDefault()))
                    .OfType<MethodInfo>(),
                callee => callee.DeclaringType == typeof(Enumerable) && callee.Name == nameof(Enumerable.SequenceEqual));
            Assert.Equal(kind, Assert.Single(sequenceEqual.GetGenericArguments()));
            Assert.Equal(new[] { enumerable, enumerable }, sequenceEqual.GetParameters().Select(parameter => parameter.ParameterType));
        }
    }

    [Theory]
    [InlineData("ImmutableArray[int32]", "IEnumerable[object]")]
    [InlineData("ImmutableArray[List[Item]]", "IEnumerable[List[object]]")]
    public void ImportedValueWrapper_UnsafeVarianceIsRejectedWithoutEmission(string sourceType, string targetType)
    {
        using var fixture = new Fixture();
        var result = fixture.Compile($$"""
            package Issue4731.ImportedValueProjectionNegative
            import System.Collections.Generic
            import System.Collections.Immutable
            class Item {}
            func Unsafe(value {{sourceType}}) {{targetType}} -> value
            """);
        Assert.NotEqual(0, result.ExitCode);
        Assert.Contains("error GS0155:", result.Output, StringComparison.Ordinal);
        Assert.False(File.Exists(result.AssemblyPath));
    }

    [Fact]
    public void ImportedValueWrapper_ClosedInterfaceProjection_BoxesAndEnumeratesActualSymbols()
    {
        using var fixture = new Fixture();
        string roslynReference = typeof(IMethodSymbol).Assembly.Location;
        var result = fixture.Compile("""
            package Issue4731.ImportedValueProjection
            import System.Collections.Generic
            import System.Collections.Immutable
            import Microsoft.CodeAnalysis
            public func Direct(value ImmutableArray[IMethodSymbol]) IEnumerable[ISymbol] -> value
            public func Constructors(value INamedTypeSymbol) IEnumerable[ISymbol] -> value.InstanceConstructors
            public func Implementations(value IMethodSymbol) IEnumerable[ISymbol] -> value.ExplicitInterfaceImplementations
            """, roslynReference);
        Assert.True(result.ExitCode == 0, result.Output);
        IlVerifier.Verify(result.AssemblyPath, additionalReferences: new[] { fixture.AssemblyPath, roslynReference });

        var compilation = CSharpCompilation.Create(
            "Issue4731.SymbolProducer",
            new[]
            {
                CSharpSyntaxTree.ParseText("""
                    interface IContract { void Read(); }
                    sealed class Sample : IContract
                    {
                        public Sample() { }
                        void IContract.Read() { }
                    }
                    """),
            },
            ReferenceResolver.HostTrustedPlatformAssemblyPaths().Select(path => MetadataReference.CreateFromFile(path)),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        Assert.DoesNotContain(compilation.GetDiagnostics(), diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);
        var owner = compilation.GetTypeByMetadataName("Sample");
        Assert.NotNull(owner);
        var implementation = Assert.Single(
            owner.GetMembers().OfType<IMethodSymbol>(),
            method => !method.ExplicitInterfaceImplementations.IsEmpty);
        var assembly = EmittedFixture.Load(result.AssemblyPath);
        var direct = FindMethod(assembly, "Direct");
        Assert.Equal(typeof(ImmutableArray<IMethodSymbol>), Assert.Single(direct.GetParameters()).ParameterType);
        Assert.Equal(typeof(System.Collections.Generic.IEnumerable<ISymbol>), direct.ReturnType);
        foreach (string name in new[] { "Direct", "Constructors", "Implementations" })
        {
            var method = FindMethod(assembly, name);
            object argument = name switch
            {
                "Direct" => owner.InstanceConstructors,
                "Constructors" => owner,
                _ => implementation,
            };
            var values = Assert.IsAssignableFrom<System.Collections.Generic.IEnumerable<ISymbol>>(
                method.Invoke(null, new[] { argument }));
            var symbol = Assert.Single(values);
            Assert.Equal(name == "Implementations" ? "Read" : ".ctor", symbol.Name);
            Assert.Same(
                name == "Implementations"
                    ? implementation.ExplicitInterfaceImplementations[0]
                    : owner.InstanceConstructors[0],
                symbol);
        }
    }

    private const string ContractSource = """
        #nullable enable
        namespace Issue4731.Contracts;

        public interface IRenderable { int Read(); }
        public abstract class Renderable : IRenderable
        {
            protected abstract int Measure();
            public int Read() => Measure();
        }

        public interface ISource<out T> { int ReadCode(); }
        public class Reordered<TFirst, TSecond> : ISource<TSecond>
        {
            public int ReadCode() => 31;
        }

        public interface ISink<in T> { int Take(T value); }
        public class Sink<T> : ISink<T>
        {
            public int Take(T value) => 29;
        }

        public interface IInvariant<T> { int ReadCode(); }
        public class Invariant<T> : IInvariant<T>
        {
            public int ReadCode() => 37;
        }

        public class SequenceOwner<T> : System.Collections.Generic.List<T> { }
        public static class Producer
        {
            public static (T entry, int number) Pair<T>(T value, int number) => (value, number);
        }
        """;

    [Fact]
    public void SealedRenderable_ImplicitCheckedAndTransitiveUpcasts_PreserveIdentityAndDispatch()
    {
        using var fixture = new Fixture();
        var result = fixture.Compile("""
            package Issue4731.Consumer
            import System
            import Issue4731.Contracts

            public class Dock : Renderable {
                private let height int32 = 17
                protected override func Measure() int32 -> height
            }
            open class Mid : Renderable {
                protected override func Measure() int32 -> 23
            }
            class Deep : Mid {}
            class Listed : Renderable, IRenderable {
                protected override func Measure() int32 -> 19
            }

            public func NullableCast(value Dock?) IRenderable -> cast[IRenderable](value)

            public func Probe() int32 {
                let dock = Dock()
                var implicitValue IRenderable = dock
                let checkedValue = cast[IRenderable](dock)
                let deep = Deep()
                var inheritedValue IRenderable = deep
                let checkedInherited = cast[IRenderable](deep)
                var listed IRenderable = Listed()
                var importedBase Renderable = dock
                if !Object.ReferenceEquals(dock, implicitValue)
                    || !Object.ReferenceEquals(dock, checkedValue)
                    || !Object.ReferenceEquals(deep, inheritedValue)
                    || !Object.ReferenceEquals(deep, checkedInherited)
                    || !Object.ReferenceEquals(dock, importedBase) {
                    return -1
                }
                return implicitValue.Read() + checkedValue.Read()
                    + inheritedValue.Read() + listed.Read()
            }
            """);
        Assert.True(result.ExitCode == 0, result.Output);
        IlVerifier.Verify(result.AssemblyPath, additionalReferences: new[] { fixture.AssemblyPath });

        var loaded = EmittedFixture.LoadTogether(fixture.AssemblyPath, result.AssemblyPath);
        var assembly = loaded[1];
        var dock = Assert.Single(assembly.GetTypes(), type => type.Name == "Dock");
        Assert.True(dock.IsSealed);
        Assert.Contains(dock.GetInterfaces(), type => type.FullName == "Issue4731.Contracts.IRenderable");
        Assert.Equal(76, FindMethod(assembly, "Probe").Invoke(null, null));
        Assert.Null(FindMethod(assembly, "NullableCast").Invoke(null, new object[] { null }));
    }

    [Fact]
    public void GenericOwnerSubstitutionAndVariance_PreserveIdentityAndInheritedDispatch()
    {
        using var fixture = new Fixture();
        var result = fixture.Compile("""
            package Issue4731.Generic
            import System
            import Issue4731.Contracts

            class Item {}
            open class Mid[A, B] : Reordered[B, A] {}
            class Leaf[T] : Mid[T, int32] {}
            class SinkLeaf : Sink[object] {}
            class InvariantLeaf : Invariant[Item] {}

            func Convert[T](value Leaf[T]) ISource[T] -> value
            func Checked[T](value Leaf[T]) ISource[T] -> cast[ISource[T]](value)

            public func Probe() int32 {
                let leaf = Leaf[string]()
                let exact = Convert(leaf)
                var covariant ISource[object] = leaf
                let checkedCovariant = cast[ISource[object]](leaf)
                let local = Leaf[Item]()
                let localView = Checked(local)
                var nullableValue ISource[int32?] = Leaf[int32?]()
                let sink = SinkLeaf()
                var contravariant ISink[string] = sink
                let invariant = InvariantLeaf()
                var invariantView IInvariant[Item] = invariant
                if !Object.ReferenceEquals(leaf, exact)
                    || !Object.ReferenceEquals(leaf, covariant)
                    || !Object.ReferenceEquals(leaf, checkedCovariant)
                    || !Object.ReferenceEquals(local, localView)
                    || !Object.ReferenceEquals(sink, contravariant)
                    || !Object.ReferenceEquals(invariant, invariantView) {
                    return -1
                }
                return exact.ReadCode() + covariant.ReadCode()
                    + checkedCovariant.ReadCode() + localView.ReadCode()
                    + nullableValue.ReadCode() + contravariant.Take("value")
                    + invariantView.ReadCode()
            }
            """);
        Assert.True(result.ExitCode == 0, result.Output);
        IlVerifier.Verify(result.AssemblyPath, additionalReferences: new[] { fixture.AssemblyPath });

        var loaded = EmittedFixture.LoadTogether(fixture.AssemblyPath, result.AssemblyPath);
        Assert.Equal(221, FindMethod(loaded[1], "Probe").Invoke(null, null));
    }

    [Fact]
    public void SequenceAlias_ExactAndReferenceVariance_PreserveIdentityAndDispatch()
    {
        using var fixture = new Fixture();
        var result = fixture.Compile("""
            package Issue4731.Sequences
            import System
            import System.Collections.Generic
            import Issue4731.Contracts

            class Item(Label string) {}
            class Leaf[T] : SequenceOwner[T] {}
            func Exact[T](value Leaf[T]) sequence[T] -> value
            func Checked[T](value Leaf[T]) sequence[T] -> cast[sequence[T]](value)
            func Widen[T class](value Leaf[T]) sequence[object] -> value
            func FromAlias[T](value sequence[T]) IEnumerable[T] -> value
            func FromInterface[T](value IEnumerable[T]) sequence[T] -> value
            func AliasWiden[T class](value sequence[T]) IEnumerable[object] -> value
            func NestedWiden(value sequence[IEnumerable[Item]]) sequence[IEnumerable[object]] -> value

            public func TupleValues() sequence[(entry Item, number int32)] {
                let leaf = Leaf[(entry Item, number int32)]()
                leaf.Add(Producer.Pair(Item("tuple"), 7))
                let view = FromInterface(FromAlias(Exact(leaf)))
                if !Object.ReferenceEquals(leaf, view) { throw InvalidOperationException() }
                return view
            }

            public func ArrayValues() sequence[[3]int32] {
                let leaf = Leaf[[3]int32]()
                leaf.Add([3]int32{3, 5, 7})
                let view = FromInterface(FromAlias(Exact(leaf)))
                if !Object.ReferenceEquals(leaf, view) { throw InvalidOperationException() }
                return view
            }

            public func TupleProbe() int32 {
                var count = 0
                for value in TupleValues() {
                    if value.entry.Label != "tuple" || value.number != 7 { return -11 }
                    count++
                }
                return count
            }

            public func Probe() int32 {
                let leaf = Leaf[string]()
                leaf.Add("value")
                let exact = Exact(leaf)
                let checkedView = Checked(leaf)
                let widened = Widen(leaf)
                if !Object.ReferenceEquals(leaf, exact)
                    || !Object.ReferenceEquals(leaf, checkedView)
                    || !Object.ReferenceEquals(leaf, widened)
                    || !Object.ReferenceEquals(leaf, FromAlias(exact))
                    || !Object.ReferenceEquals(leaf, FromInterface(FromAlias(exact)))
                    || !Object.ReferenceEquals(leaf, AliasWiden(exact)) {
                    return -1
                }
                let own = Leaf[Item]()
                own.Add(Item("source"))
                let ownView = FromInterface(FromAlias(Exact(own)))
                if !Object.ReferenceEquals(own, ownView) { return -3 }
                for item in ownView {
                    if item.Label != "source" { return -4 }
                }
                let nested = Leaf[List[Item]]()
                nested.Add(List[Item]{Item("nested")})
                let nestedView = FromInterface(FromAlias(Exact(nested)))
                if !Object.ReferenceEquals(nested, nestedView) { return -5 }
                var nestedCount = 0
                for list in nestedView {
                    for item in list {
                        if item.Label != "nested" { return -6 }
                        nestedCount++
                    }
                }
                if nestedCount != 1 { return -7 }
                let covariant = Leaf[IEnumerable[Item]]()
                covariant.Add(List[Item]{Item("covariant")})
                let nestedWidened = NestedWiden(Exact(covariant))
                if !Object.ReferenceEquals(covariant, nestedWidened) { return -8 }
                var covariantCount = 0
                for list in nestedWidened {
                    for item in list {
                        if cast[Item](item).Label != "covariant" { return -9 }
                        covariantCount++
                    }
                }
                if covariantCount != 1 { return -10 }
                var count int32 = 0
                for item in widened {
                    if item != "value" { return -2 }
                    count++
                }
                return count
            }
            """);
        Assert.True(result.ExitCode == 0, result.Output);
        IlVerifier.Verify(result.AssemblyPath, additionalReferences: new[] { fixture.AssemblyPath });
        var loaded = EmittedFixture.LoadTogether(fixture.AssemblyPath, result.AssemblyPath);
        Assert.Equal(1, FindMethod(loaded[1], "Probe").Invoke(null, null));
        Assert.Equal(1, FindMethod(loaded[1], "TupleProbe").Invoke(null, null));
        var item = Assert.Single(loaded[1].GetTypes(), type => type.Name == "Item");
        var tuple = typeof(ValueTuple<,>).MakeGenericType(item, typeof(int));
        Assert.Equal(typeof(IEnumerable<>).MakeGenericType(tuple), FindMethod(loaded[1], "TupleValues").ReturnType);
        Assert.Equal(typeof(IEnumerable<int[]>), FindMethod(loaded[1], "ArrayValues").ReturnType);
        var arrays = Assert.IsAssignableFrom<IEnumerable<int[]>>(FindMethod(loaded[1], "ArrayValues").Invoke(null, null));
        Assert.Equal(new[] { 3, 5, 7 }, Assert.Single(arrays));
    }

    [Fact]
    public void ImportedSequenceReturns_IteratorHoistedFields_RetainPhysicalElementAndRuntimeValues()
    {
        using var fixture = new Fixture();
        var result = fixture.Compile("""
            package Issue4731.PhysicalSequences
            import System.Linq

            class Matrix {
                private data class Item(Name string) { }

                shared {
                    private func Cases() sequence[Item] {
                        yield Item("one")
                    }

                    func ConcatRows() sequence[[]object] {
                        for item in Cases().Concat(Cases()) {
                            yield []object{item.Name}
                        }
                    }

                    func WhereRows() sequence[[]object] {
                        for item in Cases().Where((item Item) -> item.Name == "one") {
                            yield []object{item.Name}
                        }
                    }
                }
            }
            """);
        Assert.True(result.ExitCode == 0, result.Output);

        var loaded = EmittedFixture.LoadTogether(fixture.AssemblyPath, result.AssemblyPath);
        var assembly = loaded[1];
        var item = Assert.Single(assembly.GetTypes(), type => type.Name == "Item");
        var enumerable = typeof(IEnumerable<>).MakeGenericType(item);
        var enumerator = typeof(IEnumerator<>).MakeGenericType(item);
        foreach (var (name, producer, count) in new[]
        {
            ("ConcatRows", nameof(Enumerable.Concat), 2),
            ("WhereRows", nameof(Enumerable.Where), 1),
        })
        {
            var rows = Assert.IsAssignableFrom<IEnumerable<object[]>>(FindMethod(assembly, name).Invoke(null, null));
            Assert.Equal(Enumerable.Repeat("one", count), rows.Select(row => Assert.IsType<string>(Assert.Single(row))));

            var state = Assert.Single(assembly.GetTypes(), type => type.Name.StartsWith("<" + name + ">", StringComparison.Ordinal));
            Assert.Contains(
                state.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance),
                field => field.FieldType == enumerator);
            var moveNext = Assert.Single(
                state.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance),
                method => method.Name == "MoveNext");
            var body = Assert.IsAssignableFrom<MethodBody>(moveNext.GetMethodBody());
            var bytes = Assert.IsType<byte[]>(body.GetILAsByteArray());
            var call = Assert.Single(
                IlInstructionReader.Read(bytes)
                    .Where(instruction => instruction.OpCode == OpCodes.Call || instruction.OpCode == OpCodes.Callvirt)
                    .Where(instruction => instruction.MetadataToken.HasValue)
                    .Select(instruction => moveNext.Module.ResolveMethod(instruction.MetadataToken.GetValueOrDefault()))
                    .OfType<MethodInfo>(),
                method => method.DeclaringType == typeof(Enumerable) && method.Name == producer);
            Assert.Equal(enumerable, call.ReturnType);
            Assert.Equal(item, Assert.Single(call.GetGenericArguments()));
        }

        IlVerifier.Verify(result.AssemblyPath, additionalReferences: new[] { fixture.AssemblyPath });
    }

    [Theory]
    [InlineData("sequence[List[Item]]", "sequence[List[object]]", "GS0155")]
    [InlineData("sequence[List[Item]]", "IEnumerable[List[object]]", "GS0155")]
    [InlineData("async sequence[List[Item]]", "async sequence[List[object]]", "GS0155")]
    [InlineData("async sequence[List[Item]]", "IAsyncEnumerable[List[object]]", "GS0155")]
    [InlineData("sequence[sequence[List[Item]]]", "sequence[sequence[List[object]]]", "GS0155")]
    [InlineData("sequence[List[Item]?]", "sequence[List[object]?]", "GS0155")]
    [InlineData("sequence[(Item, int32)]", "sequence[(object, int32)]", "GS0156")]
    [InlineData("sequence[List[(Item, int32)]]", "sequence[List[(object, int32)]]", "GS0155")]
    [InlineData("async sequence[(Item, int32)]", "async sequence[(object, int32)]", "GS0156")]
    [InlineData("sequence[[3]int32]", "sequence[[4]int32]", "GS0155")]
    [InlineData("async sequence[[3]int32]", "IAsyncEnumerable[[4]int32]", "GS0155")]
    [InlineData("sequence[[]int32]", "sequence[[3]int32]", "GS0155")]
    [InlineData("sequence[List[[]Item]]", "sequence[List[[]object]]", "GS0155")]
    public void NestedInvariantSequenceElements_AreRejectedWithoutEmission(
        string sourceType,
        string targetType,
        string diagnostic)
    {
        using var fixture = new Fixture();
        var result = fixture.Compile($$"""
            package Issue4731.NestedInvariant
            import System.Collections.Generic
            class Item {}
            func Unsafe(value {{sourceType}}) {{targetType}} -> value
            """);
        Assert.Equal(1, result.ExitCode);
        Assert.Contains("error " + diagnostic + ":", result.Output, StringComparison.Ordinal);
        Assert.False(File.Exists(result.AssemblyPath));
    }

    [Theory]
    [InlineData("IEnumerable[object]")]
    [InlineData("sequence[object]")]
    public void UnconstrainedSequenceSource_CannotWidenToObjectElements(string target)
    {
        using var fixture = new Fixture();
        var result = fixture.Compile($"""
            package Issue4731.ReifiedNegative
            import System.Collections.Generic
            func Unsafe[T](value sequence[T]) {target} -> value
            """);
        Assert.Equal(1, result.ExitCode);
        Assert.True(result.Output.Contains("GS0156", StringComparison.Ordinal), result.Output);
        Assert.False(File.Exists(result.AssemblyPath));
    }

    [Theory]
    [InlineData("IEnumerable[object]")]
    [InlineData("sequence[object]")]
    public void UnconstrainedSequenceVariance_IsRejectedWithoutEmission(string targetType)
    {
        using var fixture = new Fixture();
        var result = fixture.Compile($$"""
            package Issue4731.RejectedSequence
            import System.Collections.Generic
            class Leaf[T] : List[T] {}
            func Widen[T](value Leaf[T]) {{targetType}} -> value
            """);
        Assert.NotEqual(0, result.ExitCode);
        Assert.Contains("error GS0155:", result.Output, StringComparison.Ordinal);
        Assert.False(File.Exists(result.AssemblyPath));
    }

    [Theory]
    [InlineData("class Leaf {}", "Leaf", "IRenderable", "cast[IRenderable](value)")]
    [InlineData("class Leaf : Reordered[int32, int32] {}", "Leaf", "ISource[object]", "value")]
    [InlineData("class Item {}\nclass Other {}\nclass Leaf : Invariant[Item] {}", "Leaf", "IInvariant[Other]", "value")]
    public void UnrelatedSealedAndInvalidGenericConversions_AreRejected(
        string declarations,
        string sourceType,
        string targetType,
        string expression)
    {
        using var fixture = new Fixture();
        var result = fixture.Compile($"""
            package Issue4731.Rejected
            import Issue4731.Contracts
            {declarations}
            func Convert(value {sourceType}) {targetType} -> {expression}
            """);
        Assert.NotEqual(0, result.ExitCode);
        Assert.Contains("error GS0155:", result.Output, StringComparison.Ordinal);
        Assert.False(File.Exists(result.AssemblyPath));
    }

    private static MethodInfo FindMethod(Assembly assembly, string name) =>
        Assert.Single(
            assembly.GetTypes().SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.Static)),
            method => method.Name == name);

    private sealed class Fixture : IDisposable
    {
        private readonly string directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue4731InheritedClrInterfaceConversionEmitTests),
            Guid.NewGuid().ToString("N"));

        public Fixture()
        {
            Directory.CreateDirectory(directory);
            AssemblyPath = Path.Combine(directory, "Issue4731.Contracts.dll");
            var compilation = CSharpCompilation.Create(
                "Issue4731.Contracts",
                new[] { CSharpSyntaxTree.ParseText(ContractSource) },
                ReferenceResolver.HostTrustedPlatformAssemblyPaths().Select(path => MetadataReference.CreateFromFile(path)),
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
            using var stream = File.Create(AssemblyPath);
            var result = compilation.Emit(stream);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }

        public string AssemblyPath { get; }

        public (int ExitCode, string Output, string AssemblyPath) Compile(string source, params string[] additionalReferences)
        {
            var sourcePath = Path.Combine(directory, "Consumer.gs");
            var outputPath = Path.Combine(directory, "Consumer.dll");
            File.WriteAllText(sourcePath, source);
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
                    "/target:library",
                    "/targetframework:net10.0",
                    "/r:" + AssemblyPath,
                    "/out:" + outputPath,
                    sourcePath,
                }.Concat(additionalReferences.Select(path => "/r:" + path)).ToArray());
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            return (exitCode, stdout.ToString() + stderr.ToString(), outputPath);
        }

        public void Dispose() => Directory.Delete(directory, recursive: true);
    }
}
