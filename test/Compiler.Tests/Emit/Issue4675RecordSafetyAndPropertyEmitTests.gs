// <copyright file="Issue4675RecordSafetyAndPropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.Globalization
import System.IO
import System.Linq
import System.Reflection
import System.Text
import Xunit

class Issue4675RecordSafetyAndPropertyEmitTests {
    @Fact
    func SetterOnlyPositionalReplacement_ReportsDeclarationDiagnostic() {
        const source = `package PositionalReplacement
data struct Item(Value int32) {
    public prop Value int32 { set(v) { } }
}`
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(source, "PositionalReplacement", true)
        Assert.NotEqual(0, code)
        Assert.Contains("(3,17,3,22): error GS0621:", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
    }

    @Fact
    func BarePositionalReplacementTypeMismatch_ReportsConversionDiagnostic() {
        const source = `package PositionalReplacement
data struct Item(Value int32) {
    public prop Value string
}`
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(source, "PositionalReplacement", true)
        Assert.NotEqual(0, code)
        Assert.Contains("error GS0155:", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("data struct", false)
    @InlineData("data class", false)
    @InlineData("data struct", true)
    @InlineData("data class", true)
    func ExplicitPositionalAutoProperty_RetainsPrivateReadonlyStorage(kind string, hasSetter bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package PositionalStorage
import System
KIND Box(Value int32) {
    public prop Value int32 { get; SETTER }
}
func Main() {
    let item = Box(7)
    Console.WriteLine(item.Value)
}`.Replace("KIND", kind, StringComparison.Ordinal)
                .Replace(
                "SETTER",
                if hasSetter {
                    "init;"
                } else {
                    string.Empty
                },
                StringComparison.Ordinal
            ), "PositionalStorage", true)
        IlVerifier.Verify(dll)
        Assert.Equal("7\n", fixture.Run(dll))
        let type Type? = Assembly.LoadFile(dll).GetType("PositionalStorage.Box", throwOnError: true)
        Assert.NotNull(type)
        let field = Assert.Single(
            type!!.GetFields(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
            )
        )
        Assert.Equal("<Value>k__BackingField", field.Name)
        Assert.True(field.IsPrivate)
        Assert.Equal(!hasSetter, field.IsInitOnly)
        let property PropertyInfo? = type!!.GetProperty("Value")
        Assert.NotNull(property)
        Assert.NotNull(property!!.GetMethod)
        Assert.Equal(hasSetter, property!!.SetMethod != nil)
    }

    @Theory
    @InlineData("data struct", "Box{Items: {1}}")
    @InlineData("data class", "Box{Items: {1}}")
    @InlineData("data struct", "Box{Items: List[int32](), ...[]int32{1}}")
    @InlineData("data class", "Box{Items: List[int32](), ...[]int32{1}}")
    @InlineData("data struct", "Box{Items: List[int32](), 1}")
    @InlineData("data class", "Box{Items: List[int32](), 1}")
    @InlineData("data struct", "Box{Items: {1}, ...[]int32{2}}")
    @InlineData("data class", "Box{Items: {1}, ...[]int32{2}}")
    @InlineData("derived data class", "Box{Items: {1}}")
    @InlineData("derived data class", "Box{Items: List[int32](), ...[]int32{1}}")
    func OrderedOmittedManagedArgument_IsRejectedAtTheLiteral(kind string, literal string) {
        let source = `package MissingOrderedHandle
import System.Collections.Generic
PARENT
KIND Box(Handle readonly managed[int32]) BASE {
    public var Items List[int32] = List[int32]()
    public func Add(value int32) { Items.Add(value) }
}
func Main() { let box = LITERAL }`.Replace(
            "PARENT",
            if kind == "derived data class" {
                "open class Parent(Saved readonly managed[int32])"
            } else {
                string.Empty
            },
            StringComparison.Ordinal
        ).Replace(
            "KIND",
            if kind == "derived data class" {
                "data class"
            } else {
                kind
            },
            StringComparison.Ordinal
        ).Replace(
            "BASE",
            if kind == "derived data class" {
                ": Parent(Handle)"
            } else {
                string.Empty
            },
            StringComparison.Ordinal
        ).Replace("LITERAL", literal, StringComparison.Ordinal)
        Reject(source, literal)
    }

    @Theory
    @InlineData("Box", "var box Box")
    @InlineData("Outer", "var box Outer")
    @InlineData("Box[int32]", "var box Box[int32]")
    func BareZeroWithPrivateRequiredHandle_DoesNotCreditOrdinaryInitializers(type string, declaration string) {
        let generic = type.Contains("[", StringComparison.Ordinal)
        let source = `package RequiredZero
data struct BoxGENERIC(Value PARAMETER) {
    private let Reference readonly managed[PARAMETER] = readonly managed(Value)
    private var Items []int32
    public func Read() PARAMETER -> *Reference
}
struct Outer { public var Inner Box }
func Main() { DECLARATION }`.Replace(
            "GENERIC",
            if generic {
                "[T]"
            } else {
                string.Empty
            },
            StringComparison.Ordinal
        ).Replace(
            "PARAMETER",
            if generic {
                "T"
            } else {
                "int32"
            },
            StringComparison.Ordinal
        ).Replace(
            "struct Outer { public var Inner Box }",
            if generic {
                string.Empty
            } else {
                "struct Outer { public var Inner Box }"
            },
            StringComparison.Ordinal
        ).Replace("DECLARATION", declaration, StringComparison.Ordinal)
        Reject(source, declaration)
    }

    @Fact
    func BarePositionalHandleProperty_IsAlsoRequired() {
        Reject(`package RequiredZeroProperty
data struct Box(Handle readonly managed[int32]) { public var Items []int32 }
func Main() { var box Box }`, "var box Box")
    }

    @Fact
    func BareGlobalZero_DoesNotCreditThePrimaryInitializer() {
        Reject(`package RequiredGlobalZero
data struct Box(Value int32) {
    private let Reference readonly managed[int32] = readonly managed(Value)
    private var Items []int32
}
var global Box
func Main() { }`, "var global Box")
    }

    @Theory
    @InlineData("data struct")
    @InlineData("data class")
    func ExplicitPrimaryStillInitializesPrivateHandlesOnce(kind string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ExplicitRequiredHandle
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
KIND Box(Value int32) {
    private let Reference readonly managed[int32] = readonly managed(Value)
    private var Items []int32
    private var Marker int32 = Counter.Next()
    public func Read() int32 -> *Reference
    public func Length() int32 -> Items.Length
    public func Mark() int32 -> Marker
}
func Main() {
    let box = Box{Value: 7}
    Console.WriteLine(box.Read())
    Console.WriteLine(box.Length())
    Console.WriteLine(box.Mark())
    Console.WriteLine(Counter.Count)
}`.Replace("KIND", kind, StringComparison.Ordinal), "ExplicitRequiredHandle", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`7
0
1
1
`, fixture.Run(dll))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func OrdinaryStructZero_StillUsesItsValidatedInitializerConstructor(nested bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package OrdinaryRequiredHandle
import System
struct Ordinary {
    private let Reference readonly managed[int32] = {
        var value = 7
        readonly managed(value)
    }
    private var Items []int32
    public func Read() int32 -> *Reference
    public func Length() int32 -> Items.Length
}
struct Outer { public var Inner Ordinary }
func Main() {
    DECLARATION
    Console.WriteLine(RECEIVER.Read())
    Console.WriteLine(RECEIVER.Length())
}`.Replace(
                "DECLARATION",
                if nested {
                    "var outer Outer"
                } else {
                    "var item Ordinary"
                },
                StringComparison.Ordinal
            )
                .Replace(
                "RECEIVER",
                if nested {
                    "outer.Inner"
                } else {
                    "item"
                },
                StringComparison.Ordinal
            ), "OrdinaryRequiredHandle", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`7
0
`, fixture.Run(dll))
    }

    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    @InlineData(true, true)
    func HiddenAndInheritedNonpositionalProperties_BindTheirActualConstructedOwner(generic bool, inherited bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`using System;
using System.Linq.Expressions;
using System.Reflection;
namespace PropertyContracts;
public static class Checks {
    public static string Inspect(LambdaExpression tree, LambdaExpression read, Type owner, Type memberType) {
        Expression body = tree.Body;
        while (body is BlockExpression block) body = block.Expressions[block.Expressions.Count - 1];
        if (body is not MemberInitExpression init || init.NewExpression.Members != null ||
            init.Bindings.Count != 1 || init.Bindings[0].Member is not PropertyInfo property ||
            property.Name != "Extra" || property.DeclaringType != owner || property.PropertyType != memberType ||
            read.Body is not MemberExpression access || access.Member is not PropertyInfo getter ||
            getter.DeclaringType != owner || getter.MetadataToken != property.MetadataToken)
            throw new Exception("Lost bound property owner, signature, or read/write identity");
        return "identity";
    }
}`, "PropertyContract")
        let source = `package PropertyTreeIdentity
import System
import System.Linq.Expressions
import PropertyContracts
open class BaseGENERIC {
    public prop Extra BASETYPE { get; init; }
}
data class ChildGENERIC(Value int32) : BaseBASEARG {
    OWN
}
func Main() {
    let tree Expression[Func[ChildTYPEARG]] = () -> ChildTYPEARG{Value: 1, Extra: ASSIGNED}
    let child = tree.Compile()()
    Console.WriteLine(child.Value)
    Console.WriteLine(child.Extra)
    let read Expression[Func[ChildTYPEARG, EXTRATYPE]] = (item ChildTYPEARG) -> item.Extra
    Console.WriteLine(read.Compile()(child))
    Console.WriteLine(Checks.Inspect(tree, read, typeof(DECLARING), typeof(EXTRATYPE)))
}`.Replace(
            "GENERIC",
            if generic {
                "[T]"
            } else {
                string.Empty
            },
            StringComparison.Ordinal
        ).Replace(
            "BASEARG",
            if generic {
                "[string]"
            } else {
                string.Empty
            },
            StringComparison.Ordinal
        ).Replace(
            "BASETYPE",
            if generic {
                "T"
            } else {
                "string"
            },
            StringComparison.Ordinal
        ).Replace(
            "TYPEARG",
            if generic {
                "[int64]"
            } else {
                string.Empty
            },
            StringComparison.Ordinal
        ).Replace(
            "OWN",
            if inherited {
                string.Empty
            } else {
                "public prop Extra " +
                    (
                    if generic {
                        "T"
                    } else {
                        "int32"
                    }
                ) +
                    " { get; init; }"
            },
            StringComparison.Ordinal
        ).Replace(
            "EXTRATYPE",
            if inherited {
                "string"
            } else {
                (
                    if generic {
                        "int64"
                    } else {
                        "int32"
                    }
                )
            },
            StringComparison.Ordinal
        ).Replace(
            "DECLARING",
            if inherited {
                (
                    if generic {
                        "Base[string]"
                    } else {
                        "Base"
                    }
                )
            } else {
                (
                    if generic {
                        "Child[int64]"
                    } else {
                        "Child"
                    }
                )
            },
            StringComparison.Ordinal
        ).Replace(
            "ASSIGNED",
            if inherited {
                "\"inherited\""
            } else {
                (
                    if generic {
                        "int64(2)"
                    } else {
                        "2"
                    }
                )
            },
            StringComparison.Ordinal
        )
        let dll = fixture.Compile(source, "PropertyTreeIdentity", true, "/r:" + contract)
        IlVerifier.Verify(dll, additionalReferences: []string{contract})
        Assert.Equal(
            if inherited {
                `1
inherited
inherited
identity
`
            } else {
                `1
2
2
identity
`
            },
            fixture.Run(dll)
        )
    }

    @Theory
    @InlineData("class", false)
    @InlineData("struct", false)
    @InlineData("class", true)
    @InlineData("struct", true)
    func ConstrainedPropertySelector_UsesTheActualInterfaceOwner(kind string, inherited bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ConstrainedPropertyTree
import System
import System.Linq.Expressions
interface IValue { prop Value int32 { get; } }
interface IChild : IValue {}
KIND Item : CONSTRAINT { public prop Value int32 -> 7 }
func make[T CONSTRAINT]() Expression[Func[T, int32]] -> (item T) -> item.Value
func Main() {
    let tree = make[Item]()
    Console.WriteLine(tree.Compile()(Item{}))
    let read = tree.Body as MemberExpression
    Console.WriteLine(read!!.Member.DeclaringType == typeof(IValue))
}`.Replace("KIND", kind, StringComparison.Ordinal)
                .Replace(
                "CONSTRAINT",
                if inherited {
                    "IChild"
                } else {
                    "IValue"
                },
                StringComparison.Ordinal
            ), "ConstrainedPropertyTree", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`7
True
`, fixture.Run(dll))
    }

    @Theory
    @InlineData("data class", false)
    @InlineData("data struct", false)
    @InlineData("data class", true)
    @InlineData("data struct", true)
    func ConstructedConstrainedSelector_RetainsTheSubstitutedInterfaceOwner(kind string, inherited bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ConstructedConstrainedPropertyTree
import System
import System.Linq.Expressions
interface IValue[V] { prop Value V { get; } }
interface IChild[V] : IValue[V] {}
KIND Item[V](Saved V) : CONSTRAINT[V] { public prop Value V -> Saved }
func make[T CONSTRAINT[int32]]() Expression[Func[T, int32]] -> (item T) -> item.Value
func readValue[T CONSTRAINT[int32]](item T) int32 -> item.Value
func Main() {
    let tree = make[Item[int32]]()
    let item = Item[int32]{Saved: 7}
    Console.WriteLine(tree.Compile()(item))
    Console.WriteLine(readValue[Item[int32]](item))
    let viaInterface IValue[int32] = item
    Console.WriteLine(viaInterface.Value)
    let read = tree.Body as MemberExpression
    Console.WriteLine(read!!.Member.DeclaringType == typeof(IValue[int32]))
    Console.WriteLine(read!!.Type == typeof(int32))
}`.Replace("KIND", kind, StringComparison.Ordinal)
                .Replace(
                "CONSTRAINT",
                if inherited {
                    "IChild"
                } else {
                    "IValue"
                },
                StringComparison.Ordinal
            ), "ConstructedConstrainedPropertyTree", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`7
7
7
True
True
`, fixture.Run(dll))
    }

    @Theory
    @InlineData("private", "")
    @InlineData("public", "private var Extra []int32")
    @InlineData("public", "")
    func DataZeroHelper_AnalyzesItsActualNestedConstructorValues(visibility string, sibling string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package NestedRequiredZero
import System
class Counter {
    shared {
        public var Child int32
        public var Parent int32
        public func ChildValue() int32 {
            Child += 1
            return 7
        }
        public func ParentValue() int32 {
            Parent += 1
            return 5
        }
    }
}
struct Inner {
    private let Reference readonly managed[int32] = {
        var value = Counter.ChildValue()
        readonly managed(value)
    }
    private var Items []int32
    public func Read() int32 -> *Reference
    public func Length() int32 -> Items.Length
}
data struct Outer(Value int32) {
    VISIBILITY var Nested Inner
    SIBLING
    private var Marker int32 = Counter.ParentValue()
    public func Read() int32 -> Nested.Read()
    public func Length() int32 -> Nested.Length()
    public func Mark() int32 -> Marker
}
func Main() {
    var outer Outer
    Console.WriteLine(outer.Read())
    Console.WriteLine(outer.Length())
    Console.WriteLine(outer.Value)
    Console.WriteLine(outer.Mark())
    Console.WriteLine(Counter.Child)
    Console.WriteLine(Counter.Parent)
}`.Replace("VISIBILITY", visibility, StringComparison.Ordinal)
                .Replace("SIBLING", sibling, StringComparison.Ordinal), "NestedRequiredZero", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`7
0
0
0
1
0
`, fixture.Run(dll))
    }

    @Fact
    func DataZeroHelper_DoesNotCreditANestedInitializerWithoutAZeroValue() {
        Reject(`package MissingNestedRequiredZero
struct Inner {
    private let Reference readonly managed[int32] = {
        var value = 7
        readonly managed(value)
    }
}
data struct Outer(Value int32) {
    private var Nested Inner = Inner{}
    private var Items []int32
}
func Main() { var outer Outer }`, "var outer Outer")
    }

    @Theory
    @InlineData("direct", false)
    @InlineData("nested", false)
    @InlineData("global", false)
    @InlineData("direct", true)
    func ConstructedPropertyStorage_RejectsActualRequiredHandleZeros($scope string, ordinaryProperty bool) {
        let declaration = if $scope == "nested" {
            "var box Outer"
        } else {
            "var box Box[readonly managed[int32]]"
        }
        let source = `package ConstructedRequiredZero
data struct Box[T](PRIMARY) {
    PROPERTY
    private var Items []int32
}
struct Outer { public var Inner Box[readonly managed[int32]] }
GLOBAL
func Main() { LOCAL }`.Replace(
            "PRIMARY",
            if ordinaryProperty {
                "Value int32"
            } else {
                "Handle T"
            },
            StringComparison.Ordinal
        ).Replace(
            "PROPERTY",
            if ordinaryProperty {
                "public prop Handle T { get; init; }"
            } else {
                string.Empty
            },
            StringComparison.Ordinal
        ).Replace(
            "GLOBAL",
            if $scope == "global" {
                declaration
            } else {
                string.Empty
            },
            StringComparison.Ordinal
        ).Replace(
            "LOCAL",
            if $scope == "global" {
                string.Empty
            } else {
                declaration
            },
            StringComparison.Ordinal
        )
        Reject(source, declaration)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructedPropertyStorage_RetainsZeroAndExplicitArgumentControls(managed bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ConstructedRequiredControl
import System
data struct Box[T](Handle T) {
    private var Items []int32
    public func Length() int32 -> Items.Length
}
func Main() {
    CONSTRUCT
    Console.WriteLine(READ)
    Console.WriteLine(box.Length())
}`.Replace(
                "CONSTRUCT",
                if managed {
                    "var value = 7\nlet box = Box[readonly managed[int32]]{Handle: readonly managed(value)}"
                } else {
                    "var box Box[int32]"
                },
                StringComparison.Ordinal
            )
                .Replace(
                "READ",
                if managed {
                    "*box.Handle"
                } else {
                    "box.Handle"
                },
                StringComparison.Ordinal
            ), "ConstructedRequiredControl", true)
        IlVerifier.Verify(dll)
        Assert.Equal(
            if managed {
                `7
0
`
            } else {
                `0
0
`
            },
            fixture.Run(dll)
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func PositionalNestedStorage_IsNotAnInTypeZeroField(generic bool) {
        Reject(`package PositionalNestedZero
struct Inner {
    private let Reference readonly managed[int32] = {
        var value = 7
        readonly managed(value)
    }
    private var Items []int32
}
data struct OuterGENERIC(Nested PARAMETER) { private var Items []int32 }
func Main() { DECLARATION }`.Replace(
                "GENERIC",
                if generic {
                    "[T]"
                } else {
                    string.Empty
                },
                StringComparison.Ordinal
            ).Replace(
                "PARAMETER",
                if generic {
                    "T"
                } else {
                    "Inner"
                },
                StringComparison.Ordinal
            ).Replace(
                "DECLARATION",
                if generic {
                    "var outer Outer[Inner]"
                } else {
                    "var outer Outer"
                },
                StringComparison.Ordinal
            ), if generic {
                "var outer Outer[Inner]"
            } else {
                "var outer Outer"
            })
    }

    @Fact
    func PositionalNestedStorage_ExplicitPrimaryArgumentRemainsInitialized() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ExplicitPositionalNested
import System
struct Inner {
    private let Reference readonly managed[int32] = {
        var value = 7
        readonly managed(value)
    }
    private var Items []int32
    public func Read() int32 -> *Reference
}
data struct Outer(Nested Inner) { private var Items []int32 }
func Main() {
    var inner Inner
    let outer = Outer{Nested: inner}
    Console.WriteLine(outer.Nested.Read())
}`, "ExplicitPositionalNested", true)
        IlVerifier.Verify(dll)
        Assert.Equal("7\n", fixture.Run(dll))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func DataZeroHelper_DoesNotCreditStorageAbsentFromItsDefinition(genericField bool) {
        Reject(`package DefinitionOwnedZero
struct Inner {
    private let Reference readonly managed[int32] = {
        var value = 7
        readonly managed(value)
    }
    private var Items []int32
}
data struct OuterGENERIC(Value int32) {
    STORAGE
    private var Items []int32
}
func Main() { DECLARATION }`.Replace(
                "GENERIC",
                if genericField {
                    "[T]"
                } else {
                    string.Empty
                },
                StringComparison.Ordinal
            ).Replace(
                "STORAGE",
                if genericField {
                    "private var Nested T"
                } else {
                    "public prop Nested Inner { get; init; }"
                },
                StringComparison.Ordinal
            ).Replace(
                "DECLARATION",
                if genericField {
                    "var outer Outer[Inner]"
                } else {
                    "var outer Outer"
                },
                StringComparison.Ordinal
            ), if genericField {
                "var outer Outer[Inner]"
            } else {
                "var outer Outer"
            })
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructedOrdinaryZero_RetainsItsValidatedDefinitionConstructor(nested bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ConstructedOrdinaryZero
import System
class Counter {
    shared {
        public var Count int32
        public func Next() int32 {
            Count += 1
            return 7
        }
    }
}
struct Inner[T] {
    private let Reference readonly managed[int32] = {
        var value = Counter.Next()
        readonly managed(value)
    }
    private var Items []T
    public func Read() int32 -> *Reference
    public func Length() int32 -> Items.Length
}
data struct Outer(Value int32) { private var Nested Inner[int32]
    private var Items []int32
    public func Read() int32 -> Nested.Read()
    public func Length() int32 -> Nested.Length()
}
func Main() {
    DECLARATION
    Console.WriteLine(item.Read())
    Console.WriteLine(item.Length())
    Console.WriteLine(Counter.Count)
}`.Replace(
                "DECLARATION",
                if nested {
                    "var item Outer"
                } else {
                    "var item Inner[int32]"
                },
                StringComparison.Ordinal
            ), "ConstructedOrdinaryZero", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`7
0
1
`, fixture.Run(dll))
    }

    @Theory
    @InlineData("public var Handle T")
    @InlineData("public prop Handle T { get; init; }")
    func ConstructedOrdinaryZero_DoesNotCreditANewlyRequiredSlot(storage string) {
        Reject(`package ConstructedOrdinaryRequiredZero
struct Box[T] {
    STORAGE
    private var Items []int32
}
func Main() { var box Box[readonly managed[int32]] }`.Replace(
                "STORAGE",
                storage,
                StringComparison.Ordinal
            ), "var box Box[readonly managed[int32]]")
    }

    @Theory
    @InlineData("data struct")
    @InlineData("data class")
    func StagedExpressionTreeArgument_RetainsItsRequiredQuote(kind string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package QuotedRecordArgument
import System
import System.Linq.Expressions
KIND Box(Selector Expression[Func[int32, int32]])
func Main() {
    let tree Expression[Func[Box]] = () -> Box{Selector: (x int32) -> x + 1}
    let box = tree.Compile()()
    Console.WriteLine(box.Selector.Compile()(41))
    let block = tree.Body as BlockExpression
    let assignment = block!!.Expressions[0] as BinaryExpression
    Console.WriteLine(assignment!!.Right.NodeType == ExpressionType.Quote)
}`.Replace("KIND", kind, StringComparison.Ordinal), "QuotedRecordArgument", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`42
True
`, fixture.Run(dll))
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func ClosedGenericZero_RetainsValuesNotWrittenByTheDefinitionConstructor(
        explicitConstruction bool,
        privateCollection bool
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package RetainedGenericZero
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
struct Inner { public var Items []int32 }
data struct Outer[T](Value int32) {
    public var Nested T
    private var Marker int32 = Counter.Next()
    COLLECTION
    public func Mark() int32 -> Marker
}
func Main() {
    CONSTRUCT
    Console.WriteLine(outer.Nested.Items.Length)
    Console.WriteLine(outer.Value)
    Console.WriteLine(outer.Mark())
    Console.WriteLine(Counter.Count)
}`.Replace(
                "COLLECTION",
                if privateCollection {
                    "private var Items []int32"
                } else {
                    string.Empty
                },
                StringComparison.Ordinal
            )
                .Replace(
                "CONSTRUCT",
                if explicitConstruction {
                    "let outer = Outer[Inner]{Value: 7, Nested: Inner{}}"
                } else {
                    "var outer Outer[Inner]"
                },
                StringComparison.Ordinal
            ), "RetainedGenericZero", true)
        IlVerifier.Verify(dll)
        Assert.Equal(
            if explicitConstruction {
                `0
7
1
1
`
            } else {
                `0
0
0
0
`
            },
            fixture.Run(dll)
        )
    }

    @Fact
    func ClosedGenericZero_RetainedRequiredChildUsesItsValidatedConstructor() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package RetainedRequiredChild
import System
struct Inner {
    private let Reference readonly managed[int32] = {
        var value = 7
        readonly managed(value)
    }
    private var Items []int32
    public func Read() int32 -> *Reference
}
data struct Outer[T](Value int32) {
    public var Nested T
    private var Items []int32
}
func Main() {
    var outer Outer[Inner]
    Console.WriteLine(outer.Nested.Read())
    Console.WriteLine(outer.Value)
}`, "RetainedRequiredChild", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`7
0
`, fixture.Run(dll))
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func PrivateClosedGenericZero_RejectsAChildWithoutAnInTypeStore(privateCollection bool, nested bool) {
        let declaration = if nested {
            "var outer Envelope"
        } else {
            "var outer Outer[Inner]"
        }
        Reject(
            PrivateClosedZeroSource(privateCollection, "T", declaration).Replace(
                "outer.Read().Items.Length",
                if nested {
                    "outer.Read().Read().Items.Length"
                } else {
                    "outer.Read().Items.Length"
                },
                StringComparison.Ordinal
            ),
            declaration,
            "GS0472"
        )
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func PrivateClosedGenericZero_RetainsActualDefinitionStores(privateCollection bool, explicitConstruction bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(
            PrivateClosedZeroSource(
                privateCollection,
                "Inner",
                if explicitConstruction {
                    "let outer = Outer[Inner]{Value: 7}"
                } else {
                    "var outer Outer[Inner]"
                }
            ),
            "PrivateClosedZero",
            true
        )
        IlVerifier.Verify(dll)
        Assert.Equal(
            if explicitConstruction {
                `0
7
1
1
`
            } else {
                `0
0
0
0
`
            },
            fixture.Run(dll)
        )
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func OrdinaryGenericScalar_RetainsActualConstructedInitializer(nested bool, handle bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let type = if handle {
            "readonly managed[int32]"
        } else {
            "int32"
        }
        let construction = `var value = 7
Provider[TYPE].Value = VALUE
var item CONTAINER[TYPE]`.Replace(
            "TYPE",
            type,
            StringComparison.Ordinal
        ).Replace(
            "VALUE",
            if handle {
                "readonly managed(value)"
            } else {
                "value"
            },
            StringComparison.Ordinal
        ).Replace(
            "CONTAINER",
            if nested {
                "Outer"
            } else {
                "Holder"
            },
            StringComparison.Ordinal
        )
        let dll = fixture.Compile(
            OrdinaryGenericScalarSource(construction, " = Provider[T].Next()", type, handle),
            "OrdinaryGenericScalar",
            true
        )
        IlVerifier.Verify(dll)
        Assert.Equal(`7
1
0
`, fixture.Run(dll))
    }

    @Theory
    @InlineData(false, "")
    @InlineData(true, "")
    @InlineData(false, " = default(T)")
    @InlineData(true, " = default(T)")
    func OrdinaryGenericScalar_RejectsAbsentOrDefaultConstructedInitializer(nested bool, initializer string) {
        let declaration = if nested {
            "var item Outer[readonly managed[int32]]"
        } else {
            "var item Holder[readonly managed[int32]]"
        }
        Reject(OrdinaryGenericScalarSource(declaration, initializer, "readonly managed[int32]", true), declaration)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func OrdinaryZeroConstructor_DoesNotCreditUnwrittenRequiredProperty(nested bool) {
        let declaration = if nested {
            "var item Outer"
        } else {
            "var item Holder"
        }
        Reject(OrdinaryUnwrittenPropertySource(declaration), declaration)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func OrdinaryRequiredProperty_ExplicitInTypeInitializationRemainsValid(nested bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let construction = if nested {
            "let item = Outer{Nested: Holder.Create(7)}"
        } else {
            "let item = Holder.Create(7)"
        }
        let source = OrdinaryUnwrittenPropertySource(construction).Replace(
            "public var Nested Holder",
            "public var Nested Holder = Holder.Create(7)",
            StringComparison.Ordinal
        )
        let dll = fixture.Compile(source, "OrdinaryRequiredProperty", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`7
0
`, fixture.Run(dll))
    }

    @Theory
    @InlineData(int32(1), false)
    @InlineData(int32(1), true)
    @InlineData(int32(2), false)
    @InlineData(int32(2), true)
    func PrivateFixedHandleArrayZero_RejectsUnsuppliedElements(length int32, nested bool) {
        const declaration = "var box Box"
        Reject(PrivateFixedHandleArraySource(length, declaration, nested), declaration)
    }

    @Theory
    @InlineData(int32(1), false)
    @InlineData(int32(1), true)
    @InlineData(int32(2), false)
    @InlineData(int32(2), true)
    func PrivateFixedHandleArrayZero_ExplicitPrimaryInitializationRemainsValid(length int32, nested bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        const construction = "let box = Box{Value: 7}"
        let dll = fixture.Compile(
            PrivateFixedHandleArraySource(length, construction, nested),
            "PrivateFixedHandleArray",
            true
        )
        IlVerifier.Verify(dll)
        Assert.Equal((`7
` + "$length" + `
1
1
`), fixture.Run(dll))
    }

    @Theory
    @InlineData(int32(1), false)
    @InlineData(int32(1), true)
    @InlineData(int32(2), false)
    @InlineData(int32(2), true)
    func OrdinaryGenericFixedArray_RejectsUnsuppliedConstructedElements(length int32, nested bool) {
        let declaration = if nested {
            "var item Outer[readonly managed[int32]]"
        } else {
            "var item Holder[readonly managed[int32]]"
        }
        Reject(OrdinaryGenericArraySource(length, nested, declaration), declaration)
    }

    @Theory
    @InlineData(int32(1), false)
    @InlineData(int32(1), true)
    @InlineData(int32(2), false)
    @InlineData(int32(2), true)
    func OrdinaryGenericFixedArray_RejectsExplicitDefaultElements(length int32, nested bool) {
        let declaration = if nested {
            "var item Outer[readonly managed[int32]]"
        } else {
            "var item Holder[readonly managed[int32]]"
        }
        let source = OrdinaryGenericArraySource(length, nested, declaration).Replace(
            "private var Handles [$length]T",
            "private var Handles [$length]T = [$length]T{VALUES}",
            StringComparison.Ordinal
        )
            .Replace("VALUES", string.Join(", ", Enumerable.Repeat("default(T)", length)), StringComparison.Ordinal)
        Reject(source, declaration)
    }

    @Theory
    @InlineData(int32(1), false)
    @InlineData(int32(1), true)
    @InlineData(int32(2), false)
    @InlineData(int32(2), true)
    func OrdinaryGenericFixedArray_RetainsValueElementZeros(length int32, nested bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let declaration = if nested {
            "var item Outer[int32]"
        } else {
            "var item Holder[int32]"
        }
        let dll = fixture.Compile(OrdinaryGenericArraySource(length, nested, declaration), "OrdinaryGenericArray", true)
        IlVerifier.Verify(dll)
        Assert.Equal((`0
` + "$length" + `
`), fixture.Run(dll))
    }

    @Theory
    @InlineData(int32(1), false)
    @InlineData(int32(1), true)
    @InlineData(int32(2), false)
    @InlineData(int32(2), true)
    func OrdinaryGenericFixedArray_PreservesExplicitlySuppliedElements(length int32, nested bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = OrdinaryGenericArraySource(length, nested, `var value = 7
Provider[readonly managed[int32]].Value = readonly managed(value)
var item CONTAINER[readonly managed[int32]]`.Replace(
                "CONTAINER",
                if nested {
                    "Outer"
                } else {
                    "Holder"
                },
                StringComparison.Ordinal
            )).Replace("struct Holder[T] {", `class Provider[T] {
    shared {
        public var Value T
        public var Calls int32
        public func Next() T {
            Calls += 1
            return Value
        }
    }
}
struct Holder[T] {`, StringComparison.Ordinal).Replace(
            "private var Handles [$length]T",
            "private var Handles [$length]T = [$length]T{VALUES}",
            StringComparison.Ordinal
        ).Replace(
            "VALUES",
            string.Join(", ", Enumerable.Repeat("Provider[T].Next()", length)),
            StringComparison.Ordinal
        ).Replace(
            "Console.WriteLine(item.Length())",
            "Console.WriteLine(item.Length())\nConsole.WriteLine(Provider[readonly managed[int32]].Calls)",
            StringComparison.Ordinal
        )
        let dll = fixture.Compile(source, "OrdinaryGenericArray", true)
        IlVerifier.Verify(dll)
        Assert.Equal((`7
` + "$length" + `
` + "$length" + `
`), fixture.Run(dll))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func PrivateZeroLengthHandleArray_HasNoRequiredElements(generic bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package EmptyHandleArray
import System
data struct BoxGENERIC(Value int32) {
    private var Handles [0]ELEMENT
    public func Length() int32 -> Handles.Length
}
func Main() {
    var box CONSTRUCTION
    Console.WriteLine(box.Length())
    var direct [0]readonly managed[int32]
    Console.WriteLine(direct.Length)
}`.Replace(
                "GENERIC",
                if generic {
                    "[T]"
                } else {
                    string.Empty
                },
                StringComparison.Ordinal
            ).Replace(
                "ELEMENT",
                if generic {
                    "T"
                } else {
                    "readonly managed[int32]"
                },
                StringComparison.Ordinal
            ).Replace(
                "CONSTRUCTION",
                if generic {
                    "Box[readonly managed[int32]]"
                } else {
                    "Box"
                },
                StringComparison.Ordinal
            ), "EmptyHandleArray", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`0
0
`, fixture.Run(dll))
    }

    @Theory
    @InlineData("struct", "public var Extra T", false)
    @InlineData("struct", "public var Extra T", true)
    @InlineData("struct", "public prop Extra T { get; init; }", false)
    @InlineData("struct", "public prop Extra T { get; init; }", true)
    @InlineData("data struct", "public var Extra T", false)
    @InlineData("data struct", "public var Extra T", true)
    @InlineData("data struct", "public prop Extra T { get; init; }", false)
    @InlineData("data struct", "public prop Extra T { get; init; }", true)
    func NestedConstructedInitializer_DoesNotCreditANewlyRequiredChildSlot(
        kind string,
        storage string,
        publicNested bool
    ) {
        Reject(
            NestedConstructorSource(kind, storage, publicNested, "var outer Outer[readonly managed[int32]]", "*"),
            "var outer Outer[readonly managed[int32]]"
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func NestedConstructedInitializer_RecursesThroughMultipleConstructorValues(publicNested bool) {
        let source = NestedConstructorSource(
            "struct",
            "public var Extra T",
            publicNested,
            "var outer Envelope[readonly managed[int32]]",
            "*"
        )
            .Replace("func Main()", `struct Envelope[T] {
    private var Nested Outer[T]
    public func Read() int32 -> Nested.Read()
    public func Extra() T -> Nested.Extra()
    public func Length() int32 -> Nested.Length()
}
func Main()`, StringComparison.Ordinal)
        Reject(source, "var outer Envelope[readonly managed[int32]]")
    }

    @Theory
    @InlineData("public var Extra T", false)
    @InlineData("public var Extra T", true)
    @InlineData("public prop Extra T { get; init; }", false)
    @InlineData("public prop Extra T { get; init; }", true)
    func NestedConstructedInitializer_RetainsItsValidatedHandleAndValueZero(storage string, publicNested bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(
            NestedConstructorSource("struct", storage, publicNested, "var outer Outer[int32]", string.Empty),
            "NestedConstructorCredit",
            true
        )
        IlVerifier.Verify(dll)
        Assert.Equal(`7
0
0
1
`, fixture.Run(dll))
    }

    @Theory
    @InlineData("public var Extra T")
    @InlineData("public prop Extra T { get; init; }")
    func NestedConstructedInitializer_ExplicitSuppliedHandleRemainsValid(storage string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(NestedConstructorSource("struct", storage, true, `var value = 11
let supplied = Inner[readonly managed[int32]]{Extra: readonly managed(value)}
let outer = Outer[readonly managed[int32]]{Nested: supplied}`, "*"), "NestedConstructorCredit", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`7
11
0
2
`, fixture.Run(dll))
    }

    @Theory
    @InlineData("public prop Handle U { get; init; }", false)
    @InlineData("public prop Handle U { get; init; }", true)
    @InlineData("public prop Handle U { get; set; }", false)
    @InlineData("public prop Handle U { get; set; }", true)
    @InlineData("private var Handle U = default(U)", false)
    @InlineData("private var Handle U = default(U)", true)
    @InlineData("public var Handle U = default(U)", false)
    @InlineData("public var Handle U = default(U)", true)
    func NestedExplicitLiteral_RejectsUninitializedConstructedStorage(storage string, nested bool) {
        let declaration = if nested {
            "var item Envelope[readonly managed[int32]]"
        } else {
            "var item Outer[readonly managed[int32]]"
        }
        Reject(NestedExplicitLiteralSource(storage, "Inner[T]{}", declaration), declaration)
    }

    @Theory
    @InlineData("private var Handle U = Provider[U].Next()", "Inner[T]{}", false)
    @InlineData("private var Handle U = Provider[U].Next()", "Inner[T]{}", true)
    @InlineData("public var Handle U", "Inner[T]{Handle: Provider[T].Next()}", false)
    @InlineData("public var Handle U", "Inner[T]{Handle: Provider[T].Next()}", true)
    @InlineData("public prop Handle U { get; init; }", "Inner[T]{Handle: Provider[T].Next()}", false)
    @InlineData("public prop Handle U { get; init; }", "Inner[T]{Handle: Provider[T].Next()}", true)
    @InlineData("public prop Handle U { get; set; }", "Inner[T]{Handle: Provider[T].Next()}", false)
    @InlineData("public prop Handle U { get; set; }", "Inner[T]{Handle: Provider[T].Next()}", true)
    func NestedExplicitLiteral_RetainsActualInitializerAndSuppliedStorage(
        storage string,
        initializer string,
        nested bool
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let construction = `var value = 7
Provider[readonly managed[int32]].Value = readonly managed(value)
var item CONTAINER[readonly managed[int32]]`.Replace(
            "CONTAINER",
            if nested {
                "Envelope"
            } else {
                "Outer"
            },
            StringComparison.Ordinal
        )
        let dll = fixture.Compile(
            NestedExplicitLiteralSource(storage, initializer, construction),
            "NestedExplicitLiteral",
            true
        )
        IlVerifier.Verify(dll)
        Assert.Equal(`7
0
1
`, fixture.Run(dll))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func InitializerFunctionCache_RejectsUnsafeConstructionRegardlessOfVisitOrder(safeFirst bool) {
        const safe = "var safe Holder[int32]"
        const invalid = "var invalid Holder[readonly managed[int32]]"
        Reject(
            InitializerFunctionSource(
                "default(T)",
                if safeFirst {
                    safe + "\n" + invalid
                } else {
                    invalid + "\n" + safe
                },
                "Console.WriteLine(*invalid.Read())"
            ),
            invalid
        )
    }

    @Fact
    func InitializerFunctionCache_RetainsIndependentConstructedProviderValues() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(InitializerFunctionSource("Provider[T].Next()", `Provider[int32].Value = 3
var safe Holder[int32]
var value = 7
Provider[readonly managed[int32]].Value = readonly managed(value)
var item Holder[readonly managed[int32]]`, `Console.WriteLine(safe.Read())
Console.WriteLine(*item.Read())
Console.WriteLine(safe.Length() + item.Length())
Console.WriteLine(Provider[int32].Calls)
Console.WriteLine(Provider[readonly managed[int32]].Calls)`), "InitializerFunctionCache", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`3
7
0
1
1
`, fixture.Run(dll))
    }

    @Theory
    @InlineData("data struct")
    @InlineData("data class")
    func ConstructorInitializerExecution_RejectsUnsafeOverwrittenScalar(kind string) {
        const construction = "Box[readonly managed[int32]]{Value: 7, Marker: 42}"
        Reject(OverwrittenScalarSource(kind, "default(T)", true, construction), construction)
    }

    @Theory
    @InlineData("data struct", false)
    @InlineData("data class", false)
    @InlineData("data struct", true)
    @InlineData("data class", true)
    func ConstructorInitializerExecution_RetainsSafeOverwrittenScalarOnce(kind string, handle bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let construction = "Box[${(if handle { "readonly managed[int32]" } else { "int32" })}]{Value: 7, Marker: 42}"
        let dll = fixture.Compile(
            OverwrittenScalarSource(
                kind,
                if handle {
                    "Provider[T].Value"
                } else {
                    "default(T)"
                },
                handle,
                construction
            ),
            "OverwrittenScalar",
            true
        )
        IlVerifier.Verify(dll)
        Assert.Equal(`7
42
1
`, fixture.Run(dll))
    }

    @Theory
    @InlineData("data struct", int32(1))
    @InlineData("data class", int32(1))
    @InlineData("data struct", int32(2))
    @InlineData("data class", int32(2))
    func ConstructorInitializerExecution_RejectsOverwrittenArrayElementZeros(kind string, length int32) {
        let construction = "Box[readonly managed[int32]]{Value: 7, Handles: [$length]readonly managed[int32]{${string.Join(", ", Enumerable.Repeat("readonly managed(value)", length))}}}"
        Reject(OverwrittenArraySource(kind, length, false, construction), construction)
    }

    @Theory
    @InlineData("data struct", int32(0))
    @InlineData("data class", int32(0))
    @InlineData("data struct", int32(1))
    @InlineData("data class", int32(1))
    func ConstructorInitializerExecution_RetainsSafeOverwrittenArraysOnce(kind string, length int32) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let values = if length == 0 {
            "[0]readonly managed[int32]"
        } else {
            "[1]readonly managed[int32]{readonly managed(value)}"
        }
        let construction = "Box[readonly managed[int32]]{Value: 7, Handles: $values}"
        let dll = fixture.Compile(OverwrittenArraySource(kind, length, true, construction), "OverwrittenArray", true)
        IlVerifier.Verify(dll)
        Assert.Equal((`7
` + "$length" + `
` + "$length" + `
`), fixture.Run(dll))
    }

    @Fact
    func ConstructorInitializerRecursion_ConditionalClassConstructionTerminates() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        const source = `package ConditionalNode
import System
class Node {
    public var Next Node? = Node.Recurse ? Node{} : nil
    public var Marker int32 = Node.Count()
    shared {
        public var Recurse bool
        public var Calls int32
        public func Count() int32 {
            Calls += 1
            return Calls
        }
    }
}
func Main() {
    let item = Node{}
    Console.WriteLine(item.Next == nil)
    Console.WriteLine(item.Marker)
    Console.WriteLine(Node.Calls)
}`
        let (code, output) = TryCompileIsolated(fixture, source, "ConditionalNode")
        Assert.True(code == 0, output)
        let dll = Path.Combine(fixture.Directory, "ConditionalNode.dll")
        IlVerifier.Verify(dll)
        Assert.Equal(`True
1
1
`, fixture.Run(dll))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorInitializerRecursion_DistinctConstructedOwnersRemainValid(safeFirst bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        const scalar = "let scalar = Node[int32]{}"
        const handle = "let handle = Node[readonly managed[int32]]{}"
        let source = RecursiveInitializerSource(
            "Provider[T].Next()",
            if safeFirst {
                scalar + "\n" + handle
            } else {
                handle + "\n" + scalar
            },
            `Console.WriteLine(scalar.Saved)
Console.WriteLine(*handle.Saved)
Console.WriteLine(scalar.Next == nil && handle.Next == nil)
Console.WriteLine(Provider[int32].Calls)
Console.WriteLine(Provider[readonly managed[int32]].Calls)`
        )
        let (code, output) = TryCompileIsolated(fixture, source, "RecursiveOwners")
        Assert.True(code == 0, output)
        let dll = Path.Combine(fixture.Directory, "RecursiveOwners.dll")
        IlVerifier.Verify(dll)
        Assert.Equal(`3
11
True
1
1
`, fixture.Run(dll))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorInitializerRecursion_DoesNotHideUnsafeLaterFields(safeFirst bool) {
        const scalar = "let scalar = Node[int32]{}"
        const handle = "let handle = Node[readonly managed[int32]]{}"
        Reject(
            RecursiveInitializerSource(
                "default(T)",
                if safeFirst {
                    scalar + "\n" + handle
                } else {
                    handle + "\n" + scalar
                },
                string.Empty
            ),
            "Node[readonly managed[int32]]{}",
            isolated: true
        )
    }

    @Theory
    @InlineData("public var Extra T")
    @InlineData("public prop Extra T { get; init; }")
    func ConstructorInitializerRecursion_RechecksLaterResultConsumption(storage string) {
        const invalid = "Outer[readonly managed[int32]](0)"
        Reject(NestedConstructorSource("data struct", storage, true, `var value = 11
let supplied = Inner[readonly managed[int32]]{Extra: readonly managed(value)}
let outer = Outer[readonly managed[int32]]{Nested: supplied}
let invalid = Outer[readonly managed[int32]](0)`, "*"), invalid)
    }

    @Theory
    @InlineData("[]T")
    @InlineData("Node[T]")
    func ConstructorInitializerValidation_RejectsExpandingOwnersWithoutCrashing(argument string) {
        Reject(`package ExpandingOwners
class Flags { shared { public var Recurse bool } }
class Node[T] {
    public var Next Node[ARGUMENT]? = Flags.Recurse ? Node[ARGUMENT]{} : nil
}
func Main() { let item = Node[int32]{} }`.Replace(
                "ARGUMENT",
                argument,
                StringComparison.Ordinal
            ), "Node[int32]{}", isolated: true)
    }

    @Theory
    @InlineData(int32(8))
    @InlineData(int32(29))
    @InlineData(int32(63))
    func ConstructorInitializerValidation_SharedChildGraphCompilesWithinTimeout(depth int32) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = TryCompileIsolated(fixture, SharedChildInitializerSource(depth), "SharedInitializerGraph")
        Assert.True(code == 0, output)
        let dll = Path.Combine(fixture.Directory, "SharedInitializerGraph.dll")
        IlVerifier.Verify(dll)
        Assert.Equal(`True
1
1
`, fixture.Run(dll))
    }

    @Fact
    func ConstructorInitializerValidation_RejectsTheFirstUnsupportedInitializerDepth() {
        const anchor = "Node64[readonly managed[int32]]{}"
        let source = SharedChildInitializerSource(64)
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = TryCompileIsolated(fixture, source, "InitializerDepth")
        Assert.True(code == 1, output)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "InitializerDepth.dll")), output)
        AssertDiagnosticAt(source, source.IndexOf(anchor, StringComparison.Ordinal), anchor, output, "GS0604")
        Assert.Contains("supported recursion depth of 64", output, StringComparison.Ordinal)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorInitializerValidation_ReportsEachConstructionSite(generic bool) {
        let construction = if generic {
            "Holder[readonly managed[int32]]{}"
        } else {
            "Holder{}"
        }
        let source = `package InitializerSites
class HOLDER { private var Saved HANDLE = (func() HANDLE { return default(HANDLE) })() }
func Main() {
    let first = CONSTRUCTION
    let second = CONSTRUCTION
}`.Replace(
            "HOLDER",
            if generic {
                "Holder[T]"
            } else {
                "Holder"
            },
            StringComparison.Ordinal
        ).Replace(
            "HANDLE",
            if generic {
                "T"
            } else {
                "readonly managed[int32]"
            },
            StringComparison.Ordinal
        ).Replace("CONSTRUCTION", construction, StringComparison.Ordinal)
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(source, "InitializerSites", true)
        Assert.NotEqual(0, code)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "InitializerSites.dll")), output)
        for declaration in[]string{"let first = ", "let second = "} {
            let offset = source.IndexOf(declaration, StringComparison.Ordinal) + declaration.Length
            AssertDiagnosticAt(source, offset, construction, output, "GS0604")
        }
    }

    @Fact
    func ConstructorInitializerValidation_RepeatedFunctionValuesExecuteOncePerConstruction() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package InitializerFunctions
import System
class Provider[T] {
    shared {
        public var Value T
        public var Calls int32
        public func Next() T {
            Calls += 1
            return Value
        }
    }
}
class Holder {
    private var Saved readonly managed[int32] = (func() readonly managed[int32] { return Provider[readonly managed[int32]].Next() })()
    public func Read() int32 -> *Saved
}
func Main() {
    var value = 7
    Provider[readonly managed[int32]].Value = readonly managed(value)
    let first = Holder{}
    let second = Holder{}
    Console.WriteLine(first.Read())
    Console.WriteLine(second.Read())
    Console.WriteLine(Provider[readonly managed[int32]].Calls)
}`, "InitializerFunctions", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`7
7
2
`, fixture.Run(dll))
    }

    @Fact
    func ConstructorInitializerValidation_FunctionRecursionStillTerminates() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = TryCompileIsolated(fixture, `package InitializerFunctionRecursion
import System
class Flags { shared { public var Recurse bool } }
class Node {
    public var Next Node? = (func() Node? { return Flags.Recurse ? Node{} : nil })()
}
func Main() {
    let first = Node{}
    let second = Node{}
    Console.WriteLine(first.Next == nil && second.Next == nil)
}`, "InitializerFunctionRecursion")
        Assert.True(code == 0, output)
        let dll = Path.Combine(fixture.Directory, "InitializerFunctionRecursion.dll")
        IlVerifier.Verify(dll)
        Assert.Equal("True\n", fixture.Run(dll))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorInitializerValidation_DistinguishesOverwrittenAndConsumedResults(supplySecond bool) {
        const construction = "Wrapper[readonly managed[int32]]{}"
        let source = `package InitializerResults
import System
class Provider[T] { shared { public var Value T } }
struct Inner[T] {
    public var Extra T
    private var Items []int32
}
data struct Outer[T](Value int32) {
    public var Nested Inner[T]
    private var Items []int32
}
class Wrapper[T] {
    public var First Outer[T] = Outer[T]{Nested: Inner[T]{Extra: Provider[T].Value}}
    public var Second Outer[T] = SECOND
}
func Main() {
    var value = 11
    Provider[readonly managed[int32]].Value = readonly managed(value)
    let item = CONSTRUCTION
    Console.WriteLine(*item.First.Nested.Extra)
    Console.WriteLine(*item.Second.Nested.Extra)
}`.Replace(
            "SECOND",
            if supplySecond {
                "Outer[T]{Nested: Inner[T]{Extra: Provider[T].Value}}"
            } else {
                "Outer[T](0)"
            },
            StringComparison.Ordinal
        )
            .Replace("CONSTRUCTION", construction, StringComparison.Ordinal)
        if !supplySecond {
            Reject(source, construction)
            return
        }
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(source, "InitializerResults", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`11
11
`, fixture.Run(dll))
    }

    shared {
        private func OrdinaryGenericScalarSource(
            construction string,
            initializer string,
            type string,
            handle bool
        ) string -> `package OrdinaryGenericScalar
import System
class Provider[T] {
    shared {
        public var Value T
        public var Calls int32
        public func Next() T {
            Calls += 1
            return Value
        }
    }
}
struct Holder[T] {
    private var Saved TINITIALIZER
    private var Items []int32
    public func Read() T -> Saved
    public func Length() int32 -> Items.Length
}
struct Outer[T] {
    private var Nested Holder[T]
    private var Items []int32
    public func Read() T -> Nested.Read()
    public func Length() int32 -> Nested.Length()
}
func Main() {
    CONSTRUCTION
    Console.WriteLine(DEREFERENCEitem.Read())
    Console.WriteLine(Provider[TYPE].Calls)
    Console.WriteLine(item.Length())
}`
            .Replace("INITIALIZER", initializer, StringComparison.Ordinal)
            .Replace("CONSTRUCTION", construction, StringComparison.Ordinal)
            .Replace(
            "DEREFERENCE",
            if handle {
                "*"
            } else {
                ""
            },
            StringComparison.Ordinal
        )
            .Replace("TYPE", type, StringComparison.Ordinal)

        private func OrdinaryUnwrittenPropertySource(construction string) string -> `package OrdinaryRequiredProperty
import System
struct Holder {
    private prop Handle readonly managed[int32] { get; init; }
    private var Items []int32
    public func Read() int32 -> *Handle
    public func Length() int32 -> Items.Length
    shared {
        public func Create(value int32) Holder -> Holder{Handle: readonly managed(value)}
    }
}
struct Outer {
    public var Nested Holder
    private var Items []int32
    public func Read() int32 -> Nested.Read()
    public func Length() int32 -> Nested.Length()
}
func Main() {
    CONSTRUCTION
    Console.WriteLine(item.Read())
    Console.WriteLine(item.Length())
}`.Replace("CONSTRUCTION", construction, StringComparison.Ordinal)

        private func PrivateClosedZeroSource(privateCollection bool, fieldType string, construction string) string -> `package PrivateClosedZero
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
struct Inner { public var Items []int32 }
data struct Outer[T](Value int32) {
    private var Nested FIELD_TYPE
    private var Marker int32 = Counter.Next()
    COLLECTION
    public func Read() FIELD_TYPE -> Nested
    public func Mark() int32 -> Marker
}
ENVELOPE
func Main() {
    CONSTRUCTION
    Console.WriteLine(outer.Read().Items.Length)
    Console.WriteLine(outer.Value)
    Console.WriteLine(outer.Mark())
    Console.WriteLine(Counter.Count)
}`.Replace(
            "FIELD_TYPE",
            fieldType,
            StringComparison.Ordinal
        ).Replace(
            "COLLECTION",
            if privateCollection {
                "private var Items []int32"
            } else {
                string.Empty
            },
            StringComparison.Ordinal
        ).Replace(
            "ENVELOPE",
            if construction == "var outer Envelope" {
                `struct Envelope {
    public var Nested Outer[Inner]
    public func Read() Outer[Inner] -> Nested
}`
            } else {
                string.Empty
            },
            StringComparison.Ordinal
        ).Replace(
            "CONSTRUCTION",
            construction,
            StringComparison.Ordinal
        ).Replace(
            "Console.WriteLine(outer.Value)",
            if construction == "var outer Envelope" {
                string.Empty
            } else {
                "Console.WriteLine(outer.Value)"
            },
            StringComparison.Ordinal
        ).Replace(
            "Console.WriteLine(outer.Mark())",
            if construction == "var outer Envelope" {
                string.Empty
            } else {
                "Console.WriteLine(outer.Mark())"
            },
            StringComparison.Ordinal
        )

        private func OrdinaryGenericArraySource(length int32, nested bool, construction string) string -> `package OrdinaryGenericArray
import System
struct Holder[T] {
    private var Handles [LENGTH]T
    public func Read() T -> Handles[0]
    public func Length() int32 -> Handles.Length
}
data struct Outer[T](Value int32) {
    private var Nested Holder[T]
    private var Items []int32
    public func Read() T -> Nested.Read()
    public func Length() int32 -> Nested.Length()
}
func Main() {
    CONSTRUCTION
    Console.WriteLine(READ)
    Console.WriteLine(item.Length())
}`.Replace(
            "LENGTH",
            length.ToString(CultureInfo.InvariantCulture),
            StringComparison.Ordinal
        ).Replace(
            "CONSTRUCTION",
            construction,
            StringComparison.Ordinal
        ).Replace(
            "READ",
            if construction.Contains("readonly managed", StringComparison.Ordinal) {
                "*item.Read()"
            } else {
                "item.Read()"
            },
            StringComparison.Ordinal
        ).Replace(
            "data struct Outer[T](Value int32)",
            if nested {
                "data struct Outer[T](Value int32)"
            } else {
                "data struct UnusedOuter[T](Value int32)"
            },
            StringComparison.Ordinal
        )

        private func PrivateFixedHandleArraySource(length int32, construction string, nested bool) string -> `package PrivateFixedHandleArray
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
ELEMENT_DECLARATION
data struct Box(Value int32) {
    private var Handles [LENGTH]ELEMENT_TYPE = [LENGTH]ELEMENT_TYPE{ELEMENTS}
    private var Marker int32 = Counter.Next()
    private var Items []int32
    public func Read() int32 -> READ
    public func Length() int32 -> Handles.Length
    public func Mark() int32 -> Marker
}
func Main() {
    CONSTRUCTION
    Console.WriteLine(box.Read())
    Console.WriteLine(box.Length())
    Console.WriteLine(box.Mark())
    Console.WriteLine(Counter.Count)
}`.Replace(
            "LENGTH",
            length.ToString(CultureInfo.InvariantCulture),
            StringComparison.Ordinal
        ).Replace(
            "ELEMENT_DECLARATION",
            if nested {
                "data struct Element(Handle readonly managed[int32]) { public func Read() int32 -> *Handle }"
            } else {
                string.Empty
            },
            StringComparison.Ordinal
        ).Replace(
            "ELEMENT_TYPE",
            if nested {
                "Element"
            } else {
                "readonly managed[int32]"
            },
            StringComparison.Ordinal
        ).Replace(
            "ELEMENTS",
            string.Join(
                ", ",
                Enumerable.Repeat(
                    if nested {
                        "Element{Handle: readonly managed(Value)}"
                    } else {
                        "readonly managed(Value)"
                    },
                    length
                )
            ),
            StringComparison.Ordinal
        ).Replace(
            "CONSTRUCTION",
            construction,
            StringComparison.Ordinal
        ).Replace(
            "READ",
            if nested {
                "Handles[0].Read()"
            } else {
                "*Handles[0]"
            },
            StringComparison.Ordinal
        )

        private func NestedConstructorSource(
            kind string,
            storage string,
            publicNested bool,
            construction string,
            dereference string
        ) string -> `package NestedConstructorCredit
import System
class Counter {
    shared {
        public var Count int32
        public func Next() int32 {
            Count += 1
            return 7
        }
    }
}
struct Inner[T] {
    private let Reference readonly managed[int32] = {
        var value = Counter.Next()
        readonly managed(value)
    }
    STORAGE
    private var Items []int32
    public func Read() int32 -> *Reference
    public func Length() int32 -> Items.Length
}
KIND Outer[T]PRIMARY {
    VISIBILITY var Nested Inner[T]
    SIBLING
    public func Read() int32 -> Nested.Read()
    public func Extra() T -> Nested.Extra
    public func Length() int32 -> Nested.Length()
}
func Main() {
    CONSTRUCTION
    Console.WriteLine(outer.Read())
    Console.WriteLine(DEREFERENCEouter.Extra())
    Console.WriteLine(outer.Length())
    Console.WriteLine(Counter.Count)
}`
            .Replace("KIND", kind, StringComparison.Ordinal)
            .Replace(
            "PRIMARY",
            if kind == "data struct" {
                "(Value int32)"
            } else {
                string.Empty
            },
            StringComparison.Ordinal
        )
            .Replace("STORAGE", storage, StringComparison.Ordinal)
            .Replace(
            "VISIBILITY",
            if publicNested {
                "public"
            } else {
                "private"
            },
            StringComparison.Ordinal
        )
            .Replace(
            "SIBLING",
            if publicNested {
                "private var Items []int32"
            } else {
                string.Empty
            },
            StringComparison.Ordinal
        )
            .Replace("CONSTRUCTION", construction, StringComparison.Ordinal)
            .Replace("DEREFERENCE", dereference, StringComparison.Ordinal)

        private func NestedExplicitLiteralSource(storage string, initializer string, construction string) string -> `package NestedExplicitLiteral
import System
class Provider[T] {
    shared {
        public var Value T
        public var Calls int32
        public func Next() T {
            Calls += 1
            return Value
        }
    }
}
struct Inner[U] {
    STORAGE
    public func Read() U -> Handle
}
struct Outer[T] {
    private var Nested Inner[T] = INITIALIZER
    private var Items []int32
    public func Read() T -> Nested.Read()
    public func Length() int32 -> Items.Length
}
struct Envelope[T] {
    private var Nested Outer[T]
    private var Items []int32
    public func Read() T -> Nested.Read()
    public func Length() int32 -> Nested.Length()
}
func Main() {
    CONSTRUCTION
    Console.WriteLine(*item.Read())
    Console.WriteLine(item.Length())
    Console.WriteLine(Provider[readonly managed[int32]].Calls)
}`.Replace(
            "STORAGE",
            storage,
            StringComparison.Ordinal
        ).Replace(
            "INITIALIZER",
            initializer,
            StringComparison.Ordinal
        ).Replace("CONSTRUCTION", construction, StringComparison.Ordinal)

        private func InitializerFunctionSource(value string, construction string, reads string) string -> `package InitializerFunctionCache
import System
class Provider[T] {
    shared {
        public var Value T
        public var Calls int32
        public func Next() T {
            Calls += 1
            return Value
        }
    }
}
struct Holder[T] {
    private var Saved T = (func() T { return VALUE })()
    private var Items []int32
    public func Read() T -> Saved
    public func Length() int32 -> Items.Length
}
func Main() {
    CONSTRUCTION
    READS
}`.Replace(
            "VALUE",
            value,
            StringComparison.Ordinal
        ).Replace(
            "CONSTRUCTION",
            construction,
            StringComparison.Ordinal
        ).Replace("READS", reads, StringComparison.Ordinal)

        private func OverwrittenScalarSource(kind string, argument string, handle bool, construction string) string -> `package OverwrittenScalar
import System
class Provider[T] {
    shared {
        public var Value T
        public var Callback func(T) int32
        public var Calls int32
        public func Consume(value T) int32 {
            Calls += 1
            return Callback(value)
        }
    }
}
KIND Box[T](Value int32) {
    public var Marker int32 = Provider[T].Consume(ARGUMENT)
}
func Main() {
    SETUP
    let item = CONSTRUCTION
    Console.WriteLine(item.Value)
    Console.WriteLine(item.Marker)
    Console.WriteLine(Provider[TYPE].Calls)
}`.Replace(
            "KIND",
            kind,
            StringComparison.Ordinal
        ).Replace(
            "ARGUMENT",
            argument,
            StringComparison.Ordinal
        ).Replace(
            "SETUP",
            if handle {
                `var value = 11
Provider[readonly managed[int32]].Value = readonly managed(value)
Provider[readonly managed[int32]].Callback = (handle readonly managed[int32]) -> *handle`
            } else {
                "Provider[int32].Callback = (value int32) -> value"
            },
            StringComparison.Ordinal
        ).Replace(
            "CONSTRUCTION",
            construction,
            StringComparison.Ordinal
        ).Replace(
            "TYPE",
            if handle {
                "readonly managed[int32]"
            } else {
                "int32"
            },
            StringComparison.Ordinal
        )

        private func OverwrittenArraySource(
            kind string,
            length int32,
            initializeElements bool,
            construction string
        ) string -> `package OverwrittenArray
import System
class Provider[T] {
    shared {
        public var Value T
        public var Calls int32
        public func Next() T {
            Calls += 1
            return Value
        }
    }
}
KIND Box[T](Value int32) {
    public var Handles STORAGE_TYPE INITIALIZER
}
func Main() {
    var value = 11
    Provider[readonly managed[int32]].Value = readonly managed(value)
    let item = CONSTRUCTION
    Console.WriteLine(item.Value)
    Console.WriteLine(item.Handles.Length)
    Console.WriteLine(Provider[readonly managed[int32]].Calls)
}`
            .Replace("KIND", kind, StringComparison.Ordinal)
            .Replace(
            "STORAGE_TYPE",
            if length == 0 {
                "[]T"
            } else {
                "[$length]T"
            },
            StringComparison.Ordinal
        )
            .Replace(
            "INITIALIZER",
            if initializeElements {
                (
                    if length == 0 {
                        "= [0]T"
                    } else {
                        "= [$length]T{${string.Join(", ", Enumerable.Repeat("Provider[T].Next()", length))}}"
                    }
                )
            } else {
                string.Empty
            },
            StringComparison.Ordinal
        )
            .Replace("CONSTRUCTION", construction, StringComparison.Ordinal)

        private func RecursiveInitializerSource(value string, construction string, reads string) string -> `package RecursiveOwners
import System
class Provider[T] {
    shared {
        public var Value T
        public var Calls int32
        public func Next() T {
            Calls += 1
            return Value
        }
    }
}
class Node[T] {
    public var Next Node[T]? = Node[T].Recurse ? Node[T]{} : nil
    public var Saved T = VALUE
    shared { public var Recurse bool }
}
func Main() {
    Provider[int32].Value = 3
    var value = 11
    Provider[readonly managed[int32]].Value = readonly managed(value)
    CONSTRUCTION
    READS
}`.Replace(
            "VALUE",
            value,
            StringComparison.Ordinal
        ).Replace(
            "CONSTRUCTION",
            construction,
            StringComparison.Ordinal
        ).Replace("READS", reads, StringComparison.Ordinal)

        private func SharedChildInitializerSource(depth int32) string {
            let source = StringBuilder(`package SharedInitializerGraph
import System
class Flags {
    shared {
        public var Recurse bool
        public var Calls int32
        public func Next() int32 {
            Calls += 1
            return Calls
        }
    }
}
class Provider[T] { shared { public var Value T } }
class Node0[T] { public var Saved T = Provider[T].Value }
`)
            for var i = 1; i <= depth; i++ {
                source.AppendLine("class Node$i[T] {")
                source.AppendLine("public var First Node${i - 1}[T]? = Flags.Recurse ? Node${i - 1}[T]{} : nil")
                source.AppendLine("public var Second Node${i - 1}[T]? = Flags.Recurse ? Node${i - 1}[T]{} : nil")
                source.AppendLine("public var Marker int32 = Flags.Next()")
                source.AppendLine("}")
            }
            source.AppendLine("func Main() {")
            source.AppendLine("var value = 11")
            source.AppendLine("Provider[readonly managed[int32]].Value = readonly managed(value)")
            source.AppendLine("let item = Node$depth[readonly managed[int32]]{}")
            source.AppendLine("Console.WriteLine(item.First == nil && item.Second == nil)")
            source.AppendLine("Console.WriteLine(item.Marker)")
            source.AppendLine("Console.WriteLine(Flags.Calls)")
            source.AppendLine("}")
            return source.ToString()
        }

        private func TryCompileIsolated(fixture NativeSliceLanguageTests.Fixture, source string, name string)(
            Code int32,
            Output string
        ) {
            let sourcePath = Path.Combine(fixture.Directory, name + ".gs")
            File.WriteAllText(sourcePath, source)
            let start = ProcessStartInfo("dotnet"){
                WorkingDirectory = fixture.Directory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }
            start.ArgumentList.Add(
                Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "Compiler", "gsc.dll"))
            )
            start.ArgumentList.Add("/out:" + Path.Combine(fixture.Directory, name + ".dll"))
            start.ArgumentList.Add("/target:exe")
            start.ArgumentList.Add("/targetframework:net10.0")
            start.ArgumentList.Add(sourcePath)
            using let process Process? = Process.Start(start)
            Assert.NotNull(process)
            let output = process!!.StandardOutput.ReadToEndAsync()
            let error = process!!.StandardError.ReadToEndAsync()
            if !process!!.WaitForExit(30_000) {
                process!!.Kill(entireProcessTree: true)
                process!!.WaitForExit()
                Assert.Fail("isolated compiler witness timed out")
            }
            return (process!!.ExitCode, output.GetAwaiter().GetResult() + error.GetAwaiter().GetResult())
        }

        private func Reject(source string, anchor string, diagnostic string = "GS0604", isolated bool = false) {
            using let fixture = NativeSliceLanguageTests.Fixture()
            let (code, output) = if isolated {
                TryCompileIsolated(fixture, source, "RejectedRecord")
            } else {
                fixture.TryCompile(source, "RejectedRecord", true)
            }
            Assert.NotEqual(0, code)
            Assert.False(File.Exists(Path.Combine(fixture.Directory, "RejectedRecord.dll")), output)
            let offset = source.IndexOf(anchor, StringComparison.Ordinal)
            Assert.True(offset >= 0)
            AssertDiagnosticAt(source, offset, anchor, output, diagnostic)
            let diagnostics = output
                .Split('\n')
                .Where((line string) -> line.Contains(": error ", StringComparison.Ordinal))
                .ToArray()
            Assert.NotEmpty(diagnostics)
            Assert.All(
                diagnostics,
                (line string) -> Assert.Contains(": error $diagnostic:", line, StringComparison.Ordinal)
            )
        }

        private func AssertDiagnosticAt(source string, offset int32, anchor string, output string, diagnostic string) {
            let line = 1 + source[.. offset].Count((c char) -> c == '\n')
            let column = offset - source.LastIndexOf('\n', offset)
            Assert.True(
                output.Contains(
                    "($line,$column,$line,${column + anchor.Length}): error $diagnostic:",
                    StringComparison.Ordinal
                ),
                output
            )
        }
    }
}
