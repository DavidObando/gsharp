// <copyright file="Issue4731InheritedClrInterfaceConversionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Immutable
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Threading
import System.Threading.Tasks
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import SystemObject = System.Object
import GSharp.Compiler
import GSharp.Compiler.Tests
import System.Collections

class Issue4731InheritedClrInterfaceConversionEmitTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstrainedExpandedParams_PreserveSourceAndInferredResult(genericOwner bool) {
        using let fixture = Issue4731InheritedClrInterfaceConversionEmitTests.Fixture()
        let constraint = if genericOwner {
            "IGenericParamsReceiver[int32]"
        } else {
            "IParamsReceiver"
        }
        let receiver = if genericOwner {
            "GenericParamsReceiver[int32]"
        } else {
            "ParamsReceiver"
        }
        let result = fixture.Compile((`package Issue4731.ConstrainedParams
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
public func Dispatch[TReceiver ` + "$constraint" + `](receiver TReceiver, counter Counter) Base ->
    receiver.Choose(counter.Next(), counter.Factory)
public func Probe() int32 {
    let counter = Counter()
    let chosen = Dispatch(` + "$receiver" + `(), counter)
    return counter.Calls
}`))
        Assert.True(result.ExitCode == 0, result.Output)
        IlVerifier.Verify(result.AssemblyPath, additionalReferences: []string{fixture.AssemblyPath})
        let assembly = EmittedFixture.Load(result.AssemblyPath)
        Assert.Equal(11, FindMethod(assembly, "Probe").Invoke(nil, nil))
        let dispatch = FindMethod(assembly, "Dispatch")
        let baseType = Assert.Single(assembly.GetTypes(), (type Type) -> type.Name == "Base")
        Assert.Equal(baseType, dispatch.ReturnType)
        let body = Assert.IsAssignableFrom[MethodBody](dispatch.GetMethodBody())
        let chosenCall = Assert.Single(
            IlInstructionReader
                .Read(Assert.IsType[[]uint8](body.GetILAsByteArray()))
                .Where((instruction IlInstruction) -> instruction.OpCode == OpCodes.Callvirt)
                .Select(
                (instruction IlInstruction) -> dispatch.Module.ResolveMethod(
                    instruction.MetadataToken.GetValueOrDefault(),
                    nil,
                    dispatch.GetGenericArguments()
                )
            )
                .OfType[MethodInfo](),
            (method MethodInfo) -> method.Name == "Choose"
        )
        Assert.Equal(baseType, Assert.Single(chosenCall.GetGenericArguments()))
        Assert.Equal(baseType, chosenCall.ReturnType)
        Assert.Equal(baseType, chosenCall.GetParameters()[0].ParameterType)
        Assert.Equal(
            typeof(Func[_]).MakeGenericType(baseType).MakeArrayType(),
            chosenCall.GetParameters()[1].ParameterType
        )
        if genericOwner {
            let declaringType = Assert.IsAssignableFrom[Type](chosenCall.DeclaringType)
            Assert.Equal(typeof(int32), Assert.Single(declaringType.GetGenericArguments()))
        }
    }

    @Theory
    @InlineData("object", "GS0156")
    @InlineData("Other", "GS0155")
    func ImportedExpandedParams_UnrelatedActualSourceIsRejected(sourceType string, diagnostic string) {
        using let fixture = Issue4731InheritedClrInterfaceConversionEmitTests.Fixture()
        let result = fixture.Compile((`package Issue4731.ConstrainedParamsNegative
import Issue4731.Contracts
class Base {}
class Other {}
func Factory() Base -> Base()
public func Bad(receiver IParamsReceiver, value ` + "$sourceType" + `) object ->
    receiver.Choose[Base](value, Factory)`))
        Assert.NotEqual(0, result.ExitCode)
        Assert.True(result.Output.Contains("error " + diagnostic + ":", StringComparison.Ordinal), result.Output)
        Assert.False(File.Exists(result.AssemblyPath))
    }

    @Fact
    func NullableMapAtImportedGenericSlot_PreservesRuntimeAndOriginalNilPolicy() {
        using let fixture = Issue4731InheritedClrInterfaceConversionEmitTests.Fixture()
        let result = fixture.Compile(`package Issue4731.NullableMap
import Issue4731.Contracts
public func OpenMap[K, V](value map[K, V]?) int32 -> MapReader.Count[K, V](value)
public func ClosedMap(value map[string, int32]?) int32 -> MapReader.Count[string, int32](value)
public func Probe() int32 {
    let value = map[string, int32]{"first": 1, "second": 2}
    return OpenMap[string, int32](value) * 10 + ClosedMap(value)
}`)
        Assert.True(result.ExitCode == 0, result.Output)
        IlVerifier.Verify(result.AssemblyPath, additionalReferences: []string{fixture.AssemblyPath})
        let assembly = EmittedFixture.Load(result.AssemblyPath)
        Assert.Equal(22, FindMethod(assembly, "Probe").Invoke(nil, nil))
        let open_ = FindMethod(assembly, "OpenMap")
        let closed = FindMethod(assembly, "ClosedMap")
        Assert.Equal(-1, open_.MakeGenericMethod(typeof(string), typeof(int32)).Invoke(nil, []object? {nil}))
        Assert.Equal(-1, closed.Invoke(nil, []object? {nil}))
        let body = Assert.IsAssignableFrom[MethodBody](open_.GetMethodBody())
        let count = Assert.Single(
            IlInstructionReader
                .Read(Assert.IsType[[]uint8](body.GetILAsByteArray()))
                .Where((instruction IlInstruction) -> instruction.OpCode == OpCodes.Call)
                .Select(
                (instruction IlInstruction) -> open_.Module.ResolveMethod(
                    instruction.MetadataToken.GetValueOrDefault(),
                    nil,
                    open_.GetGenericArguments()
                )
            )
                .OfType[MethodInfo](),
            (method MethodInfo) -> method.Name == "Count"
        )
        Assert.Equal(open_.GetGenericArguments(), count.GetGenericArguments())
        Assert.Equal(
            typeof(IDictionary[_, _]).MakeGenericType(open_.GetGenericArguments()),
            Assert.Single(count.GetParameters()).ParameterType
        )
    }

    @Theory
    @InlineData("[]Other", "Item", "GS0155")
    @InlineData("List[Other]", "Item", "GS0155")
    @InlineData("sequence[List[Other]]", "List[Item]", "GS0155")
    @InlineData("sequence[(Other, int32)]", "(Item, int32)", "GS0156")
    @InlineData("sequence[ImmutableArray[Item]]", "IEnumerable[Item]", "GS0159")
    func ImportedGenericMethodSlot_UnrelatedSourceShapes_AreRejected(
        sourceType string,
        elementType string,
        diagnostic string
    ) {
        using let fixture = Issue4731InheritedClrInterfaceConversionEmitTests.Fixture()
        let result = fixture.Compile((`package Issue4731.GenericSlotNegative
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
class Item {}
class Other {}
func Unsafe(value ` + "$sourceType" + `) int32 ->
    Enumerable.Count[` + "$elementType" + `](value)`))
        Assert.NotEqual(0, result.ExitCode)
        Assert.True(result.Output.Contains("error " + diagnostic + ":", StringComparison.Ordinal), result.Output)
        Assert.False(File.Exists(result.AssemblyPath))
    }

    @Fact
    func ImportedGenericMethodSlots_NullableReferencePolicies_PreserveActualRuntimeSignatures() {
        using let fixture = Issue4731InheritedClrInterfaceConversionEmitTests.Fixture()
        let result = fixture.Compile(`package Issue4731.NullableClrArgument
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
}`)
        Assert.True(result.ExitCode == 0, result.Output)
        IlVerifier.Verify(result.AssemblyPath, additionalReferences: []string{fixture.AssemblyPath})
        let assembly = EmittedFixture.Load(result.AssemblyPath)
        Assert.Equal(11, FindMethod(assembly, "Probe").Invoke(nil, nil))
        let kind = Assert.Single(assembly.GetTypes(), (type Type) -> type.Name == "Kind")
        let child = Assert.Single(assembly.GetTypes(), (type Type) -> type.Name == "Child")
        let entity = Assert.Single(assembly.GetTypes(), (type Type) -> type.Name == "Entity")
        let minimum = FindMethod(assembly, "Minimum")
        Assert.Equal(typeof(IEnumerable[_]).MakeGenericType(kind), Assert.Single(minimum.GetParameters()).ParameterType)
        let nil_ = Assert.Throws[TargetInvocationException](
            func () object? {
                return minimum.Invoke(nil, []object? {nil})
            }
        )
        Assert.IsType[ArgumentNullException](nil_.InnerException)
        let navigation = FindMethod(assembly, "Navigation")
        let body = Assert.IsAssignableFrom[MethodBody](navigation.GetMethodBody())
        let calls = IlInstructionReader
            .Read(Assert.IsType[[]uint8](body.GetILAsByteArray()))
            .Where((instruction IlInstruction) -> instruction.OpCode == OpCodes.Call)
            .Select(
            (instruction IlInstruction) -> navigation.Module.ResolveMethod(
                instruction.MetadataToken.GetValueOrDefault()
            )
        )
            .OfType[MethodInfo]()
            .ToArray()
        let include = Assert.Single(calls, (method MethodInfo) -> method.Name == "IncludeChild")
        let then = Assert.Single(calls, (method MethodInfo) -> method.Name == "ThenChild")
        Assert.Equal([]Type{entity, child, child}, then.GetGenericArguments())
        let property = Assert.Single(include.ReturnType.GetGenericArguments().Skip(1))
        Assert.Equal(typeof(ICollection[_]).MakeGenericType(child), property)
        let expectedProperty = then.GetParameters()[0].ParameterType.GetGenericArguments()[1]
        Assert.Equal(typeof(IEnumerable[_]).MakeGenericType(child), expectedProperty)
        Assert.Equal(
            include.ReturnType.GetGenericTypeDefinition(),
            then.GetParameters()[0].ParameterType.GetGenericTypeDefinition()
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    async func SymbolicSequenceInterfaces_BoxUnboxAndCheckActualRuntimeShape(asynchronous bool) {
        using let fixture = Issue4731InheritedClrInterfaceConversionEmitTests.Fixture()
        let wrapper = if asynchronous {
            "AsyncValue[Kind]"
        } else {
            "ImmutableArray[Kind]"
        }
        let alias = if asynchronous {
            "async sequence[Kind]"
        } else {
            "sequence[Kind]"
        }
        let alternate = if asynchronous {
            "AsyncReference[Kind]"
        } else {
            "[]Kind"
        }
        let factory = if asynchronous {
            "AsyncValue[Kind](Kind.Second)"
        } else {
            "ImmutableArray.Create(Kind.Second)"
        }
        let openAlias = if asynchronous {
            "async sequence[TElement]"
        } else {
            "sequence[TElement]"
        }
        let selfAlias = if asynchronous {
            "async sequence[T]"
        } else {
            "sequence[T]"
        }
        let result = fixture.Compile((`package Issue4731.SymbolicInterfaceEmission
import System.Collections.Immutable
import Issue4731.Contracts
enum Kind { First, Second }

class Counter {
    var Calls int32 = 0
    func Next() ` + "$wrapper" + ` {
        Calls = Calls + 1
        return ` + "$factory" + `
    }
}
public func Values() ` + "$wrapper" + ` -> ` + "$factory" + `
public func Box(value ` + "$wrapper" + `) ` + "$alias" + ` -> value
public func Unbox(value ` + "$alias" + `) ` + "$wrapper" + ` -> cast[` + "$wrapper" + `](value)
public func Checked[T](value T) ` + "$alias" + ` -> cast[` + "$alias" + `](value)
public func CheckedOpen[TSource, TElement](value TSource) ` + "$openAlias" + ` -> cast[` + "$openAlias" + `](value)
public func CheckedSelf[T](value T) ` + "$selfAlias" + ` -> cast[` + "$selfAlias" + `](value)
public func Merge(first bool, value ` + "$wrapper" + `, other ` + "$alternate" + `) ` + "$alias" + ` ->
    if first { value } else { other }
public func CountCalls() int32 {
    let counter = Counter()
    let converted ` + "$alias" + ` = counter.Next()
    return counter.Calls
}`))
        Assert.True(result.ExitCode == 0, result.Output)
        IlVerifier.Verify(result.AssemblyPath, additionalReferences: []string{fixture.AssemblyPath})
        let assembly = EmittedFixture.Load(result.AssemblyPath)
        let kind = Assert.Single(assembly.GetTypes(), (type Type) -> type.Name == "Kind")
        let interfaceType = (
            if asynchronous {
                typeof(IAsyncEnumerable[_])
            } else {
                typeof(IEnumerable[_])
            }
        ).MakeGenericType(kind)
        let values = Assert.IsAssignableFrom[object](FindMethod(assembly, "Values").Invoke(nil, nil))
        let wrapperType = values.GetType()
        let box = FindMethod(assembly, "Box")
        let unbox = FindMethod(assembly, "Unbox")
        let checkedCast = FindMethod(assembly, "Checked")
        let checkedOpen = FindMethod(assembly, "CheckedOpen")
        let checkedSelf = FindMethod(assembly, "CheckedSelf")
        Assert.Equal(interfaceType, box.ReturnType)
        Assert.Equal(interfaceType, Assert.Single(unbox.GetParameters()).ParameterType)
        Assert.Equal(wrapperType, unbox.ReturnType)
        Assert.Equal(1, FindMethod(assembly, "CountCalls").Invoke(nil, nil))
        let boxed = Assert.IsAssignableFrom[object](box.Invoke(nil, []object{values}))
        Assert.Equal(values, unbox.Invoke(nil, []object{boxed}))
        Assert.Same(boxed, checkedCast.MakeGenericMethod(interfaceType).Invoke(nil, []object{boxed}))
        let genericBox = Assert.IsAssignableFrom[object](
            checkedCast.MakeGenericMethod(wrapperType).Invoke(nil, []object{values})
        )
        Assert.Equal(values, unbox.Invoke(nil, []object{genericBox}))
        Assert.Equal(
            values,
            unbox.Invoke(nil, []object{checkedOpen.MakeGenericMethod(wrapperType, kind).Invoke(nil, []object{values})})
        )
        Assert.Same(boxed, checkedOpen.MakeGenericMethod(interfaceType, kind).Invoke(nil, []object{boxed}))
        let selfCast = Assert.Throws[TargetInvocationException](
            func () object? {
                return checkedSelf.MakeGenericMethod(kind).Invoke(nil, []object{Enum.ToObject(kind, 1)})
            }
        )
        Assert.IsType[InvalidCastException](selfCast.InnerException)
        for (type, value) in[](Type, object){(typeof(object), SystemObject()), (kind, Enum.ToObject(kind, 1))} {
            let exception = Assert.Throws[TargetInvocationException](
                func () object? {
                    return checkedCast.MakeGenericMethod(type).Invoke(nil, []object{value})
                }
            )
            Assert.IsType[InvalidCastException](exception.InnerException)
        }
        var other object
        if asynchronous {
            let reference = FindMethod(assembly, "Merge").GetParameters()[2].ParameterType
            Assert.Equal("Issue4731.Contracts.AsyncReference`1", reference.GetGenericTypeDefinition().FullName)
            Assert.Equal(kind, Assert.Single(reference.GetGenericArguments()))
            other = Assert.IsAssignableFrom[object](Activator.CreateInstance(reference, Enum.ToObject(kind, 1)))
            let getEnumerator MethodInfo? = interfaceType.GetMethod("GetAsyncEnumerator")
            Assert.NotNull(getEnumerator)
            let enumerator = Assert.IsAssignableFrom[object](
                getEnumerator!!.Invoke(genericBox, []object{CancellationToken.None})
            )
            let enumeratorType = typeof(IAsyncEnumerator[_]).MakeGenericType(kind)
            let moveNext MethodInfo? = enumeratorType.GetMethod("MoveNextAsync")
            let current PropertyInfo? = enumeratorType.GetProperty("Current")
            Assert.NotNull(moveNext)
            Assert.NotNull(current)
            Assert.True(await Assert.IsType[ValueTask[bool]](moveNext!!.Invoke(enumerator, nil)))
            Assert.Equal(1, Convert.ToInt32(current!!.GetValue(enumerator)))
            Assert.False(await Assert.IsType[ValueTask[bool]](moveNext!!.Invoke(enumerator, nil)))
            await Assert.IsAssignableFrom[IAsyncDisposable](enumerator).DisposeAsync()
        } else {
            let array = Array.CreateInstance(kind, 1)
            array.SetValue(Enum.ToObject(kind, 1), 0)
            other = array
            let item = Assert.Single(Assert.IsAssignableFrom[IEnumerable](genericBox).Cast[object]())
            Assert.Equal(1, Convert.ToInt32(item))
        }
        let wrongUnbox = Assert.Throws[TargetInvocationException](
            func () object? {
                return unbox.Invoke(nil, []object{other})
            }
        )
        Assert.IsType[InvalidCastException](wrongUnbox.InnerException)
        let merge = FindMethod(assembly, "Merge")
        Assert.Equal(values, unbox.Invoke(nil, []object{merge.Invoke(nil, []object{object(true), values, other})}))
        Assert.Same(other, merge.Invoke(nil, []object{object(false), values, other}))
        for (method, opcode, tokenType) in[](MethodInfo, OpCode, Type){
            (box, OpCodes.Box, wrapperType),
            (unbox, OpCodes.Unbox_Any, wrapperType),
            (checkedCast, OpCodes.Box, checkedCast.GetGenericArguments()[0]),
            (checkedCast, OpCodes.Castclass, interfaceType),
            (checkedOpen, OpCodes.Box, checkedOpen.GetGenericArguments()[0]),
            (
                checkedOpen,
                OpCodes.Castclass,
                interfaceType.GetGenericTypeDefinition().MakeGenericType(checkedOpen.GetGenericArguments()[1])
            ),
            (checkedSelf, OpCodes.Box, checkedSelf.GetGenericArguments()[0]),
            (
                checkedSelf,
                OpCodes.Castclass,
                interfaceType.GetGenericTypeDefinition().MakeGenericType(checkedSelf.GetGenericArguments()[0])
            )
        } {
            let body = Assert.IsAssignableFrom[MethodBody](method.GetMethodBody())
            let bytes = Assert.IsType[[]uint8](body.GetILAsByteArray())
            let instruction = Assert.Single(
                IlInstructionReader.Read(bytes),
                (instruction IlInstruction) -> instruction.OpCode == opcode
            )
            Assert.Equal(
                tokenType,
                method.Module.ResolveType(
                    BitConverter.ToInt32(bytes, instruction.Offset + instruction.OpCode.Size),
                    nil,
                    method.GetGenericArguments()
                )
            )
        }
        let mergeBody = Assert.IsAssignableFrom[MethodBody](merge.GetMethodBody())
        Assert.Equal(
            2,
            IlInstructionReader.Read(Assert.IsType[[]uint8](mergeBody.GetILAsByteArray())).Count(
                (instruction IlInstruction) -> instruction.OpCode == OpCodes.Castclass
            )
        )
    }

    @Fact
    func SymbolicValueWrapper_ExactDirectAndClosureConsumers_BoxActualValueShape() {
        using let fixture = Issue4731InheritedClrInterfaceConversionEmitTests.Fixture()
        let result = fixture.Compile(`package Issue4731.SymbolicValueBoxing
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
}`)
        Assert.True(result.ExitCode == 0, result.Output)
        IlVerifier.Verify(result.AssemblyPath, additionalReferences: []string{fixture.AssemblyPath})
        let assembly = EmittedFixture.Load(result.AssemblyPath)
        Assert.Equal(37, FindMethod(assembly, "Probe").Invoke(nil, nil))
        let kind = Assert.Single(assembly.GetTypes(), (type Type) -> type.Name == "Kind")
        let wrapper = typeof(ImmutableArray[_]).MakeGenericType(kind)
        let enumerable = typeof(IEnumerable[_]).MakeGenericType(kind)
        let direct = FindMethod(assembly, "Direct")
        Assert.Equal(
            []Type{wrapper, wrapper},
            direct.GetParameters().Select((parameter ParameterInfo) -> parameter.ParameterType)
        )
        let closure = Assert.Single(
            assembly.GetTypes(),
            (type Type) -> type.Name.StartsWith("<closure_", StringComparison.Ordinal)
        )
        let invoke = Assert.Single(closure.GetMethods(), (method MethodInfo) -> method.Name == "Invoke")
        Assert.Equal(wrapper, Assert.Single(invoke.GetParameters()).ParameterType)
        for method in[]MethodInfo{direct, invoke} {
            let body = Assert.IsAssignableFrom[MethodBody](method.GetMethodBody())
            let bytes = Assert.IsType[[]uint8](body.GetILAsByteArray())
            let instructions = IlInstructionReader.Read(bytes).ToArray()
            let boxes = instructions.Where((instruction IlInstruction) -> instruction.OpCode == OpCodes.Box).ToArray()
            Assert.Equal(2, boxes.Length)
            Assert.All(
                boxes,
                (instruction IlInstruction) -> Assert.Equal(
                    wrapper,
                    method.Module.ResolveType(BitConverter.ToInt32(bytes, instruction.Offset + instruction.OpCode.Size))
                )
            )
            let sequenceEqual = Assert.Single(
                instructions
                    .Where((instruction IlInstruction) -> instruction.OpCode == OpCodes.Call)
                    .Select(
                    (instruction IlInstruction) -> method.Module.ResolveMethod(
                        instruction.MetadataToken.GetValueOrDefault()
                    )
                )
                    .OfType[MethodInfo](),
                (callee MethodInfo) -> callee.DeclaringType == typeof(Enumerable) && callee.Name == "SequenceEqual"
            )
            Assert.Equal(kind, Assert.Single(sequenceEqual.GetGenericArguments()))
            Assert.Equal(
                []Type{enumerable, enumerable},
                sequenceEqual.GetParameters().Select((parameter ParameterInfo) -> parameter.ParameterType)
            )
        }
    }

    @Theory
    @InlineData("ImmutableArray[int32]", "IEnumerable[object]")
    @InlineData("ImmutableArray[List[Item]]", "IEnumerable[List[object]]")
    func ImportedValueWrapper_UnsafeVarianceIsRejectedWithoutEmission(sourceType string, targetType string) {
        using let fixture = Issue4731InheritedClrInterfaceConversionEmitTests.Fixture()
        let result = fixture.Compile((`package Issue4731.ImportedValueProjectionNegative
import System.Collections.Generic
import System.Collections.Immutable
class Item {}
func Unsafe(value ` + "$sourceType" + `) ` + "$targetType" + ` -> value`))
        Assert.NotEqual(0, result.ExitCode)
        Assert.Contains("error GS0155:", result.Output, StringComparison.Ordinal)
        Assert.False(File.Exists(result.AssemblyPath))
    }

    @Fact
    func ImportedValueWrapper_ClosedInterfaceProjection_BoxesAndEnumeratesActualSymbols() {
        using let fixture = Issue4731InheritedClrInterfaceConversionEmitTests.Fixture()
        let roslynReference = typeof(IMethodSymbol).Assembly.Location
        let result = fixture.Compile(`package Issue4731.ImportedValueProjection
import System.Collections.Generic
import System.Collections.Immutable
import Microsoft.CodeAnalysis
public func Direct(value ImmutableArray[IMethodSymbol]) IEnumerable[ISymbol] -> value
public func Constructors(value INamedTypeSymbol) IEnumerable[ISymbol] -> value.InstanceConstructors
public func Implementations(value IMethodSymbol) IEnumerable[ISymbol] -> value.ExplicitInterfaceImplementations`, roslynReference)
        Assert.True(result.ExitCode == 0, result.Output)
        IlVerifier.Verify(result.AssemblyPath, additionalReferences: []string{fixture.AssemblyPath, roslynReference})
        let compilation = CSharpCompilation.Create("Issue4731.SymbolProducer", []SyntaxTree{CSharpSyntaxTree.ParseText(`interface IContract { void Read(); }
sealed class Sample : IContract
{
    public Sample() { }
    void IContract.Read() { }
}`)}, ReferenceResolver
                .HostTrustedPlatformAssemblyPaths()
                .Select(
                (path string) -> MetadataReference.CreateFromFile(path)
            ), CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary))
        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
        )
        let owner INamedTypeSymbol? = compilation.GetTypeByMetadataName("Sample")
        Assert.NotNull(owner)
        let implementation = Assert.Single(
            owner!!.GetMembers().OfType[IMethodSymbol](),
            (method IMethodSymbol) -> !method.ExplicitInterfaceImplementations.IsEmpty
        )
        let assembly = EmittedFixture.Load(result.AssemblyPath)
        let direct = FindMethod(assembly, "Direct")
        Assert.Equal(typeof(ImmutableArray[IMethodSymbol]), Assert.Single(direct.GetParameters()).ParameterType)
        Assert.Equal(typeof(IEnumerable[ISymbol]), direct.ReturnType)
        for name in[]string{"Direct", "Constructors", "Implementations"} {
            let method = FindMethod(assembly, name)
            let argument object? = switch name {
                case "Direct": owner!!.InstanceConstructors
                case "Constructors": (owner as object)
                default: cast[object](implementation)
            }
            let values = Assert.IsAssignableFrom[IEnumerable[ISymbol]](method.Invoke(nil, []object{argument}))
            let symbol = Assert.Single(values)
            Assert.Equal(
                if name == "Implementations" {
                    "Read"
                } else {
                    ".ctor"
                },
                symbol.Name
            )
            Assert.Same(
                if name == "Implementations" {
                    implementation.ExplicitInterfaceImplementations[0]
                } else {
                    owner!!.InstanceConstructors[0]
                },
                symbol
            )
        }
    }

    @Fact
    func SealedRenderable_ImplicitCheckedAndTransitiveUpcasts_PreserveIdentityAndDispatch() {
        using let fixture = Issue4731InheritedClrInterfaceConversionEmitTests.Fixture()
        let result = fixture.Compile(`package Issue4731.Consumer
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
}`)
        Assert.True(result.ExitCode == 0, result.Output)
        IlVerifier.Verify(result.AssemblyPath, additionalReferences: []string{fixture.AssemblyPath})
        let loaded = EmittedFixture.LoadTogether(fixture.AssemblyPath, result.AssemblyPath)
        let assembly = loaded[1]
        let dock = Assert.Single(assembly.GetTypes(), (type Type) -> type.Name == "Dock")
        Assert.True(dock.IsSealed)
        Assert.Contains(dock.GetInterfaces(), (type Type) -> type.FullName == "Issue4731.Contracts.IRenderable")
        Assert.Equal(76, FindMethod(assembly, "Probe").Invoke(nil, nil))
        Assert.Null(FindMethod(assembly, "NullableCast").Invoke(nil, []object? {nil}))
    }

    @Fact
    func GenericOwnerSubstitutionAndVariance_PreserveIdentityAndInheritedDispatch() {
        using let fixture = Issue4731InheritedClrInterfaceConversionEmitTests.Fixture()
        let result = fixture.Compile(`package Issue4731.Generic
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
}`)
        Assert.True(result.ExitCode == 0, result.Output)
        IlVerifier.Verify(result.AssemblyPath, additionalReferences: []string{fixture.AssemblyPath})
        let loaded = EmittedFixture.LoadTogether(fixture.AssemblyPath, result.AssemblyPath)
        Assert.Equal(221, FindMethod(loaded[1], "Probe").Invoke(nil, nil))
    }

    @Fact
    func SequenceAlias_ExactAndReferenceVariance_PreserveIdentityAndDispatch() {
        using let fixture = Issue4731InheritedClrInterfaceConversionEmitTests.Fixture()
        let result = fixture.Compile(`package Issue4731.Sequences
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
}`)
        Assert.True(result.ExitCode == 0, result.Output)
        IlVerifier.Verify(result.AssemblyPath, additionalReferences: []string{fixture.AssemblyPath})
        let loaded = EmittedFixture.LoadTogether(fixture.AssemblyPath, result.AssemblyPath)
        Assert.Equal(1, FindMethod(loaded[1], "Probe").Invoke(nil, nil))
        Assert.Equal(1, FindMethod(loaded[1], "TupleProbe").Invoke(nil, nil))
        let item = Assert.Single(loaded[1].GetTypes(), (type Type) -> type.Name == "Item")
        let tuple = typeof(ValueTuple[_, _]).MakeGenericType(item, typeof(int32))
        Assert.Equal(typeof(IEnumerable[_]).MakeGenericType(tuple), FindMethod(loaded[1], "TupleValues").ReturnType)
        Assert.Equal(typeof(IEnumerable[[]int32]), FindMethod(loaded[1], "ArrayValues").ReturnType)
        let arrays = Assert.IsAssignableFrom[IEnumerable[[]int32]](
            FindMethod(loaded[1], "ArrayValues").Invoke(nil, nil)
        )
        Assert.Equal([]int32{3, 5, 7}, Assert.Single(arrays))
    }

    @Fact
    func ImportedSequenceReturns_IteratorHoistedFields_RetainPhysicalElementAndRuntimeValues() {
        using let fixture = Issue4731InheritedClrInterfaceConversionEmitTests.Fixture()
        let result = fixture.Compile(`package Issue4731.PhysicalSequences
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
}`)
        Assert.True(result.ExitCode == 0, result.Output)
        let loaded = EmittedFixture.LoadTogether(fixture.AssemblyPath, result.AssemblyPath)
        let assembly = loaded[1]
        let item = Assert.Single(assembly.GetTypes(), (type Type) -> type.Name == "Item")
        let enumerable = typeof(IEnumerable[_]).MakeGenericType(item)
        let enumerator = typeof(IEnumerator[_]).MakeGenericType(item)
        for (name, producer, count) in[](string, string, int32){
            ("ConcatRows", "Concat", 2),
            ("WhereRows", "Where", 1)
        } {
            let rows = Assert.IsAssignableFrom[IEnumerable[[]object]](FindMethod(assembly, name).Invoke(nil, nil))
            Assert.Equal(
                Enumerable.Repeat("one", count),
                rows.Select((row[]object) -> Assert.IsType[string](Assert.Single(row)))
            )
            let state = Assert.Single(
                assembly.GetTypes(),
                (type Type) -> type.Name.StartsWith("<" + name + ">", StringComparison.Ordinal)
            )
            Assert.Contains(
                state.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance),
                (field FieldInfo) -> field.FieldType == enumerator
            )
            let moveNext = Assert.Single(
                state.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance),
                (method MethodInfo) -> method.Name == "MoveNext"
            )
            let body = Assert.IsAssignableFrom[MethodBody](moveNext.GetMethodBody())
            let bytes = Assert.IsType[[]uint8](body.GetILAsByteArray())
            let call = Assert.Single(
                IlInstructionReader
                    .Read(bytes)
                    .Where(
                    (instruction IlInstruction) -> instruction.OpCode == OpCodes.Call ||
                        instruction.OpCode == OpCodes.Callvirt
                )
                    .Where((instruction IlInstruction) -> (instruction.MetadataToken != nil))
                    .Select(
                    (instruction IlInstruction) -> moveNext.Module.ResolveMethod(
                        instruction.MetadataToken.GetValueOrDefault()
                    )
                )
                    .OfType[MethodInfo](),
                (method MethodInfo) -> method.DeclaringType == typeof(Enumerable) && method.Name == producer
            )
            Assert.Equal(enumerable, call.ReturnType)
            Assert.Equal(item, Assert.Single(call.GetGenericArguments()))
        }
        IlVerifier.Verify(result.AssemblyPath, additionalReferences: []string{fixture.AssemblyPath})
    }

    @Theory
    @InlineData("sequence[List[Item]]", "sequence[List[object]]", "GS0155")
    @InlineData("sequence[List[Item]]", "IEnumerable[List[object]]", "GS0155")
    @InlineData("async sequence[List[Item]]", "async sequence[List[object]]", "GS0155")
    @InlineData("async sequence[List[Item]]", "IAsyncEnumerable[List[object]]", "GS0155")
    @InlineData("sequence[sequence[List[Item]]]", "sequence[sequence[List[object]]]", "GS0155")
    @InlineData("sequence[List[Item]?]", "sequence[List[object]?]", "GS0155")
    @InlineData("sequence[(Item, int32)]", "sequence[(object, int32)]", "GS0156")
    @InlineData("sequence[List[(Item, int32)]]", "sequence[List[(object, int32)]]", "GS0155")
    @InlineData("async sequence[(Item, int32)]", "async sequence[(object, int32)]", "GS0156")
    @InlineData("sequence[[3]int32]", "sequence[[4]int32]", "GS0155")
    @InlineData("async sequence[[3]int32]", "IAsyncEnumerable[[4]int32]", "GS0155")
    @InlineData("sequence[[]int32]", "sequence[[3]int32]", "GS0155")
    @InlineData("sequence[List[[]Item]]", "sequence[List[[]object]]", "GS0155")
    func NestedInvariantSequenceElements_AreRejectedWithoutEmission(
        sourceType string,
        targetType string,
        diagnostic string
    ) {
        using let fixture = Issue4731InheritedClrInterfaceConversionEmitTests.Fixture()
        let result = fixture.Compile((`package Issue4731.NestedInvariant
import System.Collections.Generic
class Item {}
func Unsafe(value ` + "$sourceType" + `) ` + "$targetType" + ` -> value`))
        Assert.Equal(1, result.ExitCode)
        Assert.Contains("error " + diagnostic + ":", result.Output, StringComparison.Ordinal)
        Assert.False(File.Exists(result.AssemblyPath))
    }

    @Theory
    @InlineData("IEnumerable[object]")
    @InlineData("sequence[object]")
    func UnconstrainedSequenceSource_CannotWidenToObjectElements(target string) {
        using let fixture = Issue4731InheritedClrInterfaceConversionEmitTests.Fixture()
        let result = fixture.Compile((`package Issue4731.ReifiedNegative
import System.Collections.Generic
func Unsafe[T](value sequence[T]) ` + "$target" + ` -> value`))
        Assert.Equal(1, result.ExitCode)
        Assert.True(result.Output.Contains("GS0156", StringComparison.Ordinal), result.Output)
        Assert.False(File.Exists(result.AssemblyPath))
    }

    @Theory
    @InlineData("IEnumerable[object]")
    @InlineData("sequence[object]")
    func UnconstrainedSequenceVariance_IsRejectedWithoutEmission(targetType string) {
        using let fixture = Issue4731InheritedClrInterfaceConversionEmitTests.Fixture()
        let result = fixture.Compile((`package Issue4731.RejectedSequence
import System.Collections.Generic
class Leaf[T] : List[T] {}
func Widen[T](value Leaf[T]) ` + "$targetType" + ` -> value`))
        Assert.NotEqual(0, result.ExitCode)
        Assert.Contains("error GS0155:", result.Output, StringComparison.Ordinal)
        Assert.False(File.Exists(result.AssemblyPath))
    }

    @Theory
    @InlineData("class Leaf {}", "Leaf", "IRenderable", "cast[IRenderable](value)")
    @InlineData("class Leaf : Reordered[int32, int32] {}", "Leaf", "ISource[object]", "value")
    @InlineData(`class Item {}
class Other {}
class Leaf : Invariant[Item] {}`, "Leaf", "IInvariant[Other]", "value")
    func UnrelatedSealedAndInvalidGenericConversions_AreRejected(
        declarations string,
        sourceType string,
        targetType string,
        expression string
    ) {
        using let fixture = Issue4731InheritedClrInterfaceConversionEmitTests.Fixture()
        let result = fixture.Compile((`package Issue4731.Rejected
import Issue4731.Contracts
` + "$declarations" + `
func Convert(value ` + "$sourceType" + `) ` + "$targetType" + ` -> ` + "$expression"))
        Assert.NotEqual(0, result.ExitCode)
        Assert.Contains("error GS0155:", result.Output, StringComparison.Ordinal)
        Assert.False(File.Exists(result.AssemblyPath))
    }

    private class Fixture : IDisposable {
        private let directory string = Path.Combine(
            AppContext.BaseDirectory,
            "Issue4731InheritedClrInterfaceConversionEmitTests",
            Guid.NewGuid().ToString("N")
        )

        init() {
            Directory.CreateDirectory(directory)
            AssemblyPath = Path.Combine(directory, "Issue4731.Contracts.dll")
            let compilation = CSharpCompilation.Create(
                "Issue4731.Contracts",
                []SyntaxTree{
                    CSharpSyntaxTree.ParseText(Issue4731InheritedClrInterfaceConversionEmitTests.ContractSource)
                },
                ReferenceResolver.HostTrustedPlatformAssemblyPaths().Select(
                    (path string) -> MetadataReference.CreateFromFile(path)
                ),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = File.Create(AssemblyPath)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }

        prop AssemblyPath string {
            get;
        }

        func Compile(source string, additionalReferences ...string)(
            ExitCode int32,
            Output string,
            AssemblyPath string
        ) {
            let sourcePath = Path.Combine(directory, "Consumer.gs")
            let outputPath = Path.Combine(directory, "Consumer.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            var exitCode int32
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                exitCode = Program.Main(
                    []string{
                        "/target:library",
                        "/targetframework:net10.0",
                        "/r:" + AssemblyPath,
                        "/out:" + outputPath,
                        sourcePath
                    }
                        .Concat(additionalReferences.Select((path string) -> ("/r:" + path))).ToArray()
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            return (exitCode, stdout.ToString() + stderr.ToString(), outputPath)
        }

        func Dispose() -> Directory.Delete(directory, recursive: true)
    }

    shared {
        private const ContractSource string = `#nullable enable
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
}`

        private func FindMethod(assembly Assembly, name string) MethodInfo -> Assert.Single(
            assembly.GetTypes().SelectMany(
                func (type Type) IEnumerable[MethodInfo] {
                    return type.GetMethods(BindingFlags.Public | BindingFlags.Static)
                }
            ),
            (method MethodInfo) -> method.Name == name
        )
    }
}
