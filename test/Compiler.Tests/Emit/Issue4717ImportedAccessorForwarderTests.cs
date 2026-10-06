// <copyright file="Issue4717ImportedAccessorForwarderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #4717: separately compiled non-virtual accessors need derived interface slots.</summary>
/// <remarks>
/// ADR-0154: the cross-assembly verification and runtime rows fail on f107f3896
/// with missing interface accessor implementations. The preservation controls
/// keep existing virtual, explicit and local implementations unchanged.
/// Disabling only imported-accessor bridge planning makes all 24 forwarding
/// rows fail IL verification or runtime loading; seven preservation and
/// fail-loud unsupported-ref controls still pass. Restoring the plan is green.
/// </remarks>
public sealed class Issue4717ImportedAccessorForwarderTests
{
    private const string BaseSource = """
        package ExternalBase

        public open class Base {
            public prop Value int32 -> 3
            public prop Extra int32 { get; set; }
        }
        public open class MutableBase {
            public prop Value int32 { get; set; }
        }
        public open class InitBase {
            public prop Value int32 { get; init; }
        }
        public open class IndexBase {
            private var number int32 = 41
            public prop this[key int32] int32 {
                get { return this.number + key }
                set { this.number = value - key }
            }
        }
        public open class GenericBase[T] {
            public prop Value T { get; set; }
        }
        public open class GenericMiddle[T] : GenericBase[T] { }
        public open class GenericInitBase[T] {
            public prop Value T { get; init; }
        }
        public open class GenericIndexBase[T] {
            private var item T
            public prop this[key T] T {
                get { return this.item }
                set { this.item = value }
            }
        }
        public open class VirtualBase {
            public open prop Value int32 -> 5
        }
        public interface IExisting { prop Value int32 { get; } }
        public open class MappedBase : IExisting {
            public prop Value int32 -> 7
        }
        """;

    [Theory]
    [InlineData("computed", false)]
    [InlineData("mutable", false)]
    [InlineData("init", false)]
    [InlineData("indexer", false)]
    [InlineData("generic", false)]
    [InlineData("generic-init", false)]
    [InlineData("generic-indexer", false)]
    [InlineData("nullable-generic", false)]
    [InlineData("source-middle", false)]
    [InlineData("symbolic", false)]
    [InlineData("computed", true)]
    [InlineData("mutable", true)]
    [InlineData("init", true)]
    [InlineData("indexer", true)]
    [InlineData("generic", true)]
    [InlineData("generic-init", true)]
    [InlineData("generic-indexer", true)]
    [InlineData("nullable-generic", true)]
    [InlineData("source-middle", true)]
    [InlineData("symbolic", true)]
    public void CrossAssemblyAccessor_VerifiesAndDispatches(string shape, bool runtime)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var baseAssembly = fixture.Compile(BaseSource, "ExternalBase", executable: false);
        var reference = Path.Combine(fixture.Directory, "ExternalDerived.ref.dll");
        var leafAssembly = fixture.Compile(
            LeafSource(shape),
            "ExternalDerived",
            executable: false,
            "/r:" + baseAssembly,
            "/refout:" + reference);

        if (!runtime)
        {
            IlVerifier.Verify(baseAssembly);
            IlVerifier.Verify(leafAssembly, additionalReferences: new[] { baseAssembly });
            Assert.Equal(ForwarderMetadata(leafAssembly), ForwarderMetadata(reference));
            return;
        }

        var assemblies = EmittedFixture.LoadTogether(baseAssembly, leafAssembly);
        var leaf = assemblies[1].GetType("ExternalDerived.Leaf")
            ?? assemblies[1].GetType("ExternalDerived.Leaf`1")
            ?? throw new InvalidOperationException("Missing leaf fixture.");
        if (leaf.IsGenericTypeDefinition)
        {
            leaf = leaf.MakeGenericType(typeof(string));
        }

        var iface = Assert.Single(leaf.GetInterfaces());
        var instance = Activator.CreateInstance(leaf);
        var map = leaf.GetInterfaceMap(iface);
        Assert.Equal(shape == "computed" ? 1 : 2, map.TargetMethods.Length);
        Assert.All(map.TargetMethods, method =>
        {
            Assert.Equal(leaf, method.DeclaringType);
            Assert.Equal(
                MethodAttributes.Private | MethodAttributes.HideBySig | MethodAttributes.SpecialName
                    | MethodAttributes.Virtual | MethodAttributes.Final | MethodAttributes.NewSlot,
                method.Attributes);
        });
        if (shape is "init" or "generic-init")
        {
            var setter = map.TargetMethods.Single(method => method.GetParameters().Length == 1);
            Assert.Contains(setter.ReturnParameter.GetRequiredCustomModifiers(),
                type => type.FullName == "System.Runtime.CompilerServices.IsExternalInit");
        }

