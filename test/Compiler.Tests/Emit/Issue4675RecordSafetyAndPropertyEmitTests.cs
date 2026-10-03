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
        Assert.DoesNotContain("error GS9998:", output, StringComparison.Ordinal);
    }
}
