// <copyright file="Issue4675RecordSafetyAndPropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4675RecordSafetyAndPropertyEmitTests
{
    [Theory]
    [InlineData("data struct", false)]
    [InlineData("data class", false)]
    [InlineData("data struct", true)]
    [InlineData("data class", true)]
    public void ExplicitPositionalAutoProperty_RetainsPrivateReadonlyStorage(string kind, bool hasSetter)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package PositionalStorage
            import System
            KIND Box(Value int32) {
                public prop Value int32 { get; SETTER }
            }
            func Main() {
                let item = Box(7)
                Console.WriteLine(item.Value)
            }
            """.Replace("KIND", kind, StringComparison.Ordinal)
                .Replace("SETTER", hasSetter ? "init;" : string.Empty, StringComparison.Ordinal),
            "PositionalStorage", true);
        IlVerifier.Verify(dll);
        Assert.Equal("7\n", fixture.Run(dll));
        var type = Assembly.LoadFile(dll).GetType("PositionalStorage.Box", throwOnError: true);
        Assert.NotNull(type);
        var field = Assert.Single(type.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly));
        Assert.Equal("<Value>k__BackingField", field.Name);
        Assert.True(field.IsPrivate);
        Assert.Equal(!hasSetter, field.IsInitOnly);
        var property = type.GetProperty("Value");
        Assert.NotNull(property);
        Assert.NotNull(property.GetMethod);
        Assert.Equal(hasSetter, property.SetMethod != null);
    }

    [Theory]
    [InlineData("data struct", "Box{Items: {1}}")]
    [InlineData("data class", "Box{Items: {1}}")]
    [InlineData("data struct", "Box{Items: List[int32](), ...[]int32{1}}")]
    [InlineData("data class", "Box{Items: List[int32](), ...[]int32{1}}")]
    [InlineData("data struct", "Box{Items: List[int32](), 1}")]
    [InlineData("data class", "Box{Items: List[int32](), 1}")]
    [InlineData("data struct", "Box{Items: {1}, ...[]int32{2}}")]
    [InlineData("data class", "Box{Items: {1}, ...[]int32{2}}")]
    [InlineData("derived data class", "Box{Items: {1}}")]
    [InlineData("derived data class", "Box{Items: List[int32](), ...[]int32{1}}")]
    public void OrderedOmittedManagedArgument_IsRejectedAtTheLiteral(string kind, string literal)
    {
        var source = """
            package MissingOrderedHandle
            import System.Collections.Generic
            PARENT
            KIND Box(Handle readonly managed[int32]) BASE {
                public var Items List[int32] = List[int32]()
                public func Add(value int32) { Items.Add(value) }
            }
            func Main() { let box = LITERAL }
            """.Replace("PARENT", kind == "derived data class" ? "open class Parent(Saved readonly managed[int32])" : string.Empty, StringComparison.Ordinal)
                .Replace("KIND", kind == "derived data class" ? "data class" : kind, StringComparison.Ordinal)
                .Replace("BASE", kind == "derived data class" ? ": Parent(Handle)" : string.Empty, StringComparison.Ordinal)
                .Replace("LITERAL", literal, StringComparison.Ordinal);
        Reject(source, literal);
    }

    [Theory]
    [InlineData("Box", "var box Box")]
    [InlineData("Outer", "var box Outer")]
    [InlineData("Box[int32]", "var box Box[int32]")]
    public void BareZeroWithPrivateRequiredHandle_DoesNotCreditOrdinaryInitializers(string type, string declaration)
    {
        var generic = type.Contains("[", StringComparison.Ordinal);
        var source = """
            package RequiredZero
            data struct BoxGENERIC(Value PARAMETER) {
                private let Reference readonly managed[PARAMETER] = readonly managed(Value)
                private var Items []int32
                public func Read() PARAMETER -> *Reference
            }
            struct Outer { public var Inner Box }
            func Main() { DECLARATION }
            """.Replace("GENERIC", generic ? "[T]" : string.Empty, StringComparison.Ordinal)
                .Replace("PARAMETER", generic ? "T" : "int32", StringComparison.Ordinal)
                .Replace("struct Outer { public var Inner Box }", generic ? string.Empty : "struct Outer { public var Inner Box }", StringComparison.Ordinal)
                .Replace("DECLARATION", declaration, StringComparison.Ordinal);
        Reject(source, declaration);
    }

    [Fact]
    public void BarePositionalHandleProperty_IsAlsoRequired()
    {
        Reject("""
            package RequiredZeroProperty
            data struct Box(Handle readonly managed[int32]) { public var Items []int32 }
            func Main() { var box Box }
            """, "var box Box");
    }

    [Fact]
    public void BareGlobalZero_DoesNotCreditThePrimaryInitializer()
    {
        Reject("""
            package RequiredGlobalZero
            data struct Box(Value int32) {
                private let Reference readonly managed[int32] = readonly managed(Value)
                private var Items []int32
            }
            var global Box
            func Main() { }
            """, "var global Box");
    }

    [Theory]
    [InlineData("data struct")]
    [InlineData("data class")]
    public void ExplicitPrimaryStillInitializesPrivateHandlesOnce(string kind)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package ExplicitRequiredHandle
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
            }
            """.Replace("KIND", kind, StringComparison.Ordinal), "ExplicitRequiredHandle", true);
        IlVerifier.Verify(dll);
        Assert.Equal("7\n0\n1\n1\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void OrdinaryStructZero_StillUsesItsValidatedInitializerConstructor(bool nested)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package OrdinaryRequiredHandle
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
            }
            """.Replace("DECLARATION", nested ? "var outer Outer" : "var item Ordinary", StringComparison.Ordinal)
                .Replace("RECEIVER", nested ? "outer.Inner" : "item", StringComparison.Ordinal), "OrdinaryRequiredHandle", true);
        IlVerifier.Verify(dll);
        Assert.Equal("7\n0\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public void HiddenAndInheritedNonpositionalProperties_BindTheirActualConstructedOwner(bool generic, bool inherited)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var contract = fixture.CompileCSharp("""
            using System;
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
            }
            """, "PropertyContract");
        var source = """
            package PropertyTreeIdentity
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
            }
            """.Replace("GENERIC", generic ? "[T]" : string.Empty, StringComparison.Ordinal)
                .Replace("BASEARG", generic ? "[string]" : string.Empty, StringComparison.Ordinal)
                .Replace("BASETYPE", generic ? "T" : "string", StringComparison.Ordinal)
                .Replace("TYPEARG", generic ? "[int64]" : string.Empty, StringComparison.Ordinal)
                .Replace("OWN", inherited ? string.Empty : "public prop Extra " + (generic ? "T" : "int32") + " { get; init; }", StringComparison.Ordinal)
                .Replace("EXTRATYPE", inherited ? "string" : generic ? "int64" : "int32", StringComparison.Ordinal)
                .Replace("DECLARING", inherited ? generic ? "Base[string]" : "Base" : generic ? "Child[int64]" : "Child", StringComparison.Ordinal)
                .Replace("ASSIGNED", inherited ? "\"inherited\"" : generic ? "int64(2)" : "2", StringComparison.Ordinal);
        var dll = fixture.Compile(source, "PropertyTreeIdentity", true, "/r:" + contract);
        IlVerifier.Verify(dll, additionalReferences: new[] { contract });
        Assert.Equal(inherited ? "1\ninherited\ninherited\nidentity\n" : "1\n2\n2\nidentity\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData("class", false)]
    [InlineData("struct", false)]
    [InlineData("class", true)]
    [InlineData("struct", true)]
    public void ConstrainedPropertySelector_UsesTheActualInterfaceOwner(string kind, bool inherited)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package ConstrainedPropertyTree
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
            }
            """.Replace("KIND", kind, StringComparison.Ordinal)
                .Replace("CONSTRAINT", inherited ? "IChild" : "IValue", StringComparison.Ordinal), "ConstrainedPropertyTree", true);
        IlVerifier.Verify(dll);
        Assert.Equal("7\nTrue\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData("data class", false)]
    [InlineData("data struct", false)]
    [InlineData("data class", true)]
    [InlineData("data struct", true)]
    public void ConstructedConstrainedSelector_RetainsTheSubstitutedInterfaceOwner(string kind, bool inherited)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package ConstructedConstrainedPropertyTree
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
            }
            """.Replace("KIND", kind, StringComparison.Ordinal)
                .Replace("CONSTRAINT", inherited ? "IChild" : "IValue", StringComparison.Ordinal), "ConstructedConstrainedPropertyTree", true);
        IlVerifier.Verify(dll);
        Assert.Equal("7\n7\n7\nTrue\nTrue\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData("private", "")]
    [InlineData("public", "private var Extra []int32")]
    [InlineData("public", "")]
    public void DataZeroHelper_AnalyzesItsActualNestedConstructorValues(string visibility, string sibling)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package NestedRequiredZero
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
            }
            """.Replace("VISIBILITY", visibility, StringComparison.Ordinal)
                .Replace("SIBLING", sibling, StringComparison.Ordinal), "NestedRequiredZero", true);
        IlVerifier.Verify(dll);
        Assert.Equal("7\n0\n0\n0\n1\n0\n", fixture.Run(dll));
    }

    [Fact]
    public void DataZeroHelper_DoesNotCreditANestedInitializerWithoutAZeroValue()
    {
        Reject("""
            package MissingNestedRequiredZero
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
            func Main() { var outer Outer }
            """, "var outer Outer");
    }

    [Theory]
    [InlineData("direct", false)]
    [InlineData("nested", false)]
    [InlineData("global", false)]
    [InlineData("direct", true)]
    public void ConstructedPropertyStorage_RejectsActualRequiredHandleZeros(string scope, bool ordinaryProperty)
    {
        var declaration = scope == "nested"
            ? "var box Outer"
            : "var box Box[readonly managed[int32]]";
        var source = """
            package ConstructedRequiredZero
            data struct Box[T](PRIMARY) {
                PROPERTY
                private var Items []int32
            }
            struct Outer { public var Inner Box[readonly managed[int32]] }
            GLOBAL
            func Main() { LOCAL }
            """.Replace("PRIMARY", ordinaryProperty ? "Value int32" : "Handle T", StringComparison.Ordinal)
                .Replace("PROPERTY", ordinaryProperty ? "public prop Handle T { get; init; }" : string.Empty, StringComparison.Ordinal)
                .Replace("GLOBAL", scope == "global" ? declaration : string.Empty, StringComparison.Ordinal)
                .Replace("LOCAL", scope == "global" ? string.Empty : declaration, StringComparison.Ordinal);
        Reject(source, declaration);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ConstructedPropertyStorage_RetainsZeroAndExplicitArgumentControls(bool managed)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package ConstructedRequiredControl
            import System
            data struct Box[T](Handle T) {
                private var Items []int32
                public func Length() int32 -> Items.Length
            }
            func Main() {
                CONSTRUCT
                Console.WriteLine(READ)
                Console.WriteLine(box.Length())
            }
            """.Replace("CONSTRUCT", managed
                    ? "var value = 7\nlet box = Box[readonly managed[int32]]{Handle: readonly managed(value)}"
                    : "var box Box[int32]", StringComparison.Ordinal)
                .Replace("READ", managed ? "*box.Handle" : "box.Handle", StringComparison.Ordinal), "ConstructedRequiredControl", true);
        IlVerifier.Verify(dll);
        Assert.Equal(managed ? "7\n0\n" : "0\n0\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void PositionalNestedStorage_IsNotAnInTypeZeroField(bool generic)
    {
        Reject("""
            package PositionalNestedZero
            struct Inner {
                private let Reference readonly managed[int32] = {
                    var value = 7
                    readonly managed(value)
                }
                private var Items []int32
            }
            data struct OuterGENERIC(Nested PARAMETER) { private var Items []int32 }
            func Main() { DECLARATION }
            """.Replace("GENERIC", generic ? "[T]" : string.Empty, StringComparison.Ordinal)
                .Replace("PARAMETER", generic ? "T" : "Inner", StringComparison.Ordinal)
                .Replace("DECLARATION", generic ? "var outer Outer[Inner]" : "var outer Outer", StringComparison.Ordinal),
            generic ? "var outer Outer[Inner]" : "var outer Outer");
    }

    [Fact]
    public void PositionalNestedStorage_ExplicitPrimaryArgumentRemainsInitialized()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package ExplicitPositionalNested
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
            }
            """, "ExplicitPositionalNested", true);
        IlVerifier.Verify(dll);
        Assert.Equal("7\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void DataZeroHelper_DoesNotCreditStorageAbsentFromItsDefinition(bool genericField)
    {
        Reject("""
            package DefinitionOwnedZero
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
            func Main() { DECLARATION }
            """.Replace("GENERIC", genericField ? "[T]" : string.Empty, StringComparison.Ordinal)
                .Replace("STORAGE", genericField ? "private var Nested T" : "public prop Nested Inner { get; init; }", StringComparison.Ordinal)
                .Replace("DECLARATION", genericField ? "var outer Outer[Inner]" : "var outer Outer", StringComparison.Ordinal),
            genericField ? "var outer Outer[Inner]" : "var outer Outer");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ConstructedOrdinaryZero_RetainsItsValidatedDefinitionConstructor(bool nested)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package ConstructedOrdinaryZero
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
            }
            """.Replace("DECLARATION", nested ? "var item Outer" : "var item Inner[int32]", StringComparison.Ordinal),
            "ConstructedOrdinaryZero", true);
        IlVerifier.Verify(dll);
        Assert.Equal("7\n0\n1\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData("public var Handle T")]
    [InlineData("public prop Handle T { get; init; }")]
    public void ConstructedOrdinaryZero_DoesNotCreditANewlyRequiredSlot(string storage)
    {
        Reject("""
            package ConstructedOrdinaryRequiredZero
            struct Box[T] {
                STORAGE
                private var Items []int32
            }
            func Main() { var box Box[readonly managed[int32]] }
            """.Replace("STORAGE", storage, StringComparison.Ordinal),
            "var box Box[readonly managed[int32]]");
    }

    [Theory]
    [InlineData("data struct")]
    [InlineData("data class")]
    public void StagedExpressionTreeArgument_RetainsItsRequiredQuote(string kind)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package QuotedRecordArgument
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
            }
            """.Replace("KIND", kind, StringComparison.Ordinal), "QuotedRecordArgument", true);
        IlVerifier.Verify(dll);
        Assert.Equal("42\nTrue\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void ClosedGenericZero_RetainsValuesNotWrittenByTheDefinitionConstructor(bool explicitConstruction, bool privateCollection)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package RetainedGenericZero
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
            }
            """.Replace("COLLECTION", privateCollection ? "private var Items []int32" : string.Empty, StringComparison.Ordinal)
                .Replace("CONSTRUCT", explicitConstruction ? "let outer = Outer[Inner]{Value: 7, Nested: Inner{}}" : "var outer Outer[Inner]", StringComparison.Ordinal),
            "RetainedGenericZero", true);
        IlVerifier.Verify(dll);
        Assert.Equal(explicitConstruction ? "0\n7\n1\n1\n" : "0\n0\n0\n0\n", fixture.Run(dll));
    }

    [Fact]
    public void ClosedGenericZero_RetainedRequiredChildUsesItsValidatedConstructor()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package RetainedRequiredChild
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
            }
            """, "RetainedRequiredChild", true);
        IlVerifier.Verify(dll);
        Assert.Equal("7\n0\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void PrivateClosedGenericZero_RejectsAChildWithoutAnInTypeStore(bool privateCollection, bool nested)
    {
        var declaration = nested ? "var outer Envelope" : "var outer Outer[Inner]";
        Reject(
            PrivateClosedZeroSource(privateCollection, "T", declaration)
                .Replace("outer.Read().Items.Length", nested ? "outer.Read().Read().Items.Length" : "outer.Read().Items.Length", StringComparison.Ordinal),
            declaration,
            "GS0472");
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void PrivateClosedGenericZero_RetainsActualDefinitionStores(bool privateCollection, bool explicitConstruction)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(
            PrivateClosedZeroSource(privateCollection, "Inner", explicitConstruction
                ? "let outer = Outer[Inner]{Value: 7}"
                : "var outer Outer[Inner]"),
            "PrivateClosedZero", true);
        IlVerifier.Verify(dll);
        Assert.Equal(explicitConstruction ? "0\n7\n1\n1\n" : "0\n0\n0\n0\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void OrdinaryGenericScalar_RetainsActualConstructedInitializer(bool nested, bool handle)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var type = handle ? "readonly managed[int32]" : "int32";
        var construction = """
            var value = 7
            Provider[TYPE].Value = VALUE
            var item CONTAINER[TYPE]
            """.Replace("TYPE", type, StringComparison.Ordinal)
                .Replace("VALUE", handle ? "readonly managed(value)" : "value", StringComparison.Ordinal)
                .Replace("CONTAINER", nested ? "Outer" : "Holder", StringComparison.Ordinal);
        var dll = fixture.Compile(
            OrdinaryGenericScalarSource(construction, " = Provider[T].Next()", type, handle),
            "OrdinaryGenericScalar", true);
        IlVerifier.Verify(dll);
        Assert.Equal("7\n1\n0\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData(false, "")]
    [InlineData(true, "")]
    [InlineData(false, " = default(T)")]
    [InlineData(true, " = default(T)")]
    public void OrdinaryGenericScalar_RejectsAbsentOrDefaultConstructedInitializer(bool nested, string initializer)
    {
        var declaration = nested ? "var item Outer[readonly managed[int32]]" : "var item Holder[readonly managed[int32]]";
        Reject(OrdinaryGenericScalarSource(declaration, initializer, "readonly managed[int32]", true), declaration);
    }

    private static string OrdinaryGenericScalarSource(string construction, string initializer, string type, bool handle)
        => """
            package OrdinaryGenericScalar
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
            }
            """.Replace("INITIALIZER", initializer, StringComparison.Ordinal)
                .Replace("CONSTRUCTION", construction, StringComparison.Ordinal)
                .Replace("DEREFERENCE", handle ? "*" : "", StringComparison.Ordinal)
                .Replace("TYPE", type, StringComparison.Ordinal);

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void OrdinaryZeroConstructor_DoesNotCreditUnwrittenRequiredProperty(bool nested)
    {
        var declaration = nested ? "var item Outer" : "var item Holder";
        Reject(OrdinaryUnwrittenPropertySource(declaration), declaration);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void OrdinaryRequiredProperty_ExplicitInTypeInitializationRemainsValid(bool nested)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var construction = nested ? "let item = Outer{Nested: Holder.Create(7)}" : "let item = Holder.Create(7)";
        var source = OrdinaryUnwrittenPropertySource(construction)
            .Replace("public var Nested Holder", "public var Nested Holder = Holder.Create(7)", StringComparison.Ordinal);
        var dll = fixture.Compile(source, "OrdinaryRequiredProperty", true);
        IlVerifier.Verify(dll);
        Assert.Equal("7\n0\n", fixture.Run(dll));
    }

    private static string OrdinaryUnwrittenPropertySource(string construction)
        => """
            package OrdinaryRequiredProperty
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
            }
            """.Replace("CONSTRUCTION", construction, StringComparison.Ordinal);

    [Theory]
    [InlineData(1, false)]
    [InlineData(1, true)]
    [InlineData(2, false)]
    [InlineData(2, true)]
    public void PrivateFixedHandleArrayZero_RejectsUnsuppliedElements(int length, bool nested)
    {
        const string declaration = "var box Box";
        Reject(PrivateFixedHandleArraySource(length, declaration, nested), declaration);
    }

    [Theory]
    [InlineData(1, false)]
    [InlineData(1, true)]
    [InlineData(2, false)]
    [InlineData(2, true)]
    public void PrivateFixedHandleArrayZero_ExplicitPrimaryInitializationRemainsValid(int length, bool nested)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        const string construction = "let box = Box{Value: 7}";
        var dll = fixture.Compile(
            PrivateFixedHandleArraySource(length, construction, nested),
            "PrivateFixedHandleArray", true);
        IlVerifier.Verify(dll);
        Assert.Equal($"7\n{length}\n1\n1\n", fixture.Run(dll));
    }

    private static string PrivateClosedZeroSource(bool privateCollection, string fieldType, string construction)
        => """
            package PrivateClosedZero
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
            }
            """.Replace("FIELD_TYPE", fieldType, StringComparison.Ordinal)
                .Replace("COLLECTION", privateCollection ? "private var Items []int32" : string.Empty, StringComparison.Ordinal)
                .Replace("ENVELOPE", construction == "var outer Envelope" ? """
                    struct Envelope {
                        public var Nested Outer[Inner]
                        public func Read() Outer[Inner] -> Nested
                    }
                    """ : string.Empty, StringComparison.Ordinal)
                .Replace("CONSTRUCTION", construction, StringComparison.Ordinal)
                .Replace("Console.WriteLine(outer.Value)", construction == "var outer Envelope" ? string.Empty : "Console.WriteLine(outer.Value)", StringComparison.Ordinal)
                .Replace("Console.WriteLine(outer.Mark())", construction == "var outer Envelope" ? string.Empty : "Console.WriteLine(outer.Mark())", StringComparison.Ordinal);

    private static string PrivateFixedHandleArraySource(int length, string construction, bool nested)
        => """
            package PrivateFixedHandleArray
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
            }
            """.Replace("LENGTH", length.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal)
                .Replace("ELEMENT_DECLARATION", nested ? "data struct Element(Handle readonly managed[int32]) { public func Read() int32 -> *Handle }" : string.Empty, StringComparison.Ordinal)
                .Replace("ELEMENT_TYPE", nested ? "Element" : "readonly managed[int32]", StringComparison.Ordinal)
                .Replace("ELEMENTS", string.Join(", ", Enumerable.Repeat(nested ? "Element{Handle: readonly managed(Value)}" : "readonly managed(Value)", length)), StringComparison.Ordinal)
                .Replace("CONSTRUCTION", construction, StringComparison.Ordinal)
                .Replace("READ", nested ? "Handles[0].Read()" : "*Handles[0]", StringComparison.Ordinal);

    [Theory]
    [InlineData("struct", "public var Extra T", false)]
    [InlineData("struct", "public var Extra T", true)]
    [InlineData("struct", "public prop Extra T { get; init; }", false)]
    [InlineData("struct", "public prop Extra T { get; init; }", true)]
    [InlineData("data struct", "public var Extra T", false)]
    [InlineData("data struct", "public var Extra T", true)]
    [InlineData("data struct", "public prop Extra T { get; init; }", false)]
    [InlineData("data struct", "public prop Extra T { get; init; }", true)]
    public void NestedConstructedInitializer_DoesNotCreditANewlyRequiredChildSlot(string kind, string storage, bool publicNested)
    {
        Reject(
            NestedConstructorSource(kind, storage, publicNested, "var outer Outer[readonly managed[int32]]", "*"),
            "var outer Outer[readonly managed[int32]]");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void NestedConstructedInitializer_RecursesThroughMultipleConstructorValues(bool publicNested)
    {
        var source = NestedConstructorSource("struct", "public var Extra T", publicNested, "var outer Envelope[readonly managed[int32]]", "*")
            .Replace("func Main()", """
                struct Envelope[T] {
                    private var Nested Outer[T]
                    public func Read() int32 -> Nested.Read()
                    public func Extra() T -> Nested.Extra()
                    public func Length() int32 -> Nested.Length()
                }
                func Main()
                """, StringComparison.Ordinal);
        Reject(source, "var outer Envelope[readonly managed[int32]]");
    }

    [Theory]
    [InlineData("public var Extra T", false)]
    [InlineData("public var Extra T", true)]
    [InlineData("public prop Extra T { get; init; }", false)]
    [InlineData("public prop Extra T { get; init; }", true)]
    public void NestedConstructedInitializer_RetainsItsValidatedHandleAndValueZero(string storage, bool publicNested)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(
            NestedConstructorSource("struct", storage, publicNested, "var outer Outer[int32]", string.Empty),
            "NestedConstructorCredit", true);
        IlVerifier.Verify(dll);
        Assert.Equal("7\n0\n0\n1\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData("public var Extra T")]
    [InlineData("public prop Extra T { get; init; }")]
    public void NestedConstructedInitializer_ExplicitSuppliedHandleRemainsValid(string storage)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(
            NestedConstructorSource("struct", storage, true, """
                var value = 11
                let supplied = Inner[readonly managed[int32]]{Extra: readonly managed(value)}
                let outer = Outer[readonly managed[int32]]{Nested: supplied}
                """, "*"),
            "NestedConstructorCredit", true);
        IlVerifier.Verify(dll);
        Assert.Equal("7\n11\n0\n2\n", fixture.Run(dll));
    }

    private static string NestedConstructorSource(string kind, string storage, bool publicNested, string construction, string dereference)
        => """
            package NestedConstructorCredit
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
            }
            """.Replace("KIND", kind, StringComparison.Ordinal)
                .Replace("PRIMARY", kind == "data struct" ? "(Value int32)" : string.Empty, StringComparison.Ordinal)
                .Replace("STORAGE", storage, StringComparison.Ordinal)
                .Replace("VISIBILITY", publicNested ? "public" : "private", StringComparison.Ordinal)
                .Replace("SIBLING", publicNested ? "private var Items []int32" : string.Empty, StringComparison.Ordinal)
                .Replace("CONSTRUCTION", construction, StringComparison.Ordinal)
                .Replace("DEREFERENCE", dereference, StringComparison.Ordinal);

    private static void Reject(string source, string anchor, string diagnostic = "GS0604")
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile(source, "RejectedRecord", true);
        Assert.NotEqual(0, code);
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "RejectedRecord.dll")), output);
        var offset = source.IndexOf(anchor, StringComparison.Ordinal);
        Assert.True(offset >= 0);
        var line = 1 + source[..offset].Count(c => c == '\n');
        var column = offset - source.LastIndexOf('\n', offset);
        Assert.Contains($"({line},{column},{line},{column + anchor.Length}): error {diagnostic}:", output, StringComparison.Ordinal);
        var diagnostics = output.Split('\n').Where(line => line.Contains(": error ", StringComparison.Ordinal)).ToArray();
        Assert.NotEmpty(diagnostics);
        Assert.All(diagnostics, line => Assert.Contains($": error {diagnostic}:", line, StringComparison.Ordinal));
    }
}