        var baseAccessors = leaf.BaseType?.GetMethods(BindingFlags.Instance | BindingFlags.Public)
                .Where(method => method.IsSpecialName && method.Name is "get_Value" or "set_Value" or "get_Item" or "set_Item")
                .ToArray() ?? throw new InvalidOperationException("Missing base fixture.");
        Assert.NotEmpty(baseAccessors);
        Assert.All(baseAccessors, method => Assert.False(method.IsVirtual));

        var property = Assert.Single(iface.GetProperties());
        if (shape == "computed")
        {
            Assert.Equal(3, property.GetValue(instance));
        }
        else if (shape == "indexer")
        {
            Assert.Equal(44, property.GetValue(instance, new object[] { 3 }));
            property.SetValue(instance, 19, new object[] { 3 });
            Assert.Equal(20, property.GetValue(instance, new object[] { 4 }));
        }
        else
        {
            object value = shape is "generic" or "generic-init" or "generic-indexer" or "nullable-generic" or "source-middle"
                ? "selected-owner"
                : shape == "symbolic"
                    ? Activator.CreateInstance(assemblies[1].GetType("ExternalDerived.Token")
                        ?? throw new InvalidOperationException("Missing symbolic argument fixture."))
                        ?? throw new InvalidOperationException("Could not construct symbolic argument.")
                    : 17;
            var indices = shape == "generic-indexer" ? new object[] { "key" } : null;
            property.SetValue(instance, value, indices);
            Assert.Equal(value, property.GetValue(instance, indices));
            if (shape == "nullable-generic")
            {
                property.SetValue(instance, null);
                Assert.Null(property.GetValue(instance));
            }
        }
    }

    [Theory]
    [InlineData("virtual", 5, "VirtualBase")]
    [InlineData("override", 11, "Leaf")]
    [InlineData("explicit", 13, "Leaf")]
    [InlineData("local", 17, "Leaf")]
    [InlineData("mapped", 7, "MappedBase")]
    public void ExistingImplementation_KeepsItsInterfaceMap(string shape, int value, string declaringType)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var baseAssembly = fixture.Compile(BaseSource, "ExternalBase", executable: false);
        var declaration = shape == "mapped" ? string.Empty : "interface IValue { prop Value int32 { get; } }";
        var leafDeclaration = shape switch
        {
            "virtual" => "class Leaf : VirtualBase, IValue { }",
            "override" => "class Leaf : VirtualBase, IValue { override prop Value int32 -> 11 }",
            "explicit" => "class Leaf : Base, IValue { private prop (IValue) Value int32 -> 13 }",
            "local" => "class Leaf : Base, IValue { prop Value int32 -> 17 }",
            "mapped" => "class Leaf : MappedBase, IExisting { }",
            _ => throw new ArgumentOutOfRangeException(nameof(shape)),
        };
        var leafAssembly = fixture.Compile(
            $"package ExternalDerived\nimport ExternalBase\n{declaration}\n{leafDeclaration}",
            "ExternalDerived",
            executable: false,
            "/r:" + baseAssembly);
        IlVerifier.Verify(leafAssembly, additionalReferences: new[] { baseAssembly });
        var leaf = EmittedFixture.LoadTogether(baseAssembly, leafAssembly)[1].GetType("ExternalDerived.Leaf")
            ?? throw new InvalidOperationException("Missing control fixture.");
        var iface = Assert.Single(leaf.GetInterfaces());
        var target = Assert.Single(leaf.GetInterfaceMap(iface).TargetMethods);
        Assert.Equal(declaringType, target.DeclaringType?.Name);
        Assert.Equal(value, Assert.Single(iface.GetProperties()).GetValue(Activator.CreateInstance(leaf)));
    }

    [Theory]
    [InlineData("hidden", "HiddenMiddle", 19)]
    [InlineData("overloaded-indexer", "IndexBase", 44)]
    [InlineData("nullable", "NullableBase", null)]
    public void RoslynBase_UsesExactSelectedAccessor(string shape, string ownerName, object expected)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var baseAssembly = fixture.CompileCSharp("""
            namespace ExternalBase {
                public class Base { public int Value => 3; }
                public class HiddenMiddle : Base { public new int Value => 19; }
                public class IndexBase {
                    public int this[int key] => 41 + key;
                    public int this[string key] => 99;
                }
                public class NullableBase { public string? Value { get; set; } }
            }
            """, "ExternalBase");
        var contract = shape switch
        {
            "overloaded-indexer" => "prop this[key int32] int32 { get; }",
            "nullable" => "prop Value string? { get; set; }",
            _ => "prop Value int32 { get; }",
        };
        var reference = Path.Combine(fixture.Directory, "ExternalDerived.ref.dll");
        var leafAssembly = fixture.Compile(
            $"package ExternalDerived\nimport ExternalBase\ninterface IValue {{ {contract} }}\nclass Leaf : {ownerName}, IValue {{ }}",
            "ExternalDerived",
            executable: false,
            "/r:" + baseAssembly,
            "/refout:" + reference);
        IlVerifier.Verify(leafAssembly, additionalReferences: new[] { baseAssembly });
        Assert.Equal(ForwarderMetadata(leafAssembly), ForwarderMetadata(reference));
        var leaf = EmittedFixture.LoadTogether(baseAssembly, leafAssembly)[1].GetType("ExternalDerived.Leaf")
            ?? throw new InvalidOperationException("Missing Roslyn-base leaf.");
        var iface = Assert.Single(leaf.GetInterfaces());
        var map = leaf.GetInterfaceMap(iface);
        Assert.NotEmpty(map.TargetMethods);
        foreach (var bridge in map.TargetMethods)
        {
            Assert.Equal(leaf, bridge.DeclaringType);
            var il = bridge.GetMethodBody()?.GetILAsByteArray()
                ?? throw new InvalidOperationException("Missing forwarding body.");
            var callOffset = Array.IndexOf(il, (byte)0x28);
            Assert.True(callOffset > 0, "The bridge must directly call the selected accessor.");
            var target = bridge.Module.ResolveMethod(BitConverter.ToInt32(il, callOffset + 1));
            Assert.Equal(ownerName, target?.DeclaringType?.Name);
            Assert.False((target as MethodInfo)?.IsVirtual);
        }

        var property = Assert.Single(iface.GetProperties());
        var instance = Activator.CreateInstance(leaf);
        var indices = shape == "overloaded-indexer" ? new object[] { 3 } : null;
        Assert.Equal(expected, property.GetValue(instance, indices));
        if (shape == "nullable")
        {
            property.SetValue(instance, "selected");
            Assert.Equal("selected", property.GetValue(instance));
            property.SetValue(instance, null);
            Assert.Null(property.GetValue(instance));
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void UnsupportedRefInterfaceProperty_StillFailsLoudly(bool readOnly)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var modifier = readOnly ? "ref readonly" : "ref";
        var baseAssembly = fixture.CompileCSharp($$"""
            namespace ExternalBase {
                public class RefBase {
                    private int value = 31;
                    public {{modifier}} int Value => ref value;
                }
            }
            """, "ExternalBase");
        var (code, output) = fixture.TryCompile(
            $"package ExternalDerived\nimport ExternalBase\npublic interface IValue {{ prop Value {modifier} int32 {{ get; }} }}\npublic class Leaf : RefBase, IValue {{ }}",
            "ExternalDerived",
            executable: false,
            "/r:" + baseAssembly);
        Assert.NotEqual(0, code);
        Assert.Contains("ExternalDerived.gs(3,38,3,41): error GS0578", output, StringComparison.Ordinal);
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "ExternalDerived.dll")));
    }

    [Fact]
    public void ConstructedTransitiveInterfaces_ReserveDistinctSlotsAndKeepInheritedMapping()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var baseAssembly = fixture.Compile(BaseSource, "ExternalBase", executable: false);
        var reference = Path.Combine(fixture.Directory, "ExternalDerived.ref.dll");
        var leafAssembly = fixture.Compile("""
            package ExternalDerived
            import ExternalBase
            public interface IValue[T] { prop Value int32 { get; } }
            public interface IChild : IValue[int32], IValue[string] { }
            public open class Middle : Base, IChild {
                shared { public func Marker() int32 { return 29 } }
            }
            class Leaf : Middle, IChild { }
            """, "ExternalDerived", executable: false, "/r:" + baseAssembly, "/refout:" + reference);
        IlVerifier.Verify(leafAssembly, additionalReferences: new[] { baseAssembly });
        var consumer = fixture.Compile("""
            package Consumer
            import ExternalDerived
            class Final : Middle, IChild { }
            """, "Consumer", executable: false, "/r:" + baseAssembly, "/r:" + reference);
        IlVerifier.Verify(consumer, additionalReferences: new[] { baseAssembly, leafAssembly });
        var assemblies = EmittedFixture.LoadTogether(baseAssembly, leafAssembly, consumer);
        var assembly = assemblies[1];
        var middle = assembly.GetType("ExternalDerived.Middle")
            ?? throw new InvalidOperationException("Missing forwarding middle.");
        var leaf = assembly.GetType("ExternalDerived.Leaf")
            ?? throw new InvalidOperationException("Missing relisting leaf.");
        var final = assemblies[2].GetType("Consumer.Final")
            ?? throw new InvalidOperationException("Missing reference-assembly consumer.");
        Assert.Equal(29, middle.GetMethod("Marker")?.Invoke(null, null));
        var interfaces = leaf.GetInterfaces().Where(type => type.IsGenericType).ToArray();
        Assert.Equal(2, interfaces.Length);
        foreach (var iface in interfaces)
        {
            var middleTarget = Assert.Single(middle.GetInterfaceMap(iface).TargetMethods);
            var leafTarget = Assert.Single(leaf.GetInterfaceMap(iface).TargetMethods);
            Assert.Equal(middle, leafTarget.DeclaringType);
            Assert.Equal(middleTarget.Module, leafTarget.Module);
            Assert.Equal(middleTarget.MetadataToken, leafTarget.MetadataToken);
            Assert.Equal(3, Assert.Single(iface.GetProperties()).GetValue(Activator.CreateInstance(leaf)));
            var finalTarget = Assert.Single(final.GetInterfaceMap(iface).TargetMethods);
            Assert.Equal(middle, finalTarget.DeclaringType);
            Assert.Equal(middleTarget.MetadataToken, finalTarget.MetadataToken);
            Assert.Equal(3, Assert.Single(iface.GetProperties()).GetValue(Activator.CreateInstance(final)));
        }

        Assert.Empty(ForwarderMetadata(leafAssembly, "Leaf", requireImplementations: false));
        Assert.Equal(ForwarderMetadata(leafAssembly, "Middle"), ForwarderMetadata(reference, "Middle"));
    }

    private static string LeafSource(string shape)
    {
        var declaration = shape switch
        {
            "computed" => "interface IValue { prop Value int32 { get; } }\nclass Leaf : Base, IValue { }",
            "mutable" => "interface IValue { prop Value int32 { get; set; } }\nclass Leaf : MutableBase, IValue { }",
            "init" => "interface IValue { prop Value int32 { get; init; } }\nclass Leaf : InitBase, IValue { }",
            "indexer" => "interface IValue { prop this[key int32] int32 { get; set; } }\nclass Leaf : IndexBase, IValue { }",
            "generic" => "interface IValue[T] { prop Value T { get; set; } }\nclass Leaf[T] : GenericMiddle[T], IValue[T] { }",
            "generic-init" => "interface IValue[T] { prop Value T { get; init; } }\nclass Leaf[T] : GenericInitBase[T], IValue[T] { }",
            "generic-indexer" => "interface IValue[T] { prop this[key T] T { get; set; } }\nclass Leaf[T] : GenericIndexBase[T], IValue[T] { }",
            "nullable-generic" => "interface IValue[T] { prop Value T { get; set; } }\nclass Leaf : GenericMiddle[string?], IValue[string?] { }",
            "source-middle" => """
                interface IValue[T] { prop Value T { get; set; } }
                open class Middle : GenericMiddle[string] { }
                class Leaf : Middle, IValue[string] { }
                """,
            "symbolic" => """
                class Token { }
                interface IValue[T] { prop Value T { get; set; } }
                class Leaf : GenericMiddle[Token], IValue[Token] { }
                """,
            _ => throw new ArgumentOutOfRangeException(nameof(shape)),
        };
        return "package ExternalDerived\nimport ExternalBase\n" + declaration;
    }

    private static string[] ForwarderMetadata(string assembly, string typeName = "Leaf", bool requireImplementations = true)
    {
        using var pe = new PEReader(File.OpenRead(assembly));
        var reader = pe.GetMetadataReader();
        var leaf = reader.TypeDefinitions.Select(reader.GetTypeDefinition)
            .Single(type => reader.GetString(type.Name) == typeName || reader.GetString(type.Name) == typeName + "`1");
        var implementations = leaf.GetMethodImplementations().Select(reader.GetMethodImplementation).ToArray();
        if (requireImplementations)
        {
            Assert.NotEmpty(implementations);
        }

        return implementations.Select(implementation =>
        {
            var body = reader.GetMethodDefinition((MethodDefinitionHandle)implementation.MethodBody);
            return $"{reader.GetString(body.Name)}:{body.Attributes}:{Convert.ToHexString(reader.GetBlobBytes(body.Signature))}"
                + $":{implementation.MethodDeclaration.Kind}";
        }).ToArray();
    }
}
