// <copyright file="Issue4675RecordSafetyAndPropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4675RecordSafetyAndPropertyEmitTests
{
    [Fact]
    public void SetterOnlyPositionalReplacement_ReportsDeclarationDiagnostic()
    {
        const string source = """
            package PositionalReplacement
            data struct Item(Value int32) {
                public prop Value int32 { set(v) { } }
            }
            """;
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile(source, "PositionalReplacement", true);
        Assert.NotEqual(0, code);
        Assert.Contains("(3,17,3,22): error GS0621:", output, StringComparison.Ordinal);
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal);
    }

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

    [Theory]
    [InlineData("public prop Handle U { get; init; }", false)]
    [InlineData("public prop Handle U { get; init; }", true)]
    [InlineData("public prop Handle U { get; set; }", false)]
    [InlineData("public prop Handle U { get; set; }", true)]
    [InlineData("private var Handle U = default(U)", false)]
    [InlineData("private var Handle U = default(U)", true)]
    [InlineData("public var Handle U = default(U)", false)]
    [InlineData("public var Handle U = default(U)", true)]
    public void NestedExplicitLiteral_RejectsUninitializedConstructedStorage(string storage, bool nested)
    {
        var declaration = nested ? "var item Envelope[readonly managed[int32]]" : "var item Outer[readonly managed[int32]]";
        Reject(NestedExplicitLiteralSource(storage, "Inner[T]{}", declaration), declaration);
    }

    [Theory]
    [InlineData("private var Handle U = Provider[U].Next()", "Inner[T]{}", false)]
    [InlineData("private var Handle U = Provider[U].Next()", "Inner[T]{}", true)]
    [InlineData("public var Handle U", "Inner[T]{Handle: Provider[T].Next()}", false)]
    [InlineData("public var Handle U", "Inner[T]{Handle: Provider[T].Next()}", true)]
    [InlineData("public prop Handle U { get; init; }", "Inner[T]{Handle: Provider[T].Next()}", false)]
    [InlineData("public prop Handle U { get; init; }", "Inner[T]{Handle: Provider[T].Next()}", true)]
    [InlineData("public prop Handle U { get; set; }", "Inner[T]{Handle: Provider[T].Next()}", false)]
    [InlineData("public prop Handle U { get; set; }", "Inner[T]{Handle: Provider[T].Next()}", true)]
    public void NestedExplicitLiteral_RetainsActualInitializerAndSuppliedStorage(string storage, string initializer, bool nested)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var construction = """
            var value = 7
            Provider[readonly managed[int32]].Value = readonly managed(value)
            var item CONTAINER[readonly managed[int32]]
            """.Replace("CONTAINER", nested ? "Envelope" : "Outer", StringComparison.Ordinal);
        var dll = fixture.Compile(NestedExplicitLiteralSource(storage, initializer, construction), "NestedExplicitLiteral", true);
        IlVerifier.Verify(dll);
        Assert.Equal("7\n0\n1\n", fixture.Run(dll));
    }

    private static string NestedExplicitLiteralSource(string storage, string initializer, string construction)
        => """
            package NestedExplicitLiteral
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
            }
            """.Replace("STORAGE", storage, StringComparison.Ordinal)
                .Replace("INITIALIZER", initializer, StringComparison.Ordinal)
                .Replace("CONSTRUCTION", construction, StringComparison.Ordinal);

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void InitializerFunctionCache_RejectsUnsafeConstructionRegardlessOfVisitOrder(bool safeFirst)
    {
        const string safe = "var safe Holder[int32]";
        const string invalid = "var invalid Holder[readonly managed[int32]]";
        Reject(InitializerFunctionSource(
            "default(T)",
            safeFirst ? safe + "\n" + invalid : invalid + "\n" + safe,
            "Console.WriteLine(*invalid.Read())"), invalid);
    }

    [Fact]
    public void InitializerFunctionCache_RetainsIndependentConstructedProviderValues()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(InitializerFunctionSource(
            "Provider[T].Next()",
            """
            Provider[int32].Value = 3
            var safe Holder[int32]
            var value = 7
            Provider[readonly managed[int32]].Value = readonly managed(value)
            var item Holder[readonly managed[int32]]
            """,
            """
            Console.WriteLine(safe.Read())
            Console.WriteLine(*item.Read())
            Console.WriteLine(safe.Length() + item.Length())
            Console.WriteLine(Provider[int32].Calls)
            Console.WriteLine(Provider[readonly managed[int32]].Calls)
            """), "InitializerFunctionCache", true);
        IlVerifier.Verify(dll);
        Assert.Equal("3\n7\n0\n1\n1\n", fixture.Run(dll));
    }

    private static string InitializerFunctionSource(string value, string construction, string reads)
        => """
            package InitializerFunctionCache
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
            }
            """.Replace("VALUE", value, StringComparison.Ordinal)
                .Replace("CONSTRUCTION", construction, StringComparison.Ordinal)
                .Replace("READS", reads, StringComparison.Ordinal);

    [Theory]
    [InlineData("data struct")]
    [InlineData("data class")]
    public void ConstructorInitializerExecution_RejectsUnsafeOverwrittenScalar(string kind)
    {
        const string construction = "Box[readonly managed[int32]]{Value: 7, Marker: 42}";
        Reject(OverwrittenScalarSource(kind, "default(T)", true, construction), construction);
    }

    [Theory]
    [InlineData("data struct", false)]
    [InlineData("data class", false)]
    [InlineData("data struct", true)]
    [InlineData("data class", true)]
    public void ConstructorInitializerExecution_RetainsSafeOverwrittenScalarOnce(string kind, bool handle)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var construction = $"Box[{(handle ? "readonly managed[int32]" : "int32")}]{{Value: 7, Marker: 42}}";
        var dll = fixture.Compile(
            OverwrittenScalarSource(kind, handle ? "Provider[T].Value" : "default(T)", handle, construction),
            "OverwrittenScalar", true);
        IlVerifier.Verify(dll);
        Assert.Equal("7\n42\n1\n", fixture.Run(dll));
    }

    private static string OverwrittenScalarSource(string kind, string argument, bool handle, string construction)
        => """
            package OverwrittenScalar
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
            }
            """.Replace("KIND", kind, StringComparison.Ordinal)
                .Replace("ARGUMENT", argument, StringComparison.Ordinal)
                .Replace("SETUP", handle
                    ? """
                        var value = 11
                        Provider[readonly managed[int32]].Value = readonly managed(value)
                        Provider[readonly managed[int32]].Callback = (handle readonly managed[int32]) -> *handle
                        """
                    : "Provider[int32].Callback = (value int32) -> value", StringComparison.Ordinal)
                .Replace("CONSTRUCTION", construction, StringComparison.Ordinal)
                .Replace("TYPE", handle ? "readonly managed[int32]" : "int32", StringComparison.Ordinal);

    [Theory]
    [InlineData("data struct", 1)]
    [InlineData("data class", 1)]
    [InlineData("data struct", 2)]
    [InlineData("data class", 2)]
    public void ConstructorInitializerExecution_RejectsOverwrittenArrayElementZeros(string kind, int length)
    {
        var construction = $"Box[readonly managed[int32]]{{Value: 7, Handles: [{length}]readonly managed[int32]{{{string.Join(", ", Enumerable.Repeat("readonly managed(value)", length))}}}}}";
        Reject(OverwrittenArraySource(kind, length, false, construction), construction);
    }

    [Theory]
    [InlineData("data struct", 0)]
    [InlineData("data class", 0)]
    [InlineData("data struct", 1)]
    [InlineData("data class", 1)]
    public void ConstructorInitializerExecution_RetainsSafeOverwrittenArraysOnce(string kind, int length)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var values = length == 0
            ? "[0]readonly managed[int32]"
            : "[1]readonly managed[int32]{readonly managed(value)}";
        var construction = $"Box[readonly managed[int32]]{{Value: 7, Handles: {values}}}";
        var dll = fixture.Compile(OverwrittenArraySource(kind, length, true, construction), "OverwrittenArray", true);
        IlVerifier.Verify(dll);
        Assert.Equal($"7\n{length}\n{length}\n", fixture.Run(dll));
    }

    private static string OverwrittenArraySource(string kind, int length, bool initializeElements, string construction)
        => """
            package OverwrittenArray
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
            }
            """.Replace("KIND", kind, StringComparison.Ordinal)
                .Replace("STORAGE_TYPE", length == 0 ? "[]T" : $"[{length}]T", StringComparison.Ordinal)
                .Replace("INITIALIZER", initializeElements
                    ? length == 0 ? "= [0]T" : $"= [{length}]T{{{string.Join(", ", Enumerable.Repeat("Provider[T].Next()", length))}}}"
                    : string.Empty, StringComparison.Ordinal)
                .Replace("CONSTRUCTION", construction, StringComparison.Ordinal);

    [Fact]
    public void ConstructorInitializerRecursion_ConditionalClassConstructionTerminates()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        const string source = """
            package ConditionalNode
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
            }
            """;
        var (code, output) = TryCompileIsolated(fixture, source, "ConditionalNode");
        Assert.True(code == 0, output);
        var dll = Path.Combine(fixture.Directory, "ConditionalNode.dll");
        IlVerifier.Verify(dll);
        Assert.Equal("True\n1\n1\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ConstructorInitializerRecursion_DistinctConstructedOwnersRemainValid(bool safeFirst)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        const string scalar = "let scalar = Node[int32]{}";
        const string handle = "let handle = Node[readonly managed[int32]]{}";
        var source = RecursiveInitializerSource(
            "Provider[T].Next()", safeFirst ? scalar + "\n" + handle : handle + "\n" + scalar,
            """
            Console.WriteLine(scalar.Saved)
            Console.WriteLine(*handle.Saved)
            Console.WriteLine(scalar.Next == nil && handle.Next == nil)
            Console.WriteLine(Provider[int32].Calls)
            Console.WriteLine(Provider[readonly managed[int32]].Calls)
            """);
        var (code, output) = TryCompileIsolated(fixture, source, "RecursiveOwners");
        Assert.True(code == 0, output);
        var dll = Path.Combine(fixture.Directory, "RecursiveOwners.dll");
        IlVerifier.Verify(dll);
        Assert.Equal("3\n11\nTrue\n1\n1\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ConstructorInitializerRecursion_DoesNotHideUnsafeLaterFields(bool safeFirst)
    {
        const string scalar = "let scalar = Node[int32]{}";
        const string handle = "let handle = Node[readonly managed[int32]]{}";
        Reject(RecursiveInitializerSource(
            "default(T)", safeFirst ? scalar + "\n" + handle : handle + "\n" + scalar, string.Empty),
            "Node[readonly managed[int32]]{}", isolated: true);
    }

    private static string RecursiveInitializerSource(string value, string construction, string reads)
        => """
            package RecursiveOwners
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
            }
            """.Replace("VALUE", value, StringComparison.Ordinal)
                .Replace("CONSTRUCTION", construction, StringComparison.Ordinal)
                .Replace("READS", reads, StringComparison.Ordinal);

    [Theory]
    [InlineData("public var Extra T")]
    [InlineData("public prop Extra T { get; init; }")]
    public void ConstructorInitializerRecursion_RechecksLaterResultConsumption(string storage)
    {
        const string invalid = "Outer[readonly managed[int32]](0)";
        Reject(NestedConstructorSource("data struct", storage, true, """
            var value = 11
            let supplied = Inner[readonly managed[int32]]{Extra: readonly managed(value)}
            let outer = Outer[readonly managed[int32]]{Nested: supplied}
            let invalid = Outer[readonly managed[int32]](0)
            """, "*"), invalid);
    }

    [Theory]
    [InlineData("[]T")]
    [InlineData("Node[T]")]
    public void ConstructorInitializerValidation_RejectsExpandingOwnersWithoutCrashing(string argument)
    {
        Reject("""
            package ExpandingOwners
            class Flags { shared { public var Recurse bool } }
            class Node[T] {
                public var Next Node[ARGUMENT]? = Flags.Recurse ? Node[ARGUMENT]{} : nil
            }
            func Main() { let item = Node[int32]{} }
            """.Replace("ARGUMENT", argument, StringComparison.Ordinal), "Node[int32]{}", isolated: true);
    }

    [Theory]
    [InlineData(8)]
    [InlineData(29)]
    [InlineData(63)]
    public void ConstructorInitializerValidation_SharedChildGraphCompilesWithinTimeout(int depth)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = TryCompileIsolated(fixture, SharedChildInitializerSource(depth), "SharedInitializerGraph");
        Assert.True(code == 0, output);
        var dll = Path.Combine(fixture.Directory, "SharedInitializerGraph.dll");
        IlVerifier.Verify(dll);
        Assert.Equal("True\n1\n1\n", fixture.Run(dll));
    }

    [Fact]
    public void ConstructorInitializerValidation_RejectsTheFirstUnsupportedInitializerDepth()
    {
        const string anchor = "Node64[readonly managed[int32]]{}";
        var source = SharedChildInitializerSource(64);
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = TryCompileIsolated(fixture, source, "InitializerDepth");
        Assert.True(code == 1, output);
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "InitializerDepth.dll")), output);
        AssertDiagnosticAt(source, source.IndexOf(anchor, StringComparison.Ordinal), anchor, output, "GS0604");
        Assert.Contains("supported recursion depth of 64", output, StringComparison.Ordinal);
    }

    private static string SharedChildInitializerSource(int depth)
    {
        var source = new StringBuilder("""
            package SharedInitializerGraph
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

            """);
        for (var i = 1; i <= depth; i++)
        {
            source.AppendLine($"class Node{i}[T] {{");
            source.AppendLine($"public var First Node{i - 1}[T]? = Flags.Recurse ? Node{i - 1}[T]{{}} : nil");
            source.AppendLine($"public var Second Node{i - 1}[T]? = Flags.Recurse ? Node{i - 1}[T]{{}} : nil");
            source.AppendLine("public var Marker int32 = Flags.Next()");
            source.AppendLine("}");
        }

        source.AppendLine("func Main() {");
        source.AppendLine("var value = 11");
        source.AppendLine("Provider[readonly managed[int32]].Value = readonly managed(value)");
        source.AppendLine($"let item = Node{depth}[readonly managed[int32]]{{}}");
        source.AppendLine("Console.WriteLine(item.First == nil && item.Second == nil)");
        source.AppendLine("Console.WriteLine(item.Marker)");
        source.AppendLine("Console.WriteLine(Flags.Calls)");
        source.AppendLine("}");
        return source.ToString();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ConstructorInitializerValidation_ReportsEachConstructionSite(bool generic)
    {
        var construction = generic ? "Holder[readonly managed[int32]]{}" : "Holder{}";
        var source = """
            package InitializerSites
            class HOLDER { private var Saved HANDLE = (func() HANDLE { return default(HANDLE) })() }
            func Main() {
                let first = CONSTRUCTION
                let second = CONSTRUCTION
            }
            """.Replace("HOLDER", generic ? "Holder[T]" : "Holder", StringComparison.Ordinal)
                .Replace("HANDLE", generic ? "T" : "readonly managed[int32]", StringComparison.Ordinal)
                .Replace("CONSTRUCTION", construction, StringComparison.Ordinal);
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile(source, "InitializerSites", true);
        Assert.NotEqual(0, code);
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "InitializerSites.dll")), output);
        foreach (var declaration in new[] { "let first = ", "let second = " })
        {
            var offset = source.IndexOf(declaration, StringComparison.Ordinal) + declaration.Length;
            AssertDiagnosticAt(source, offset, construction, output, "GS0604");
        }
    }

    [Fact]
    public void ConstructorInitializerValidation_RepeatedFunctionValuesExecuteOncePerConstruction()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package InitializerFunctions
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
            }
            """, "InitializerFunctions", true);
        IlVerifier.Verify(dll);
        Assert.Equal("7\n7\n2\n", fixture.Run(dll));
    }

    [Fact]
    public void ConstructorInitializerValidation_FunctionRecursionStillTerminates()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = TryCompileIsolated(fixture, """
            package InitializerFunctionRecursion
            import System
            class Flags { shared { public var Recurse bool } }
            class Node {
                public var Next Node? = (func() Node? { return Flags.Recurse ? Node{} : nil })()
            }
            func Main() {
                let first = Node{}
                let second = Node{}
                Console.WriteLine(first.Next == nil && second.Next == nil)
            }
            """, "InitializerFunctionRecursion");
        Assert.True(code == 0, output);
        var dll = Path.Combine(fixture.Directory, "InitializerFunctionRecursion.dll");
        IlVerifier.Verify(dll);
        Assert.Equal("True\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ConstructorInitializerValidation_DistinguishesOverwrittenAndConsumedResults(bool supplySecond)
    {
        const string construction = "Wrapper[readonly managed[int32]]{}";
        var source = """
            package InitializerResults
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
            }
            """.Replace("SECOND", supplySecond ? "Outer[T]{Nested: Inner[T]{Extra: Provider[T].Value}}" : "Outer[T](0)", StringComparison.Ordinal)
                .Replace("CONSTRUCTION", construction, StringComparison.Ordinal);
        if (!supplySecond)
        {
            Reject(source, construction);
            return;
        }

        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(source, "InitializerResults", true);
        IlVerifier.Verify(dll);
        Assert.Equal("11\n11\n", fixture.Run(dll));
    }

    private static (int Code, string Output) TryCompileIsolated(NativeSliceLanguageTests.Fixture fixture, string source, string name)
    {
        var sourcePath = Path.Combine(fixture.Directory, name + ".gs");
        File.WriteAllText(sourcePath, source);
        var start = new ProcessStartInfo("dotnet")
        {
            WorkingDirectory = fixture.Directory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "Compiler", "gsc.dll")));
        start.ArgumentList.Add("/out:" + Path.Combine(fixture.Directory, name + ".dll"));
        start.ArgumentList.Add("/target:exe");
        start.ArgumentList.Add("/targetframework:net10.0");
        start.ArgumentList.Add(sourcePath);
        using var process = Process.Start(start);
        Assert.NotNull(process);
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(30_000))
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
            Assert.Fail("isolated compiler witness timed out");
        }

        return (process.ExitCode, output.GetAwaiter().GetResult() + error.GetAwaiter().GetResult());
    }

    private static void Reject(string source, string anchor, string diagnostic = "GS0604", bool isolated = false)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = isolated
            ? TryCompileIsolated(fixture, source, "RejectedRecord")
            : fixture.TryCompile(source, "RejectedRecord", true);
        Assert.NotEqual(0, code);
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "RejectedRecord.dll")), output);
        var offset = source.IndexOf(anchor, StringComparison.Ordinal);
        Assert.True(offset >= 0);
        AssertDiagnosticAt(source, offset, anchor, output, diagnostic);
        var diagnostics = output.Split('\n').Where(line => line.Contains(": error ", StringComparison.Ordinal)).ToArray();
        Assert.NotEmpty(diagnostics);
        Assert.All(diagnostics, line => Assert.Contains($": error {diagnostic}:", line, StringComparison.Ordinal));
    }

    private static void AssertDiagnosticAt(string source, int offset, string anchor, string output, string diagnostic)
    {
        var line = 1 + source[..offset].Count(c => c == '\n');
        var column = offset - source.LastIndexOf('\n', offset);
        Assert.True(output.Contains($"({line},{column},{line},{column + anchor.Length}): error {diagnostic}:", StringComparison.Ordinal), output);
    }
}
