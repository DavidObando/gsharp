// <copyright file="Issue4675RecordLiteralDefaultsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import GSharp.Tests
import Xunit
import GSharp.Compiler.Tests

class Issue4675RecordLiteralDefaultsEmitTests {
    @Fact
    func EmptyPrimaryList_SeparatesExplicitConstructionFromBareZeroInitialization() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package EmptyPrimaryDefaults
import System
class Counter {
    shared {
        public var Count int32
        public func Next() int32 {
            Count += 1
            return Count
        }
    }
}
data struct Box() {
    private var Items []int32
    public var Marker int32 = Counter.Next()
    public prop Length int32 { get { return Items.Length } }
}
func Main() {
    let explicit = Box{}
    Console.WriteLine(explicit.Marker)
    Console.WriteLine(explicit.Length)
    Console.WriteLine(Counter.Count)
    var bare Box
    Console.WriteLine(bare.Marker)
    Console.WriteLine(bare.Length)
    Console.WriteLine(Counter.Count)
}`, "EmptyPrimaryDefaults", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`1
0
1
0
0
1
`, fixture.Run(dll))
        let assembly = EmittedFixture.Load(dll)
        let box Type? = assembly.GetType("EmptyPrimaryDefaults.Box", throwOnError: true)
        Assert.Single(box!!.GetConstructors())
        let boxHelper = Assert.Single(box!!.GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic))
        Assert.True(boxHelper.IsAssembly)
        Assert.Equal(typeof(bool), Assert.Single(boxHelper.GetParameters()).ParameterType)
    }

    @Fact
    func ComputedPositionalProperty_UsesPreparedPrimaryArgument() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ComputedPrimaryDefaults
import System
data struct Item(Value int32) {
    private let Storage int32 = Value + 1
    public prop Value int32 -> Storage
}
func Main() {
    Console.WriteLine(Item{}.Value)
    Console.WriteLine(Item(8).Value)
}`, "ComputedPrimaryDefaults", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`1
9
`, fixture.Run(dll))
        let type Type? = EmittedFixture.Load(dll).GetType("ComputedPrimaryDefaults.Item", throwOnError: true)
        let constructor = Assert.Single(
            type!!.GetConstructors(),
            (constructor ConstructorInfo) -> constructor.GetParameters().Length == 1
        )
        Assert.Equal("Value", Assert.Single(constructor.GetParameters()).Name)
        Assert.Empty(type!!.GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic))
        let consumer = fixture.CompileCSharp(`using ComputedPrimaryDefaults;
public static class NamedConsumer
{
    public static int Run() => new Item(Value: 8).Value;
}`, "ComputedPrimaryDefaultsConsumer", dll)
        IlVerifier.Verify(consumer, additionalReferences: []string{dll})
        let loaded = EmittedFixture.LoadTogether(dll, consumer)
        Assert.Equal(9, loaded[1].GetType("NamedConsumer", throwOnError: true)!!.GetMethod("Run")!!.Invoke(nil, nil))
    }

    @Fact
    func ComputedPositionalProperty_AuthoredConstructorUsesPropertyForInitializers() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ComputedPrimaryAuthored
