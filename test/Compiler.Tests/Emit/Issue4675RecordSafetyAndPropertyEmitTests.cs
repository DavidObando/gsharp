// <copyright file="Issue4675RecordSafetyAndPropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4675RecordSafetyAndPropertyEmitTests
{
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

    private static void Reject(string source, string anchor)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile(source, "RejectedRecord", true);
        Assert.NotEqual(0, code);
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "RejectedRecord.dll")), output);
        var offset = source.IndexOf(anchor, StringComparison.Ordinal);
        Assert.True(offset >= 0);
        var line = 1 + source[..offset].Count(c => c == '\n');
        var column = offset - source.LastIndexOf('\n', offset);
        Assert.Contains($"({line},{column},{line},{column + anchor.Length}): error GS0604:", output, StringComparison.Ordinal);
        var diagnostics = output.Split('\n').Where(line => line.Contains(": error ", StringComparison.Ordinal)).ToArray();
        Assert.NotEmpty(diagnostics);
        Assert.All(diagnostics, line => Assert.Contains(": error GS0604:", line, StringComparison.Ordinal));
    }
}
