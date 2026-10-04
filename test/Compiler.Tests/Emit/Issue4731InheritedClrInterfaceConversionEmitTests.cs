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
using System.Threading;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4731InheritedClrInterfaceConversionEmitTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ConstrainedExpandedParams_PreserveSourceAndInferredResult(bool genericOwner)
    {
        using var fixture = new Fixture();
        var constraint = genericOwner ? "IGenericParamsReceiver[int32]" : "IParamsReceiver";
        var receiver = genericOwner ? "GenericParamsReceiver[int32]" : "ParamsReceiver";
        var result = fixture.Compile($$"""
            package Issue4731.ConstrainedParams
            import Issue4731.Contracts
            open class Base {}
            class Derived : Base {}
            class Counter {
                var Calls int32 = 0
                func Next() Derived {
                    Calls = Calls + 1
                    return Derived()
                }
                func Factory() Base {
                    Calls = Calls + 10
                    return Base()
                }
                func Factory(value int32) Derived {
                    Calls = Calls + 100
                    return Derived()
                }
            }
            public func Dispatch[TReceiver {{constraint}}](receiver TReceiver, counter Counter) Base ->
                receiver.Choose(counter.Next(), counter.Factory)
            public func Probe() int32 {
                let counter = Counter()
                let chosen = Dispatch({{receiver}}(), counter)
                return counter.Calls
            }
            """);
        Assert.True(result.ExitCode == 0, result.Output);
        IlVerifier.Verify(result.AssemblyPath, additionalReferences: new[] { fixture.AssemblyPath });
        var assembly = EmittedFixture.Load(result.AssemblyPath);
        Assert.Equal(11, FindMethod(assembly, "Probe").Invoke(null, null));
        var dispatch = FindMethod(assembly, "Dispatch");
        var baseType = Assert.Single(assembly.GetTypes(), type => type.Name == "Base");
        Assert.Equal(baseType, dispatch.ReturnType);
        var body = Assert.IsAssignableFrom<MethodBody>(dispatch.GetMethodBody());
        var chosenCall = Assert.Single(
            IlInstructionReader.Read(Assert.IsType<byte[]>(body.GetILAsByteArray()))
                .Where(instruction => instruction.OpCode == OpCodes.Callvirt)
                .Select(instruction => dispatch.Module.ResolveMethod(
                    instruction.MetadataToken.GetValueOrDefault(),
                    null,
                    dispatch.GetGenericArguments()))
                .OfType<MethodInfo>(),
            method => method.Name == "Choose");
        Assert.Equal(baseType, Assert.Single(chosenCall.GetGenericArguments()));
        Assert.Equal(baseType, chosenCall.ReturnType);
        Assert.Equal(baseType, chosenCall.GetParameters()[0].ParameterType);
        Assert.Equal(typeof(Func<>).MakeGenericType(baseType).MakeArrayType(), chosenCall.GetParameters()[1].ParameterType);
        if (genericOwner)
        {
            var declaringType = Assert.IsAssignableFrom<Type>(chosenCall.DeclaringType);
            Assert.Equal(typeof(int), Assert.Single(declaringType.GetGenericArguments()));
        }
    }

    [Theory]
    [InlineData("object", "GS0156")]
    [InlineData("Other", "GS0155")]
    public void ImportedExpandedParams_UnrelatedActualSourceIsRejected(string sourceType, string diagnostic)
    {
        using var fixture = new Fixture();
        var result = fixture.Compile($$"""
            package Issue4731.ConstrainedParamsNegative
            import Issue4731.Contracts
            class Base {}
            class Other {}
            func Factory() Base -> Base()
            public func Bad(receiver IParamsReceiver, value {{sourceType}}) object ->
                receiver.Choose[Base](value, Factory)
            """);
        Assert.NotEqual(0, result.ExitCode);
        Assert.True(result.Output.Contains("error " + diagnostic + ":", StringComparison.Ordinal), result.Output);
        Assert.False(File.Exists(result.AssemblyPath));
    }

    [Fact]
    public void NullableMapAtImportedGenericSlot_PreservesRuntimeAndOriginalNilPolicy()
    {
        using var fixture = new Fixture();
        var result = fixture.Compile("""
            package Issue4731.NullableMap
            import Issue4731.Contracts
            public func OpenMap[K, V](value map[K, V]?) int32 -> MapReader.Count[K, V](value)
            public func ClosedMap(value map[string, int32]?) int32 -> MapReader.Count[string, int32](value)
            public func Probe() int32 {
                let value = map[string, int32]{"first": 1, "second": 2}
                return OpenMap[string, int32](value) * 10 + ClosedMap(value)
            }
            """);
        Assert.True(result.ExitCode == 0, result.Output);
        IlVerifier.Verify(result.AssemblyPath, additionalReferences: new[] { fixture.AssemblyPath });
        var assembly = EmittedFixture.Load(result.AssemblyPath);
        Assert.Equal(22, FindMethod(assembly, "Probe").Invoke(null, null));
        var open = FindMethod(assembly, "OpenMap");
        var closed = FindMethod(assembly, "ClosedMap");
        Assert.Equal(-1, open.MakeGenericMethod(typeof(string), typeof(int)).Invoke(null, new object[] { null }));
        Assert.Equal(-1, closed.Invoke(null, new object[] { null }));
        var body = Assert.IsAssignableFrom<MethodBody>(open.GetMethodBody());
        var count = Assert.Single(
            IlInstructionReader.Read(Assert.IsType<byte[]>(body.GetILAsByteArray()))
                .Where(instruction => instruction.OpCode == OpCodes.Call)
                .Select(instruction => open.Module.ResolveMethod(
                    instruction.MetadataToken.GetValueOrDefault(),
                    null,
                    open.GetGenericArguments()))
                .OfType<MethodInfo>(),
            method => method.Name == "Count");
        Assert.Equal(open.GetGenericArguments(), count.GetGenericArguments());
        Assert.Equal(
            typeof(IDictionary<,>).MakeGenericType(open.GetGenericArguments()),
            Assert.Single(count.GetParameters()).ParameterType);
    }

    [Theory]
    [InlineData("[]Other", "Item", "GS0155")]
    [InlineData("List[Other]", "Item", "GS0155")]
    [InlineData("sequence[List[Other]]", "List[Item]", "GS0155")]
    [InlineData("sequence[(Other, int32)]", "(Item, int32)", "GS0156")]
    [InlineData("sequence[ImmutableArray[Item]]", "IEnumerable[Item]", "GS0159")]
    public void ImportedGenericMethodSlot_UnrelatedSourceShapes_AreRejected(
        string sourceType,
        string elementType,
        string diagnostic)
    {
        using var fixture = new Fixture();
        var result = fixture.Compile($$"""
            package Issue4731.GenericSlotNegative
            import System.Collections.Generic
            import System.Collections.Immutable
            import System.Linq
            class Item {}
            class Other {}
            func Unsafe(value {{sourceType}}) int32 ->
                Enumerable.Count[{{elementType}}](value)
            """);
        Assert.NotEqual(0, result.ExitCode);
        Assert.True(
            result.Output.Contains("error " + diagnostic + ":", StringComparison.Ordinal),
            result.Output);
        Assert.False(File.Exists(result.AssemblyPath));
    }

    [Fact]
    public void ImportedGenericMethodSlots_NullableReferencePolicies_PreserveActualRuntimeSignatures()
    {
        using var fixture = new Fixture();
        var result = fixture.Compile("""
            package Issue4731.NullableClrArgument
            import System.Collections.Generic
            import System.Linq
            import Issue4731.Contracts
            enum Kind { First, Second }
            class Child {}
            class Entity {
                prop Children ICollection[Child]? { get; init; }
            }
            public func Minimum(values IEnumerable[Kind]?) Kind -> values.Min()
            public func Navigation(source IQueryRoot[Entity]) IQueryRoot[Entity] ->
                source.IncludeChild((entity Entity) -> entity.Children)
                    .ThenChild((child Child) -> child)
            public func Probe() int32 {
                let values = []Kind{Kind.Second, Kind.First}
                let minimum = Minimum(values)
                let navigation = Navigation(QueryRoot[Entity](9))
                return if minimum == Kind.First { navigation.Count } else { -1 }
            }
            """);
        Assert.True(result.ExitCode == 0, result.Output);
        IlVerifier.Verify(result.AssemblyPath, additionalReferences: new[] { fixture.AssemblyPath });
        var assembly = EmittedFixture.Load(result.AssemblyPath);
        Assert.Equal(11, FindMethod(assembly, "Probe").Invoke(null, null));
        var kind = Assert.Single(assembly.GetTypes(), type => type.Name == "Kind");
        var child = Assert.Single(assembly.GetTypes(), type => type.Name == "Child");
        var entity = Assert.Single(assembly.GetTypes(), type => type.Name == "Entity");
        var minimum = FindMethod(assembly, "Minimum");
        Assert.Equal(typeof(IEnumerable<>).MakeGenericType(kind), Assert.Single(minimum.GetParameters()).ParameterType);
        var nil = Assert.Throws<TargetInvocationException>(
            () => minimum.Invoke(null, new object[] { null }));
        Assert.IsType<ArgumentNullException>(nil.InnerException);
        var navigation = FindMethod(assembly, "Navigation");
        var body = Assert.IsAssignableFrom<MethodBody>(navigation.GetMethodBody());
        var calls = IlInstructionReader.Read(Assert.IsType<byte[]>(body.GetILAsByteArray()))
            .Where(instruction => instruction.OpCode == OpCodes.Call)
            .Select(instruction => navigation.Module.ResolveMethod(instruction.MetadataToken.GetValueOrDefault()))
            .OfType<MethodInfo>()
            .ToArray();
        var include = Assert.Single(calls, method => method.Name == "IncludeChild");
        var then = Assert.Single(calls, method => method.Name == "ThenChild");
        Assert.Equal(new[] { entity, child, child }, then.GetGenericArguments());
        var property = Assert.Single(include.ReturnType.GetGenericArguments().Skip(1));
        Assert.Equal(typeof(ICollection<>).MakeGenericType(child), property);
        var expectedProperty = then.GetParameters()[0].ParameterType.GetGenericArguments()[1];
        Assert.Equal(typeof(IEnumerable<>).MakeGenericType(child), expectedProperty);
        Assert.Equal(include.ReturnType.GetGenericTypeDefinition(), then.GetParameters()[0].ParameterType.GetGenericTypeDefinition());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SymbolicSequenceInterfaces_BoxUnboxAndCheckActualRuntimeShape(bool asynchronous)
    {
        using var fixture = new Fixture();
        string wrapper = asynchronous ? "AsyncValue[Kind]" : "ImmutableArray[Kind]";
        string alias = asynchronous ? "async sequence[Kind]" : "sequence[Kind]";
        string alternate = asynchronous ? "AsyncReference[Kind]" : "[]Kind";
        string factory = asynchronous ? "AsyncValue[Kind](Kind.Second)" : "ImmutableArray.Create(Kind.Second)";
        string openAlias = asynchronous ? "async sequence[TElement]" : "sequence[TElement]";
        string selfAlias = asynchronous ? "async sequence[T]" : "sequence[T]";
        var result = fixture.Compile($$"""
            package Issue4731.SymbolicInterfaceEmission
            import System.Collections.Immutable
            import Issue4731.Contracts
            enum Kind { First, Second }

            class Counter {
                var Calls int32 = 0
                func Next() {{wrapper}} {
                    Calls = Calls + 1
                    return {{factory}}
                }
            }
            public func Values() {{wrapper}} -> {{factory}}
            public func Box(value {{wrapper}}) {{alias}} -> value
            public func Unbox(value {{alias}}) {{wrapper}} -> cast[{{wrapper}}](value)
            public func Checked[T](value T) {{alias}} -> cast[{{alias}}](value)
            public func CheckedOpen[TSource, TElement](value TSource) {{openAlias}} -> cast[{{openAlias}}](value)
            public func CheckedSelf[T](value T) {{selfAlias}} -> cast[{{selfAlias}}](value)
            public func Merge(first bool, value {{wrapper}}, other {{alternate}}) {{alias}} ->
                if first { value } else { other }
            public func CountCalls() int32 {
                let counter = Counter()
                let converted {{alias}} = counter.Next()
                return counter.Calls
            }
            """);
        Assert.True(result.ExitCode == 0, result.Output);
        IlVerifier.Verify(result.AssemblyPath, additionalReferences: new[] { fixture.AssemblyPath });
        var assembly = EmittedFixture.Load(result.AssemblyPath);
        var kind = Assert.Single(assembly.GetTypes(), type => type.Name == "Kind");
        var interfaceType = (asynchronous ? typeof(IAsyncEnumerable<>) : typeof(IEnumerable<>)).MakeGenericType(kind);
        var values = Assert.IsAssignableFrom<object>(FindMethod(assembly, "Values").Invoke(null, null));
        var wrapperType = values.GetType();
        var box = FindMethod(assembly, "Box");
        var unbox = FindMethod(assembly, "Unbox");
        var checkedCast = FindMethod(assembly, "Checked");
        var checkedOpen = FindMethod(assembly, "CheckedOpen");
        var checkedSelf = FindMethod(assembly, "CheckedSelf");
        Assert.Equal(interfaceType, box.ReturnType);
        Assert.Equal(interfaceType, Assert.Single(unbox.GetParameters()).ParameterType);
        Assert.Equal(wrapperType, unbox.ReturnType);
        Assert.Equal(1, FindMethod(assembly, "CountCalls").Invoke(null, null));

        object boxed = Assert.IsAssignableFrom<object>(box.Invoke(null, new[] { values }));
        Assert.Equal(values, unbox.Invoke(null, new[] { boxed }));
        Assert.Same(boxed, checkedCast.MakeGenericMethod(interfaceType).Invoke(null, new[] { boxed }));
        object genericBox = Assert.IsAssignableFrom<object>(
            checkedCast.MakeGenericMethod(wrapperType).Invoke(null, new[] { values }));
        Assert.Equal(values, unbox.Invoke(null, new[] { genericBox }));
        Assert.Equal(values, unbox.Invoke(null, new[]
        {
            checkedOpen.MakeGenericMethod(wrapperType, kind).Invoke(null, new[] { values }),
        }));
        Assert.Same(boxed, checkedOpen.MakeGenericMethod(interfaceType, kind).Invoke(null, new[] { boxed }));
        var selfCast = Assert.Throws<TargetInvocationException>(
            () => checkedSelf.MakeGenericMethod(kind).Invoke(null, new[] { Enum.ToObject(kind, 1) }));
        Assert.IsType<InvalidCastException>(selfCast.InnerException);
        foreach (var (type, value) in new[] { (typeof(object), new object()), (kind, Enum.ToObject(kind, 1)) })
        {
            var exception = Assert.Throws<TargetInvocationException>(
                () => checkedCast.MakeGenericMethod(type).Invoke(null, new[] { value }));
            Assert.IsType<InvalidCastException>(exception.InnerException);
        }

        object other;
        if (asynchronous)
        {
            var reference = FindMethod(assembly, "Merge").GetParameters()[2].ParameterType;
            Assert.Equal("Issue4731.Contracts.AsyncReference`1", reference.GetGenericTypeDefinition().FullName);
            Assert.Equal(kind, Assert.Single(reference.GetGenericArguments()));
            other = Assert.IsAssignableFrom<object>(
                Activator.CreateInstance(reference, Enum.ToObject(kind, 1)));
            var getEnumerator = interfaceType.GetMethod("GetAsyncEnumerator");
            Assert.NotNull(getEnumerator);
            object enumerator = Assert.IsAssignableFrom<object>(
                getEnumerator.Invoke(genericBox, new object[] { CancellationToken.None }));
            var enumeratorType = typeof(IAsyncEnumerator<>).MakeGenericType(kind);
            var moveNext = enumeratorType.GetMethod("MoveNextAsync");
            var current = enumeratorType.GetProperty("Current");
            Assert.NotNull(moveNext);
            Assert.NotNull(current);
            Assert.True(await Assert.IsType<ValueTask<bool>>(moveNext.Invoke(enumerator, null)));
            Assert.Equal(1, Convert.ToInt32(current.GetValue(enumerator)));
            Assert.False(await Assert.IsType<ValueTask<bool>>(moveNext.Invoke(enumerator, null)));
            await Assert.IsAssignableFrom<IAsyncDisposable>(enumerator).DisposeAsync();
        }
        else
        {
            var array = Array.CreateInstance(kind, 1);
            array.SetValue(Enum.ToObject(kind, 1), 0);
            other = array;
            var item = Assert.Single(Assert.IsAssignableFrom<System.Collections.IEnumerable>(genericBox).Cast<object>());
            Assert.Equal(1, Convert.ToInt32(item));
        }

        var wrongUnbox = Assert.Throws<TargetInvocationException>(() => unbox.Invoke(null, new[] { other }));
        Assert.IsType<InvalidCastException>(wrongUnbox.InnerException);
        var merge = FindMethod(assembly, "Merge");
        Assert.Equal(values, unbox.Invoke(null, new[] { merge.Invoke(null, new[] { (object)true, values, other }) }));
        Assert.Same(other, merge.Invoke(null, new[] { (object)false, values, other }));
        foreach (var (method, opcode, tokenType) in new[]
        {
            (box, OpCodes.Box, wrapperType),
            (unbox, OpCodes.Unbox_Any, wrapperType),
            (checkedCast, OpCodes.Box, checkedCast.GetGenericArguments()[0]),
            (checkedCast, OpCodes.Castclass, interfaceType),
            (checkedOpen, OpCodes.Box, checkedOpen.GetGenericArguments()[0]),
            (checkedOpen, OpCodes.Castclass, interfaceType.GetGenericTypeDefinition().MakeGenericType(checkedOpen.GetGenericArguments()[1])),
            (checkedSelf, OpCodes.Box, checkedSelf.GetGenericArguments()[0]),
            (checkedSelf, OpCodes.Castclass, interfaceType.GetGenericTypeDefinition().MakeGenericType(checkedSelf.GetGenericArguments()[0])),
        })
        {
            var body = Assert.IsAssignableFrom<MethodBody>(method.GetMethodBody());
            var bytes = Assert.IsType<byte[]>(body.GetILAsByteArray());
            var instruction = Assert.Single(IlInstructionReader.Read(bytes), instruction => instruction.OpCode == opcode);
            Assert.Equal(
                tokenType,
                method.Module.ResolveType(
                    BitConverter.ToInt32(bytes, instruction.Offset + instruction.OpCode.Size),
                    null,
                    method.GetGenericArguments()));
        }

        var mergeBody = Assert.IsAssignableFrom<MethodBody>(merge.GetMethodBody());
        Assert.Equal(2, IlInstructionReader.Read(Assert.IsType<byte[]>(mergeBody.GetILAsByteArray()))
            .Count(instruction => instruction.OpCode == OpCodes.Castclass));
    }

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
        public interface IParamsReceiver
        {
            T Choose<T>(T value, params System.Func<T>[] factories);
        }
        public sealed class ParamsReceiver : IParamsReceiver
        {
            public T Choose<T>(T value, params System.Func<T>[] factories) => factories[0]();
        }
        public interface IGenericParamsReceiver<TMarker>
        {
            T Choose<T>(T value, params System.Func<T>[] factories);
        }
        public sealed class GenericParamsReceiver<TMarker> : IGenericParamsReceiver<TMarker>
        {
            public T Choose<T>(T value, params System.Func<T>[] factories) => factories[0]();
        }
        public static class MapReader
        {
            public static int Count<K, V>(System.Collections.Generic.IDictionary<K, V> value)
                => value?.Count ?? -1;
        }
        public interface IQueryRoot<out T> { int Count { get; } }
        public interface IQueryProjection<out T, out TProperty> : IQueryRoot<T> { }
        public sealed class QueryRoot<T> : IQueryRoot<T>
        {
            public QueryRoot(int count) => Count = count;
            public int Count { get; }
        }
        public sealed class QueryProjection<T, TProperty> : IQueryProjection<T, TProperty>
        {
            public QueryProjection(int count) => Count = count;
            public int Count { get; }
        }
        public static class QueryExtensions
        {
            public static IQueryProjection<T, TProperty> IncludeChild<T, TProperty>(
                this IQueryRoot<T> source,
                System.Linq.Expressions.Expression<System.Func<T, TProperty>> navigation)
                => new QueryProjection<T, TProperty>(source.Count + 1);
            public static IQueryRoot<T> ThenChild<T, TPrevious, TProperty>(
                this IQueryProjection<T, System.Collections.Generic.IEnumerable<TPrevious>> source,
                System.Linq.Expressions.Expression<System.Func<TPrevious, TProperty>> navigation)
                => new QueryProjection<T, TProperty>(source.Count + 1);
        }
        public readonly struct AsyncValue<T> : System.Collections.Generic.IAsyncEnumerable<T>
        {
            private readonly T value;
            public AsyncValue(T value) => this.value = value;
            public System.Collections.Generic.IAsyncEnumerator<T> GetAsyncEnumerator(
                System.Threading.CancellationToken cancellationToken = default) => new Reader(value);
            private sealed class Reader : System.Collections.Generic.IAsyncEnumerator<T>
            {
                private bool ready = true;
                public Reader(T value) => Current = value;
                public T Current { get; }
                public System.Threading.Tasks.ValueTask<bool> MoveNextAsync()
                {
                    bool result = ready;
                    ready = false;
                    return new System.Threading.Tasks.ValueTask<bool>(result);
                }
                public System.Threading.Tasks.ValueTask DisposeAsync() => default;
            }
        }
        public sealed class AsyncReference<T> : System.Collections.Generic.IAsyncEnumerable<T>
        {
            private readonly T value;
            public AsyncReference(T value) => this.value = value;
            public System.Collections.Generic.IAsyncEnumerator<T> GetAsyncEnumerator(
                System.Threading.CancellationToken cancellationToken = default) =>
                new AsyncValue<T>(value).GetAsyncEnumerator(cancellationToken);
        }
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