import System
data class Item(Value int32) {
    private let Saved int32 = Value + 1
    public prop Value int32 -> 41
    init(flag bool) { }
    public func Read() int32 -> Saved
}
func Main() {
    let item = Item(false)
    Console.WriteLine(item.Value)
    Console.WriteLine(item.Read())
}`, "ComputedPrimaryAuthored", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`41
42
`, fixture.Run(dll))
    }

    @Fact
    func EmptyDataClassPrimaryLiterals_ResolveTheDefaultConstructor() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package EmptyClassPrimary
import System
data class Empty()
data class Generic[T]()
func Main() {
    Console.WriteLine(Empty{} != nil)
    Console.WriteLine(Generic[int32]{} != nil)
}`, "EmptyClassPrimary", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`True
True
`, fixture.Run(dll))
    }

    @Theory
    @InlineData("data struct", "int64", "box.Value", "int64(9)")
    @InlineData("data class", "int64", "box.Value", "int64(9)")
    @InlineData("data struct", "Payload", "box.Value.Number", "Payload{Number: int64(9)}")
    @InlineData("data class", "Payload", "box.Value.Number", "Payload{Number: int64(9)}")
    @InlineData("data struct", "ImportedPayload", "box.Value.Number", "ImportedPayload{Number: int64(9)}")
    @InlineData("data class", "ImportedPayload", "box.Value.Number", "ImportedPayload{Number: int64(9)}")
    func OmittedArgument_IsPlanned_ExplicitCopyAndZeroControlsStayCorrect(
        kind string,
        parameterType string,
        read string,
        supplied string
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contracts = if parameterType == "ImportedPayload" {
            []string{
                fixture.CompileCSharp(
                    "namespace DefaultContracts { public struct ImportedPayload { public long Number; } }",
                    "ImportedDefaultContract"
                )
            }
        } else {
            Array.Empty[string]()
        }
        let source = `package LiteralDefaults
import System
IMPORT
class Counter {
    shared {
        public var Count int32
        public func Next() int32 {
            Count += 1
            return Count
        }
    }
}
struct Payload { public var Number int64 }
KIND Box(Value PARAMETER) {
    public var Marker int32 = Counter.Next()
    public var Items []int32
}
func Main() {
    let box = Box{}
    Console.WriteLine(READ)
    Console.WriteLine(box.Marker)
    Console.WriteLine(Counter.Count)
    let constructed = Box{Value: SUPPLIED}
    Console.WriteLine(EXPLICIT_READ)
    Console.WriteLine(constructed.Marker)
    Console.WriteLine(Counter.Count)
    let copied = constructed with {}
    Console.WriteLine(COPY_READ)
    Console.WriteLine(copied.Marker)
    Console.WriteLine(Counter.Count)
    BARE
}`.Replace(
            "KIND",
            kind,
            StringComparison.Ordinal
        ).Replace(
            "IMPORT",
            if parameterType == "ImportedPayload" {
                "import DefaultContracts"
            } else {
                string.Empty
            },
            StringComparison.Ordinal
        ).Replace(
            "PARAMETER",
            parameterType,
            StringComparison.Ordinal
        ).Replace(
            "EXPLICIT_READ",
            read.Replace("box.", "constructed.", StringComparison.Ordinal),
            StringComparison.Ordinal
        ).Replace(
            "COPY_READ",
            read.Replace("box.", "copied.", StringComparison.Ordinal),
            StringComparison.Ordinal
        ).Replace(
            "READ",
            read,
            StringComparison.Ordinal
        ).Replace(
            "SUPPLIED",
            supplied,
            StringComparison.Ordinal
        ).Replace(
            "BARE",
            if kind == "data struct" {
                `var bare Box
Console.WriteLine(bare.Marker)
Console.WriteLine(bare.Items.Length)
Console.WriteLine(Counter.Count)`
            } else {
                string.Empty
            },
            StringComparison.Ordinal
        )
        let dll = fixture.Compile(
            source,
            "LiteralDefaults",
            true,
            Array.ConvertAll(contracts, (path string) -> ("/r:" + path))
        )
        IlVerifier.Verify(dll, additionalReferences: contracts)
        Assert.Equal(`0
1
1
9
2
2
9
2
2
` + (
                if kind == "data struct" {
                    `0
0
2
`
                } else {
                    string.Empty
                }
            ), fixture.Run(dll))
    }

    @Theory
    @InlineData("data struct")
    @InlineData("data class")
    func OpenGenericDefaults_ArePlannedForEveryInstantiation(kind string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package GenericLiteralDefaults
import System
struct Payload { public var Number int64 }
KIND Box[T](Value T)
func make[T](useDefault bool, supplied T) Box[T] {
    if useDefault { return Box[T]{} }
    return Box[T]{Value: supplied}
}
func Main() {
    Console.WriteLine(make[int64](true, int64(9)).Value)
    Console.WriteLine(make[int64](false, int64(9)).Value)
    Console.WriteLine(make[Payload](true, Payload{Number: int64(8)}).Value.Number)
    Console.WriteLine(make[Payload](false, Payload{Number: int64(8)}).Value.Number)
}`.Replace("KIND", kind, StringComparison.Ordinal), "GenericLiteralDefaults", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`0
9
0
8
`, fixture.Run(dll))
    }

    @Theory
    @InlineData("data struct")
    @InlineData("data class")
    func AsyncAndIteratorDefaults_StayInTheRewrittenPlannedBody(kind string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package LoweredLiteralDefaults
import System
import System.Threading.Tasks
KIND Box(Value int64, Other int32)
async func make() Box { return Box{Other: await Task.FromResult(7)} }
func stream() sequence[Box] { yield Box{Other: 9} }
func Main() {
    let box = make().GetAwaiter().GetResult()
    Console.WriteLine(box.Value)
    Console.WriteLine(box.Other)
    for item in stream() {
        Console.WriteLine(item.Value)
        Console.WriteLine(item.Other)
    }
}`.Replace("KIND", kind, StringComparison.Ordinal), "LoweredLiteralDefaults", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`0
7
0
9
`, fixture.Run(dll))
    }

    @Theory
    @InlineData("data struct")
    @InlineData("data class")
    func ExpressionTrees_ConsumeThePreparedDefaultAndExplicitArguments(kind string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package TreeLiteralDefaults
import System
import System.Linq.Expressions
KIND Box(Value int64, Other int32)
func Main() {
    let tree Expression[Func[Box]] = () -> Box{Other: 7}
    let box = tree.Compile()()
    Console.WriteLine(box.Value)
    Console.WriteLine(box.Other)
}`.Replace("KIND", kind, StringComparison.Ordinal), "TreeLiteralDefaults", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`0
7
`, fixture.Run(dll))
    }

    @Fact
    func ExpressionTree_NestedPositionalDefault_UsesTheZeroHelper() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package TreeNestedZeroDefaults
import System
import System.Linq.Expressions
data struct Inner(Value int32) {
    public var Items []int32
    public prop Length int32 { get { return Items.Length } }
}
data class Box(Item Inner)
func Main() {
    let tree Expression[Func[Box]] = () -> Box{}
    let box = tree.Compile()()
    Console.WriteLine(box.Item.Value)
    Console.WriteLine(box.Item.Length)
}`, "TreeNestedZeroDefaults", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`0
0
`, fixture.Run(dll))
    }

    @Fact
    func ExpressionTree_ClosedGenericZero_AssignsRetainedStorageWithoutConstructorLookup() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package TreeClosedGenericZero
