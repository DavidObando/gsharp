// <copyright file="Issue4675RecordPrimaryConstructorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import System
import System.Collections.Immutable
import System.Reflection
import System.Reflection.Emit
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import Xunit
import GSharp.Core.CodeAnalysis

open class Issue4675RecordPrimaryConstructorEmitTests {
    @Fact
    func PositionalLiteralWithBracedMember_UsesExplicitConstructorArgument() {
        let result = EmittedOracle.Evaluate(`import System.Collections.Generic
data struct Box(Value int32) {
    public var Items List[int32] = List[int32]()
    private let Marker int32 = Value + 4
    public func Read() int32 -> Marker + Items[0]
}
Box{Value: 7, Items: {1}}.Read()`)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(12, result.Value)
    }

    @Theory
    @InlineData("data struct", false)
    @InlineData("data class", false)
    @InlineData("data struct", true)
    @InlineData("data class", true)
    func PositionalLiteral_StagesBodyValuesInWrittenOrder(kind string, braced bool) {
        let result = EmittedOracle.Evaluate(`import System.Collections.Generic
class Counter {
    shared {
        public var Count int32
        public func Next() int32 {
            Count += 1
            return Count
        }
    }
}
KIND Pair(A int32) {
    public var Extra int32
    public var Items List[int32] = List[int32]()
}
let pair = Pair{Extra: Counter.Next(), A: Counter.Next()SUFFIX}
pair.A * 10 + pair.Extra`.Replace("KIND", kind, StringComparison.Ordinal)
                .Replace(
                "SUFFIX",
                if braced {
                    ", Items: {1}"
                } else {
                    string.Empty
                },
                StringComparison.Ordinal
            ))
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(
            if kind == "data struct" {
                12
            } else {
                21
            },
            result.Value
        )
    }

    @Fact
    func EmittedDeconstruct_DispatchesVirtualPositionalGetter() {
        let result = EmittedOracle.Evaluate(`open data class Item(Value int32) {
    public open prop Value int32 { get; init; }
}
data class Derived : Item(1) {
    public override prop Value int32 {
        get { return 42 }
        init { }
    }
}
Derived{}`)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.NotNull(result.Value)
        Assert.True(result.Value!!.GetType().BaseType!!.GetProperty("Value")!!.GetMethod!!.IsVirtual)
        Assert.Contains(
            result.Value!!.GetType().BaseType!!.GetFields(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
            ),
            (field FieldInfo) -> field.FieldType == typeof(int32) && object.Equals(field.GetValue(result.Value), 1)
        )
        let deconstruct MethodInfo? = result.Value!!.GetType().BaseType!!.GetMethod("Deconstruct")
        Assert.NotNull(deconstruct)
        let arguments[]object = []object? {nil}
        deconstruct!!.Invoke(result.Value, arguments)
        Assert.Equal(42, arguments[0])
    }

    @Theory
    @InlineData("ref")
    @InlineData("ref readonly")
    func EmittedDeconstruct_ReadsRefReturningPositionalGetter(refKind string) {
        let result = EmittedOracle.Evaluate(`data class Item(Value int32) {
    private var Storage int32 = Value
    public prop Value REF int32 { get { return ref Storage } }
}
Item(41)`.Replace("REF", refKind, StringComparison.Ordinal))
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.NotNull(result.Value)
        let deconstruct MethodInfo? = result.Value!!.GetType().GetMethod("Deconstruct")
        Assert.NotNull(deconstruct)
        let arguments[]object = []object? {nil}
        deconstruct!!.Invoke(result.Value, arguments)
        Assert.Equal(41, arguments[0])
    }

    @Fact
    func PositionalLiteral_EvaluatesArgumentsInWrittenOrder() {
        let result = EmittedOracle.Evaluate(`class Counter {
    shared {
        public var Count int32
        public func Next() int32 {
            Count += 1
            return Count
        }
    }
}
data struct Pair(A int32, B int32) {
    private let Marker int32 = A * 10 + B
    public func Read() int32 -> Marker
}
Pair{B: Counter.Next(), A: Counter.Next()}.Read()`)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(21, result.Value)
    }