import System
import System.Linq.Expressions
struct Payload {
    private var Items []int32
    public prop Length int32 { get { return Items.Length } }
}
data struct Inner[T](Value int32) { public var Child T }
data class Box(Item Inner[Payload])
func Main() {
    let tree Expression[Func[Box]] = () -> Box{}
    let box = tree.Compile()()
    Console.WriteLine(box.Item.Value)
    Console.WriteLine(box.Item.Child.Length)
}`, "TreeClosedGenericZero", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`0
0
`, fixture.Run(dll))
    }

    @Fact
    func ExpressionTree_ZeroHelper_DoesNotReassignFieldsWrittenByTheHelper() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package TreeZeroHelperStores
import System
import System.Linq.Expressions
class Counter {
    shared {
        public var Count int32
        public func Next() int32 {
            Count += 1
            return Count
        }
    }
}
struct Inner {
    private var Items []int32
    private var Marker int32 = Counter.Next()
    public func Mark() int32 -> Marker
}
data struct Outer(Value int32) {
    public var Child Inner
}
data class Box(Item Outer)
func Main() {
    let tree Expression[Func[Box]] = () -> Box{}
    let box = tree.Compile()()
    Console.WriteLine(box.Item.Child.Mark())
    Console.WriteLine(Counter.Count)
}`, "TreeZeroHelperStores", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`1
1
`, fixture.Run(dll))
    }

    @Fact
    func ExpressionTree_EmptyPrimaryZero_DoesNotInvokePrimaryConstructor() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package TreeEmptyPrimaryZero
import System
import System.Linq.Expressions
class Counter {
    shared {
        public var Count int32
        public func Next() int32 {
            Count += 1
            return Count
        }
    }
}
data struct Inner() {
    public var Items []int32
    public var Marker int32 = Counter.Next()
}
data class Box(Item Inner)
func Main() {
    let direct = Box{}
    let tree Expression[Func[Box]] = () -> Box{}
    let compiled = tree.Compile()()
    Console.WriteLine(direct.Item.Marker)
    Console.WriteLine(compiled.Item.Marker)
    Console.WriteLine(Counter.Count)
    Console.WriteLine(direct.Item.Items.Length)
    Console.WriteLine(compiled.Item.Items.Length)
}`, "TreeEmptyPrimaryZero", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`0
0
0
0
0
`, fixture.Run(dll))
    }

    @Fact
    func ExpressionTree_NonPositionalDataStructZero_UsesOwningConstructor() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package TreeNonPositionalDataZero
import System
import System.Linq.Expressions
data struct Inner {
    private var Items []int32
    public prop Length int32 -> Items.Length
}
data class Box(Item Inner)
func Main() {
    let tree Expression[Func[Box]] = () -> Box{}
    Console.WriteLine(tree.Compile()().Item.Length)
}`, "TreeNonPositionalDataZero", true)
        IlVerifier.Verify(dll)
        Assert.Equal("0\n", fixture.Run(dll))
    }

    @Fact
    func EmptyPrimarySpread_EvaluatesDeclarationInitializersOnce() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package EmptyPrimarySpread
import System
class Counter {
    shared {
        public var Count int32
        public func Next() int32 {
            Count += 1
            return Count
        }
    }
}
data struct Source(Value int32)
data struct Target() {
    public var Value int32
    public var Marker int32 = Counter.Next()
}
func Main() {
    let target = Target{...Source{Value: 7}}
    Console.WriteLine(target.Value)
    Console.WriteLine(target.Marker)
    Console.WriteLine(Counter.Count)
}`, "EmptyPrimarySpread", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`7
1
1
`, fixture.Run(dll))
    }

    @Fact
    func ExpressionTree_OrdinaryStructZero_RetainsZeroStoreAfterInitializerConstructor() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package TreeOrdinaryZeroStore
import System
import System.Linq.Expressions
struct Inner[T] {
    public var Items []int32 = []int32{9}
    public init() { }
}
data class Box(Item Inner[int32])
func Main() {
    let direct = Box{}
    let tree Expression[Func[Box]] = () -> Box{}
    let compiled = tree.Compile()()
    Console.WriteLine(direct.Item.Items.Length)
    Console.WriteLine(compiled.Item.Items.Length)
}`, "TreeOrdinaryZeroStore", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`0
0
`, fixture.Run(dll))
    }

    @Fact
    func ImportedRecordLiteral_KeepsItsExistingBoundDefaultPath() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(
            "namespace DefaultContracts { public readonly record struct ImportedBox(long Value); }",
            "ImportedRecordDefaultContract"
        )
        let dll = fixture.Compile(`import System
import DefaultContracts
func Main() {
    Console.WriteLine(ImportedBox{}.Value)
    Console.WriteLine(ImportedBox{Value: int64(7)}.Value)
}`, "ImportedRecordDefaults", true, "/r:" + contract)
        IlVerifier.Verify(dll, additionalReferences: []string{contract})
        Assert.Equal(`0
7
`, fixture.Run(dll))
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func ImportedGenericDataClassLiteral_PreservesArgumentsAndEvaluatesOnce(csharp bool, referenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = System.IO.Path.Combine(fixture.Directory, "ImportedLiteral5419.ref.dll")
        let contract = if csharp {
            fixture.CompileCSharpWithReference(`namespace ImportedLiteral5419;
public static class Counter {
    public static int Count;
    public static int Next() => ++Count;
}
public record Box<T>(T Value) {
    public int Stamp { get; } = Counter.Next();
}
public record Empty<T> {
    public T Echo(T value) => value;
}`, "ImportedLiteral5419", reference)
        } else {
            fixture.Compile(`package ImportedLiteral5419
public class Counter {
    shared {
        public var Count int32
        public func Next() int32 {
            Count += 1
            return Count
        }
    }
}
public data class Box[T](Value T) {
    public let Stamp int32 = Counter.Next()
}
public data class Empty[T] {
    public func Echo(value T) T -> value
}`, "ImportedLiteral5419", false, "/refout:" + reference)
        }
        IlVerifier.Verify(contract)
        let dll = fixture.Compile(`import System
import ImportedLiteral5419
func Input() string? {
    Console.WriteLine("input")
    return nil
}
func Main() {
    let value Box[string?] = Box[string?]{Value: Input()}
    Console.WriteLine(value.Value == nil)
    Console.WriteLine(value.Stamp)
    let call Box[string?] = Box[string?](nil)
    Console.WriteLine(call.Value == nil)
    Console.WriteLine(call.Stamp)
    let number = Box[int32]{Value: 7}
    Console.WriteLine(number.Value)
    Console.WriteLine(number.Stamp)
    Console.WriteLine(Counter.Count)
    let empty Empty[int32] = Empty[int32]{}
    Console.WriteLine(empty.Echo(9))
    let nullableEmpty Empty[string?] = Empty[string?]{}
    Console.WriteLine(nullableEmpty.Echo(nil) == nil)
}`, "GenericLiteral", true, "/r:" +
                if referenceAssembly {
                reference
            } else {
                contract
            })
        IlVerifier.Verify(dll, additionalReferences: []string{contract})
        Assert.Equal("input\nTrue\n1\nTrue\n2\n7\n3\n3\n9\nTrue\n", fixture.Run(dll))
    }

    @Theory
    @InlineData(
        "let value = Box[string?]{Value: nil}\nlet narrowed string = value.Value",
        "Rejected.gs(3,23,3,34): error GS0155"
    )
    @InlineData("let value = Box[string]{Value: nil}", "Rejected.gs(2,32,2,35): error GS0155")
    @InlineData("let value = Box[string?]{Missing: nil}", "Rejected.gs(2,26,2,33): error GS0158")
    @InlineData("let value = Box[string?]{Value: nil, Value: nil}", "Rejected.gs(2,38,2,43): error GS0102")
    func ImportedGenericDataClassLiteral_ReportsLocatedTypeErrors(statement string, diagnostic string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.Compile(
            "package ImportedLiteral5419\npublic data class Box[T](Value T)",
            "ImportedLiteral5419",
            false
        )
        let (code, output) = fixture.TryCompile(
            "import ImportedLiteral5419\n" + statement,
            "Rejected",
            true,
            "/r:" + contract
        )
        Assert.Equal(1, code)
        Assert.True(output.Contains(diagnostic, StringComparison.Ordinal), output)
        Assert.False(System.IO.File.Exists(System.IO.Path.Combine(fixture.Directory, "Rejected.dll")))
    }

    @Fact
    func ImportedGenericDataClassLiteral_PrimaryInputsKeepSourceOrderBeforeMemberWrites() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`namespace ImportedLiteral5419;
public record Pair<T>(T First, T Second) {
    public T? Extra { get; set; }
    public int Stamp { get; } = Trace.Construct();
}
public static class Trace {
    public static int Construct() {
        System.Console.WriteLine("constructor");
        return 1;
    }
}`, "Contract")
        IlVerifier.Verify(contract)
        let dll = fixture.Compile(`import System
import ImportedLiteral5419
func Input(label string) string? {
    Console.WriteLine(label)
    return nil
}
let pair Pair[string?] = Pair[string?]{
    Extra: Input("extra"),
    Second: Input("second"),
    First: Input("first")
}
Console.WriteLine(pair.First == nil && pair.Second == nil && pair.Extra == nil)
Console.WriteLine(pair.Stamp)
`, "PrimaryOrder", true, "/r:" + contract)
        IlVerifier.Verify(dll, additionalReferences: []string{contract})
        Assert.Equal("second\nfirst\nconstructor\nextra\nTrue\n1\n", fixture.Run(dll))
    }

    @Fact
    func ImportedGenericDataClassLiteral_SelectsPrimarySignatureBeforeClosing() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`namespace ImportedLiteral5419;
public record Collision<T> {
    public Collision(string Value) => throw new System.InvalidOperationException("not primary");
    public Collision(T Value) { this.Value = Value; }
    public T Value { get; init; }
}
public record DistinctSlots<T, U> {
    public DistinctSlots(U Value) => throw new System.InvalidOperationException("wrong slot");
    public DistinctSlots(T Value) { this.Value = Value; }
    public T Value { get; init; }
}`, "Contract")
        IlVerifier.Verify(contract)
        let dll = fixture.Compile(`import ImportedLiteral5419
let value = Collision[string?]{Value: nil}
System.Console.WriteLine(value.Value == nil)
let distinct = DistinctSlots[string?, string]{Value: nil}
System.Console.WriteLine(distinct.Value == nil)
`, "ConstructorIdentity", true, "/r:" + contract)
        IlVerifier.Verify(dll, additionalReferences: []string{contract})
        Assert.Equal("True\nTrue\n", fixture.Run(dll))
    }

    @Fact
    func ImportedGenericDataClassLiteral_RejectsAbstractClass() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.Compile(
            "package ImportedLiteral5419\npublic abstract data class Box[T](Value T)",
            "ImportedLiteral5419",
            false
        )
        let (code, output) = fixture.TryCompile(
            "import ImportedLiteral5419\nlet value = Box[string?]{Value: nil}",
            "Abstract",
            true,
            "/r:" + contract
        )
        Assert.Equal(1, code)
        Assert.True(output.Contains("Abstract.gs(2,13,2,16): error GS0386", StringComparison.Ordinal), output)
        Assert.False(System.IO.File.Exists(System.IO.Path.Combine(fixture.Directory, "Abstract.dll")))
    }

    @Fact
    func ImportedGenericDataClassLiteral_ForeignRecordWithoutPrimarySignatureUsesDefaultConstructor() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`#nullable enable
namespace ImportedLiteral5419;
public record Box<T> {
    public Box() { System.Console.WriteLine("default"); }
    public Box(string Value) => throw new System.InvalidOperationException("not primary");
    public T Value { get; init; } = default!;
}`, "Contract")
        IlVerifier.Verify(contract)
        let dll = fixture.Compile(`import ImportedLiteral5419
let value = Box[int32]{Value: 7}
System.Console.WriteLine(value.Value)
let call = Box[int32]()
System.Console.WriteLine(call.Value)
`, "ForeignDefault", true, "/r:" + contract)
        IlVerifier.Verify(dll, additionalReferences: []string{contract})
        Assert.Equal("default\n7\ndefault\n0\n", fixture.Run(dll))
    }

    @Fact
    func ImportedGenericDataClassLiteral_UnknownCollectionOmissionsAreDiagnosedAndExplicitInputsWork() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.Compile(`package CollectionLiteral5419
public data class SliceBox[T](Items []int32)
public data class FixedBox[T](Items [3]int32)
public data class GenericSliceBox[T](Items []T)
public data class GenericFixedBox[T](Items [3]T)
public data class ArgumentBox[T](Items T)
`, "CollectionLiteral5419", false)
        IlVerifier.Verify(contract)
        let dll = fixture.Compile(`import CollectionLiteral5419
let sliceValue = SliceBox[int32]{Items: []int32{}}
System.Console.WriteLine(sliceValue.Items.Length)
let fixedValue = FixedBox[int32]{Items: [3]int32{}}
System.Console.WriteLine(fixedValue.Items.Length)
System.Console.WriteLine(fixedValue.Items[2])
let genericSlice = GenericSliceBox[int32]{Items: []int32{}}
System.Console.WriteLine(genericSlice.Items.Length)
let genericFixed = GenericFixedBox[int32]{Items: [3]int32{}}
System.Console.WriteLine(genericFixed.Items.Length)
System.Console.WriteLine(genericFixed.Items[2])
let argumentSlice = ArgumentBox[[]int32]{}
System.Console.WriteLine(argumentSlice.Items.Length)
let argumentFixed = ArgumentBox[[3]int32]{}
System.Console.WriteLine(argumentFixed.Items.Length)
System.Console.WriteLine(argumentFixed.Items[2])
`, "CollectionOmission", true, "/r:" + contract)
        IlVerifier.Verify(dll, additionalReferences: []string{contract})
        Assert.Equal("0\n3\n0\n0\n3\n0\n0\n3\n0\n", fixture.Run(dll))
        for name in[]string{"SliceBox", "FixedBox", "GenericSliceBox", "GenericFixedBox"} {
            let (code, output) = fixture.TryCompile(
                "import CollectionLiteral5419\nlet value = " + name + "[int32]{}",
                "MissingShape",
                true,
                "/r:" + contract
            )
            Assert.Equal(1, code)
            Assert.True(
                output.Contains(
                    "MissingShape.gs(2,13,2," + (13 + name.Length).ToString() + "): error GS0267",
                    StringComparison.Ordinal
                ),
                output
            )
            Assert.False(System.IO.File.Exists(System.IO.Path.Combine(fixture.Directory, "MissingShape.dll")))
        }
    }

    @Fact
    func ImportedGenericDataClassLiteral_UnknownNonnullableArrayOmissionIsDiagnosed() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`#nullable enable
namespace ImportedLiteral5419;
public record Box<T>(int[] Items);
public record NullableBox<T>(int[]? Items);`, "Contract")
        IlVerifier.Verify(contract)
        let dll = fixture.Compile(`import ImportedLiteral5419
let value = NullableBox[int32]{}
System.Console.WriteLine(value.Items == nil)
let provided = Box[int32]{Items: []int32{7}}
System.Console.WriteLine(provided.Items[0])
`, "NullableArray", true, "/r:" + contract)
        IlVerifier.Verify(dll, additionalReferences: []string{contract})
        Assert.Equal("True\n7\n", fixture.Run(dll))
        let (code, output) = fixture.TryCompile(
            "import ImportedLiteral5419\nlet value = Box[int32]{}",
            "MissingShape",
            true,
            "/r:" + contract
        )
        Assert.Equal(1, code)
        Assert.True(output.Contains("MissingShape.gs(2,13,2,16): error GS0267", StringComparison.Ordinal), output)
        Assert.False(System.IO.File.Exists(System.IO.Path.Combine(fixture.Directory, "MissingShape.dll")))
    }

    @Theory
    @InlineData("GenericSliceBox", false)
    @InlineData("GenericFixedBox", false)
    @InlineData("GenericSliceBox", true)
    @InlineData("GenericFixedBox", true)
    func ImportedGenericDataClassLiteral_SymbolicArrayOmissionIsDiagnosed(name string, inGenericFunction bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.Compile(`package SymbolicCollection5419
public data class GenericSliceBox[T](Items []T)
public data class GenericFixedBox[T](Items [3]T)
public data class NullableBox[T](Items []?T)
public data class ArgumentBox[T](Items T)
`, "SymbolicCollection5419", false)
        IlVerifier.Verify(contract)
        let dll = fixture.Compile(`import SymbolicCollection5419
struct Point { public var Value int32 }
func Shapes[U]() {
    let slice = ArgumentBox[[]U]{}
    System.Console.WriteLine(slice.Items.Length)
    let fixedValue = ArgumentBox[[3]U]{}
    System.Console.WriteLine(fixedValue.Items.Length)
    let explicitSlice = GenericSliceBox[U]{Items: []U{}}
    System.Console.WriteLine(explicitSlice.Items.Length)
    let explicitFixed = GenericFixedBox[U]{Items: [3]U{}}
    System.Console.WriteLine(explicitFixed.Items.Length)
    let nullableValue = NullableBox[U]{}
    System.Console.WriteLine(nullableValue.Items == nil)
}
Shapes[Point]()
let directSlice = ArgumentBox[[]Point]{}
System.Console.WriteLine(directSlice.Items.Length)
let directFixed = ArgumentBox[[3]Point]{}
System.Console.WriteLine(directFixed.Items.Length)
`, "KnownSymbolicShapes", true, "/r:" + contract)
        IlVerifier.Verify(dll, additionalReferences: []string{contract})
        Assert.Equal("0\n3\n0\n3\nTrue\n0\n3\n", fixture.Run(dll))
        let source = "import SymbolicCollection5419\nstruct Point { public var Value int32 }\n" + if inGenericFunction {
            "func Make[U]() {\n    let value = " + name + "[U]{}\n}\n"
        } else {
            "let value = " + name + "[Point]{}\n"
        }
        let referenceDirectory = System.IO.Path.Combine(fixture.Directory, "ref")
        System.IO.Directory.CreateDirectory(referenceDirectory)
        let reference = System.IO.Path.Combine(referenceDirectory, "MissingSymbolicShape.dll")
        let pdb = System.IO.Path.Combine(fixture.Directory, "MissingSymbolicShape.pdb")
        let (code, output) = fixture.TryCompile(
            source,
            "MissingSymbolicShape",
            true,
            "/r:" + contract,
            "/refout:" + reference,
            "/debug:portable",
            "/pdb:" + pdb
        )
        Assert.Equal(1, code)
        let line = if inGenericFunction {
            "4"
        } else {
            "3"
        }
        let column = if inGenericFunction {
            17
        } else {
            13
        }
        Assert.True(
            output.Contains(
                "MissingSymbolicShape.gs(" + line + "," + column.ToString() +
                    "," +
                    line +
                    "," +
                    (column + name.Length).ToString() + "): error GS0267",
                StringComparison.Ordinal
            ),
            output
        )
        Assert.False(System.IO.File.Exists(System.IO.Path.Combine(fixture.Directory, "MissingSymbolicShape.dll")))
        Assert.False(System.IO.File.Exists(reference))
        Assert.False(System.IO.File.Exists(pdb))
    }

    @Fact
    func ImportedGenericDataClassLiteral_SpreadTypeProbePreservesExplicitCollectionInputs() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.Compile(`package SpreadLiteral5419
public data class Box[T](Items []int32, Value T)
`, "SpreadLiteral5419", false)
        IlVerifier.Verify(contract)
        let dll = fixture.Compile(`import SpreadLiteral5419
let source = Box[string?]([]int32{1}, nil)
let value Box[string?] = Box[string?]{...source, Items: []int32{7}}
System.Console.WriteLine(value.Items[0])
System.Console.WriteLine(source.Items[0])
System.Console.WriteLine(value.Value == nil)
`, "SpreadConsumer", true, "/r:" + contract)
        IlVerifier.Verify(dll, additionalReferences: []string{contract})
        Assert.Equal("7\n1\nTrue\n", fixture.Run(dll))
    }

    @Theory
    @InlineData("MapBox", "int32", false)
    @InlineData("SequenceBox", "int32", false)
    @InlineData("MapBox", "Point", false)
    @InlineData("SequenceBox", "Point", false)
    @InlineData("MapBox", "U", true)
    @InlineData("SequenceBox", "U", true)
    func ImportedGenericDataClassLiteral_DeclaredMapOrSequenceOmissionIsDiagnosed(
        name string,
        element string,
        inGenericFunction bool
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.Compile(`package ReferenceCollection5419
public data class MapBox[T](Items map[string,T])
public data class SequenceBox[T](Items sequence[T])
public data class NullableMapBox[T](Items map[string,T]?)
public data class NullableSequenceBox[T](Items (sequence[T])?)
public data class ArgumentBox[T](Items T)
`, "ReferenceCollection5419", false)
        IlVerifier.Verify(contract)
        let dll = fixture.Compile(`import ReferenceCollection5419
struct Point { public var Value int32 }
func Shapes[U](item U) {
    let mapValue = ArgumentBox[map[string,U]]{}
    System.Console.WriteLine(mapValue.Items.Count)
    let sequenceValue = ArgumentBox[sequence[U]]{}
    System.Console.WriteLine(System.Linq.Enumerable.Count[U](sequenceValue.Items))
    let explicitMap = MapBox[U]{Items: map[string,U]{"key": item}}
    System.Console.WriteLine(explicitMap.Items.Count)
    let explicitSequence = SequenceBox[U]{Items: []U{item}}
    System.Console.WriteLine(System.Linq.Enumerable.Count[U](explicitSequence.Items))
    let nullableMap = NullableMapBox[U]{}
    System.Console.WriteLine(nullableMap.Items == nil)
    let nullableSequence = NullableSequenceBox[U]{}
    System.Console.WriteLine(nullableSequence.Items == nil)
}
Shapes[int32](7)
Shapes[Point](Point{Value: 7})
let call = MapBox[int32](map[string,int32]{})
System.Console.WriteLine(call.Items.Count)
`, "KnownReferenceShapes", true, "/r:" + contract)
        IlVerifier.Verify(dll, additionalReferences: []string{contract})
        Assert.Equal("0\n0\n1\n1\nTrue\nTrue\n0\n0\n1\n1\nTrue\nTrue\n0\n", fixture.Run(dll))
        let source = "import ReferenceCollection5419\nstruct Point { public var Value int32 }\n" +
            if inGenericFunction {
            "func Make[U]() {\n    let value = " + name + "[" + element + "]{}\n}\n"
        } else {
            "let value = " + name + "[" + element + "]{}\n"
        }
        let referenceDirectory = System.IO.Path.Combine(fixture.Directory, "ref")
        System.IO.Directory.CreateDirectory(referenceDirectory)
        let reference = System.IO.Path.Combine(referenceDirectory, "MissingReferenceShape.dll")
        let pdb = System.IO.Path.Combine(fixture.Directory, "MissingReferenceShape.pdb")
        let (code, output) = fixture.TryCompile(
            source,
            "MissingReferenceShape",
            true,
            "/r:" + contract,
            "/refout:" + reference,
            "/debug:portable",
            "/pdb:" + pdb
        )
        Assert.Equal(1, code)
        let line = if inGenericFunction {
            4
        } else {
            3
        }
        let column = if inGenericFunction {
            17
        } else {
            13
        }
        Assert.True(
            output.Contains(
                "MissingReferenceShape.gs(" + line.ToString() + "," + column.ToString() + "," + line.ToString() +
                    "," +
                    (column + name.Length).ToString() + "): error GS0267",
                StringComparison.Ordinal
            ),
            output
        )
        Assert.False(System.IO.File.Exists(System.IO.Path.Combine(fixture.Directory, "MissingReferenceShape.dll")))
        Assert.False(System.IO.File.Exists(reference))
        Assert.False(System.IO.File.Exists(pdb))
    }

    @Fact
    func ImportedGenericDataClassLiteral_ExpressionTreePreservesSelectedPropertyIdentity() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`namespace ImportedLiteral5419;
public record Box<T>(T Value) {
    public int Extra { get; set; }
    public int extra { get; set; }
    public int Mark;
    public int mark;
}`, "Contract")
        IlVerifier.Verify(contract)
        let dll = fixture.Compile(`import System
import System.Linq.Expressions
import ImportedLiteral5419
func Deferred[T](value T) Expression[Func[Box[T]]] -> () -> Box[T]{Value: value, Extra: 2, Mark: 4}
let simple Expression[Func[Box[int32]]] = () -> Box[int32]{Value: 7, Extra: 2, Mark: 4}
let value = simple.Compile()()
Console.WriteLine(value.Value)
Console.WriteLine(value.Extra)
Console.WriteLine(value.extra)
Console.WriteLine(value.Mark)
Console.WriteLine(value.mark)
let generic = Deferred[string?](nil).Compile()()
Console.WriteLine(generic.Value == nil)
Console.WriteLine(generic.Extra)
Console.WriteLine(generic.extra)
Console.WriteLine(generic.Mark)
Console.WriteLine(generic.mark)
let lower Expression[Func[Box[int32]]] = () -> Box[int32]{Value: 9, extra: 3, mark: 5}
let lowerValue = lower.Compile()()
Console.WriteLine(lowerValue.Extra)
Console.WriteLine(lowerValue.extra)
Console.WriteLine(lowerValue.Mark)
Console.WriteLine(lowerValue.mark)
`, "PropertyIdentity", true, "/r:" + contract)
        IlVerifier.Verify(dll, additionalReferences: []string{contract})
        Assert.Equal("7\n2\n0\n4\n0\nTrue\n2\n0\n4\n0\n0\n3\n0\n5\n", fixture.Run(dll))
    }

    @Fact
    func ImportedGenericDataClassLiteral_ExpressionTreePreservesSymbolicCollectionAccessorOwner() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.Compile(`package MapTree5419
import System
import System.Collections.Generic
import System.Linq.Expressions
public class Reader {
    shared {
        public func Read[K,V](value map[K,V]) Expression[Func[int32]] -> () -> value.Count
        public func Closed(value map[string,int32]) Expression[Func[int32]] -> () -> value.Count
        public func DictionaryRead[K,V](value Dictionary[K,V]) Expression[Func[int32]] -> () -> value.Count
        public func Ordinary[K,V](value map[K,V]) int32 -> value.Count
    }
}
`, "MapTree5419", false)
        IlVerifier.Verify(contract)
        let dll = fixture.Compile(`import MapTree5419
struct Point { public var Value int32 }
let values = map[string,int32]{"key": 7}
System.Console.WriteLine(Reader.Closed(values).Compile()())
System.Console.WriteLine(Reader.DictionaryRead[string,int32](values).Compile()())
System.Console.WriteLine(Reader.Ordinary[string,int32](values))
let read = Reader.Read[string,int32](values).Compile()
System.Console.WriteLine(read())
values["second"] = 8
System.Console.WriteLine(read())
System.Console.WriteLine(Reader.Read[string,Point](map[string,Point]{"key": Point{Value: 7}}).Compile()())
System.Console.WriteLine(Reader.Read[string,string?](map[string,string?]{"key": nil}).Compile()())
`, "MapTreeConsumer", true, "/r:" + contract)
        IlVerifier.Verify(dll, additionalReferences: []string{contract})
        Assert.Equal("1\n1\n1\n1\n2\n1\n1\n", fixture.Run(dll))
    }

    @Fact
    func ImportedGenericDataClassLiteral_ExpressionTreePreservesConstrainedReceiverOwner() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.Compile(`package ConstrainedTree5419
import System.Collections.Generic
import System.Linq.Expressions
import System
public class Reader {
    shared {
        public func Read[A, R ICollection[A]]() Expression[Func[R, int32]] -> value -> value.Count
    }
}
`, "ConstrainedTree5419", false)
        IlVerifier.Verify(contract)
        let dll = fixture.Compile(`import System
import System.Collections.Generic
import ConstrainedTree5419
let values = List[int32](){4, 7}
let tree = Reader.Read[int32, List[int32]]()
Console.WriteLine(tree.Compile()(values))
values.Add(11)
Console.WriteLine(tree.Compile()(values))
`, "ConstrainedTree", true, "/r:" + contract)
        IlVerifier.Verify(dll, additionalReferences: []string{contract})
        Assert.Equal("2\n3\n", fixture.Run(dll))
    }

    @Theory
    @InlineData("int32", "", "7", "", "7")
    @InlineData("Point", "struct Point { var X int32 }", "Point{X: 9}", ".X", "9")
    @InlineData("Color", "enum Color { Red, Green }", "Color.Green", " == Color.Green", "True")
    func ImportedGenericDataClassLiteral_ExpressionTreePreservesNullableAccessorOwners(
        typeName string,
        declaration string,
        value string,
        member string,
        expected string
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`import System
import System.Linq.Expressions
` + declaration + `
func Has[T struct]() Expression[Func[T?, bool]] -> value -> value.HasValue
func ReadValue[T struct]() Expression[Func[T?, T]] -> value -> value.Value
let has = Has[` + typeName + `]().Compile()
let read = ReadValue[` + typeName + `]().Compile()
Console.WriteLine(has(nil))
Console.WriteLine(has(` + value + `))
Console.WriteLine(read(` + value + `)` + member + `)
let directHas Expression[Func[` + typeName + `?, bool]] = value -> value.HasValue
let directRead Expression[Func[` + typeName + `?, ` + typeName + `]] = value -> value.Value
Console.WriteLine(directHas.Compile()(nil))
Console.WriteLine(directHas.Compile()(` + value + `))
Console.WriteLine(directRead.Compile()(` + value + `)` + member + `)
`, "NullableOwner", true)
        IlVerifier.Verify(dll)
        Assert.Equal("False\nTrue\n" + expected + "\nFalse\nTrue\n" + expected + "\n", fixture.Run(dll))
    }

    @Fact
    func ImportedGenericDataClassLiteral_NestedExpressionTreeRetainsMetadataOnlyTypeArguments() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`namespace ImportedLiteral5419;
public static class Probe<T> {
    public static int Count => typeof(T) == typeof(int) ? 7 : 9;
    public static int Mark = typeof(T) == typeof(int) ? 17 : 19;
}`, "Contract")
        IlVerifier.Verify(contract)
        let dll = fixture.Compile(`import System
import System.Linq.Expressions
import ImportedLiteral5419
func Make[T]() Func[Expression[Func[int32]]] -> () -> () -> Probe[T].Count
func MakeField[T]() Func[Expression[Func[int32]]] -> () -> () -> Probe[T].Mark
Console.WriteLine(Make[int32]()().Compile()())
Console.WriteLine(Make[string]()().Compile()())
Console.WriteLine(MakeField[int32]()().Compile()())
Console.WriteLine(MakeField[string]()().Compile()())
`, "NestedTree", true, "/r:" + contract)
        IlVerifier.Verify(dll, additionalReferences: []string{contract})
        using let stream = System.IO.File.OpenRead(dll)
        using let pe = PEReader(stream)
        let metadata = pe.GetMetadataReader()
        var lambdas = 0
        for handle in metadata.MethodDefinitions {
            let method = metadata.GetMethodDefinition(handle)
            let name = metadata.GetString(method.Name)
            if name.StartsWith("<lambda", StringComparison.Ordinal) {
                lambdas += 1
                let owner = metadata.GetTypeDefinition(method.GetDeclaringType())
                Assert.True(
                    method.GetGenericParameters().Count + owner.GetGenericParameters().Count > 0,
                    name + " must retain its metadata-only enclosing type parameter"
                )
            }
        }
        Assert.True(lambdas > 0)
        Assert.Equal("7\n9\n17\n19\n", fixture.Run(dll))
    }

    @Fact
    func ImportedGenericDataClassLiteral_ExpressionTreeDefersArgumentsAndConstruction() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.Compile(`package TreeLiteral5419
public class Trace {
    shared {
        public var Count int32
        public func Input(label string) string? {
            System.Console.WriteLine(label)
            return nil
        }
        public func Construct() int32 {
            System.Console.WriteLine("constructor")
            Count += 1
            return Count
        }
    }
}
public data class Box[T](Value T) {
    public var Extra int32
}
public data class Pair[T](First T, Second T) {
    public var Extra T?
    public let Stamp int32 = Trace.Construct()
}`, "TreeLiteral5419", false)
        IlVerifier.Verify(contract)
        let dll = fixture.Compile(`import System
import System.Linq.Expressions
import TreeLiteral5419
let simple Expression[Func[Box[int32]]] = () -> Box[int32]{Value: 7, Extra: 2}
let simpleValue = simple.Compile()()
Console.WriteLine(simpleValue.Value)
Console.WriteLine(simpleValue.Extra)
let tree Expression[Func[Pair[string?]]] = () -> Pair[string?]{
    Second: Trace.Input("second"),
    First: Trace.Input("first"),
    Extra: Trace.Input("extra")
}
Console.WriteLine(Trace.Count)
let invoke = tree.Compile()
Console.WriteLine(Trace.Count)
let first = invoke()
Console.WriteLine(first.First == nil && first.Second == nil && first.Extra == nil)
Console.WriteLine(first.Stamp)
let second = invoke()
Console.WriteLine(second.Stamp)
Console.WriteLine(Trace.Count)
`, "TreeConsumer", true, "/r:" + contract)
        IlVerifier.Verify(dll, additionalReferences: []string{contract})
        Assert.Equal(
            "7\n2\n0\n0\nsecond\nfirst\nconstructor\nextra\nTrue\n1\nsecond\nfirst\nconstructor\nextra\n2\n2\n",
            fixture.Run(dll)
        )
    }
}