    @Fact
    func PositionalDataProjection_RunsInitializerWithProjectedArgument() {
        let result = EmittedOracle.Evaluate(`struct Source { public var Value int32 }
data struct Box[T](Value T) {
    private let Storage T = Value
    public func Read() T { return Storage }
}
let source = Source{Value: 7}
let box Box[int32] = source
box.Read()`)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func NativeCopy_ClonesBeforeAwaitedUpdates() {
        let result = EmittedOracle.Evaluate(`import System.Threading.Tasks
open data class Item {
    public var Value int32 = 1
    public var Extra int32
}
async func Mutate(item Item) int32 {
    item.Value = 9
    return await Task.FromResult(2)
}
async func Run() int32 {
    let original = Item{}
    let copy = original with { Extra = await Mutate(original) }
    return copy.Value * 10 + copy.Extra
}
Run().GetAwaiter().GetResult()`)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(12, result.Value)
    }

    @Theory
    @InlineData("data struct")
    @InlineData("data class")
    @InlineData("open data class")
    func NativeCopy_PreservesInitializedGetOnlyAndPrivateState(kind string) {
        let result = EmittedOracle.Evaluate(`class Counter {
    shared {
        public var Count int32
        public func Next() int32 {
            Count += 1
            return Count
        }
    }
}
KIND Item[T](Value T) {
    private let Storage T = Value
    public prop Saved T -> Storage
    private let Marker int32 = Counter.Next()
    public var Extra int32
    public func ReadMarker() int32 { return Marker }
}
func Get(item Item[int32]) Item[int32] {
    Counter.Count += 100
    return item
}
let original = Item[int32](7)
let copy = Get(original) with { Extra = 2 }
Counter.Count * 1000 + copy.ReadMarker() * 100 + copy.Saved * 10 + copy.Extra`.Replace(
                "KIND",
                kind,
                StringComparison.Ordinal
            ))
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(101172, result.Value)
    }

    @Fact
    func MissingPrimaryConstructorStorage_FailsFast() {
        let compilation = Compilation(SyntaxTree.Parse("data struct Item(Value int32)"))
        Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
        let type = Assert.Single(compilation.GlobalScope.Structs)
        type.SetProperties(ImmutableArray[PropertySymbol].Empty)
        let exception = Assert.Throws[InvalidOperationException](
            func () object? {
                return ReflectionMetadataEmitter.TryGetPrimaryCtorTargetField(type, "Value", out _)
            }
        )
        Assert.Contains("Value", exception.Message, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("data struct")
    @InlineData("data class")
    @InlineData("open data class")
    func ComputedPositionalProperty_DoesNotRequireAStore(kind string) {
        let result = EmittedOracle.Evaluate(`KIND Item(Value int32) {
    private let Storage int32 = Value + 1
    public prop Value int32 -> Storage
}
Item(41).Value`.Replace("KIND", kind, StringComparison.Ordinal))
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func PlannedPrimaryConstructor_StoresParametersBeforeInitializers() {
        let result = EmittedOracle.Evaluate(`data struct Item[T](Value T) {
    private let Storage T = Value
    private let Reference readonly managed[T] = readonly managed(Value)
    public func Read() T { return *Reference }
    public func ReadStorage() T { return Storage }
}
let item = Item[int32](41)
item.Value + item.Read() + item.ReadStorage()`, []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location})
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(123, result.Value)
    }

    @Fact
    func EmptyPrimaryConstructor_ResetsExistingStructStorage() {
        let result = EmittedOracle.Evaluate(`data struct Item() {
    public var Count int32
}
Item{Count: 42}`)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.NotNull(result.Value)
        let item object? = result.Value
        let itemType = item!!.GetType()
        let constructor = Assert.Single(itemType.GetConstructors())
        let invokeConstructor = DynamicMethod(
            "EmptyPrimaryConstructor_ResetsExistingStructStorage",
            typeof(Void),
            []Type{typeof(object)}
        )
        let il = invokeConstructor.GetILGenerator()
        il.Emit(OpCodes.Ldarg_0)
        il.Emit(OpCodes.Unbox, itemType)
        il.Emit(OpCodes.Call, constructor)
        il.Emit(OpCodes.Ret)
        invokeConstructor.Invoke(nil, []object{item})
        Assert.Equal(0, itemType.GetField("Count")!!.GetValue(item))
    }

    @Fact
    func DuplicatePositionalProperty_RetainsDuplicateDiagnostic() {
        let compilation = Compilation(SyntaxTree.Parse(`data struct Item(Value int32) {
    public prop Value int32 { get; }
    public prop Value int32 { get; }
}`))
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        let duplicate = Assert.Single(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0102")
        Assert.Equal(3, duplicate.Location.StartLine + 1)
    }

    @Fact
    func EquatableOfDifferentGenericInstantiation_StillRequiresImplementation() {
        let compilation = Compilation(SyntaxTree.Parse("data struct Item[T](Value T) : IEquatable[Item[int32]]"))
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        let missing = Assert.Single(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0187")
        Assert.Equal(0, missing.Location.StartLine)
    }

    @Theory
    @InlineData("", false)
    @InlineData("T", false)
    @InlineData("int32", true)
    func NestedRecordEquatableContract_PreservesEnclosingTypeArguments(argument string, requiresImplementation bool) {
        let compilation = Compilation(SyntaxTree.Parse(`open class Outer[T] {
    public data class Item(Value int32) : IEquatable[SELF]
}`.Replace(
                    "SELF",
                    if argument.Length == 0 {
                        "Item"
                    } else {
                        "Outer[$argument].Item"
                    },
                    StringComparison.Ordinal
                )))
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        if requiresImplementation {
            let missing = Assert.Single(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0187")
            Assert.Equal(1, missing.Location.StartLine)
        } else {
            Assert.Empty(diagnostics)
        }
    }

    @Theory
    @InlineData("data struct")
    @InlineData("data class")
    @InlineData("open data class")
    func PositionalPropertyWithDifferentType_IsRejected(kind string) {
        let compilation = Compilation(SyntaxTree.Parse(`KIND Item(Value int32) {
    public prop Value string { get; }
}`.Replace("KIND", kind, StringComparison.Ordinal)))
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        let mismatch = Assert.Single(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0155")
        Assert.Equal(1, mismatch.Location.StartLine)
    }

    @Fact
    func ClosedHierarchyCopyConstructor_AllowsDerivedCloning() {
        let result = EmittedOracle.Evaluate(`sealed data class Base {
    public var Value int32 = 41
}
data class Derived : Base {
    public var Extra int32 = 1
}
let original = Derived{}
let copy = original with { Extra = 2 }
copy`)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.NotNull(result.Value)
        let derivedType = result.Value!!.GetType()
        let baseType Type? = derivedType.BaseType
        Assert.NotNull(baseType)
        Assert.False(baseType!!.IsSealed)
        let baseCopy = Assert.Single(
            baseType!!.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic),
            (constructor ConstructorInfo) -> constructor.GetParameters() is [{ParameterType: var parameterType}] &&
                parameterType == baseType
        )
        Assert.True(baseCopy.IsFamily)
        let clone object? = derivedType.GetMethod("<Clone>$$")!!.Invoke(result.Value, nil)
        Assert.Equal(41, derivedType.GetField("Value")!!.GetValue(clone))
        Assert.Equal(2, derivedType.GetField("Extra")!!.GetValue(clone))
    }

    @Fact
    func GetOnlyPositionalProperty_ReceivesConstructorArgument() {
        let result = EmittedOracle.Evaluate(`data struct Item(Value int32) {
    public prop Value int32 { get; }
}
Item(42).Value`)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func GetOnlyVariadicPositionalProperty_ReceivesPackedArguments() {
        let result = EmittedOracle.Evaluate(`data struct Item(Values ...int32) {
    public prop Values []int32 { get; }
}
let item = Item(20, 22)
item.Values[0] + item.Values[1]`)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ComputedPositionalArgument_IsEvaluated(variadic bool) {
        let result = EmittedOracle.Evaluate(`DECLARATION
class Counter {
    public var Count int32
    public func Next() int32 {
        Count = Count + 1
        return Count
    }
}
let counter = Counter{}
let item = Item(ARGUMENTS)
counter.Count`.Replace(
                "DECLARATION",
                if variadic {
                    "data struct Item(Values ...int32) { public prop Values []int32 -> []int32{42} }"
                } else {
                    "data struct Item(Value int32) { public prop Value int32 -> 42 }"
                },
                StringComparison.Ordinal
            )
                .Replace(
                "ARGUMENTS",
                if variadic {
                    "counter.Next(), counter.Next()"
                } else {
                    "counter.Next()"
                },
                StringComparison.Ordinal
            ))
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(
            if variadic {
                2
            } else {
                1
            },
            result.Value
        )
    }

    @Fact
    func EarlierInitializer_CallsLaterDataPrimaryConstructor() {
        let result = EmittedOracle.Evaluate(`class Holder {
    public var Current Item = Item(41)
}
data struct Item(Value int32) {
    private let Storage int32 = Value + 1
    public func Read() int32 -> Storage
}
Holder{}.Current.Read()`)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func OrdinaryPositionalStruct_RetainsPrivateInitializers() {
        let result = EmittedOracle.Evaluate(`struct Box(Value int32) {
    private var Marker int32 = 11
    public func ReadMarker() int32 -> Marker
}
Box(7).ReadMarker()`)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(11, result.Value)
    }

    @Theory
    @InlineData("data struct", "11")
    @InlineData("data struct", "Value + 4")
    @InlineData("data class", "Value + 4")
    func PositionalDataLiteral_RunsInitializersInParameterScope(kind string, initializer string) {
        let result = EmittedOracle.Evaluate(`KIND Box(Value int32) {
    private var Marker int32 = INITIALIZER
    public func ReadMarker() int32 -> Marker
}
Box{Value: 7}.ReadMarker()`.Replace("INITIALIZER", initializer, StringComparison.Ordinal)
                .Replace("KIND", kind, StringComparison.Ordinal))
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(11, result.Value)
    }

    @Theory
    @InlineData("data struct")
    @InlineData("data class")
    func GenericComputedPositionalProperty_RetainsDeconstruction(kind string) {
        let result = EmittedOracle.Evaluate(`KIND Item[T](Value T) {
    private let Storage T = Value
    public prop Value T -> Storage
}
Item[int32](41)`.Replace("KIND", kind, StringComparison.Ordinal))
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.NotNull(result.Value)
        let deconstruct MethodInfo? = result.Value!!.GetType().GetMethod("Deconstruct")
        Assert.NotNull(deconstruct)
        let arguments[]object = []object? {nil}
        deconstruct!!.Invoke(result.Value, arguments)
        Assert.Equal(41, arguments[0])
    }

    @Theory
    @InlineData("get;", int32(41))
    @InlineData("-> Storage", int32(42))
    func ReplacementPositionalProperty_RetainsDeconstruction(getter string, expected int32) {
        let property = if getter == "get;" {
            "{ get; }"
        } else {
            getter
        }
        let result = EmittedOracle.Evaluate(`data struct Item(Value int32) {
    private var Storage int32 = Value + 1
    public prop Value int32 GETTER
}
Item(41)`.Replace("GETTER", property, StringComparison.Ordinal))
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.NotNull(result.Value)
        let deconstruct MethodInfo? = result.Value!!.GetType().GetMethod("Deconstruct")
        Assert.NotNull(deconstruct)
        let parameter = Assert.Single(deconstruct!!.GetParameters())
        Assert.True(parameter.IsOut)
        Assert.Equal(typeof(int32).MakeByRefType(), parameter.ParameterType)
        let arguments[]object = []object? {nil}
        deconstruct!!.Invoke(result.Value, arguments)
        Assert.Equal(expected, arguments[0])
    }
}
