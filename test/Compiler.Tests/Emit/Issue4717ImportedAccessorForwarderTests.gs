// <copyright file="Issue4717ImportedAccessorForwarderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import GSharp.Tests
import Xunit
import GSharp.Compiler.Tests

/// Issue #4717: separately compiled non-virtual accessors need derived interface slots.
/// @remarks ADR-0154: the cross-assembly verification and runtime rows fail on f107f3896
/// with missing interface accessor implementations. The preservation controls
/// keep existing virtual, explicit and local implementations unchanged.
/// Disabling only imported-accessor bridge planning makes all 24 forwarding
/// rows fail IL verification or runtime loading; seven preservation and
/// fail-loud unsupported-ref controls still pass. Restoring the plan is green.
class Issue4717ImportedAccessorForwarderTests {
    @Theory
    @InlineData("computed", false)
    @InlineData("mutable", false)
    @InlineData("init", false)
    @InlineData("indexer", false)
    @InlineData("generic", false)
    @InlineData("generic-init", false)
    @InlineData("generic-indexer", false)
    @InlineData("nullable-generic", false)
    @InlineData("source-middle", false)
    @InlineData("symbolic", false)
    @InlineData("computed", true)
    @InlineData("mutable", true)
    @InlineData("init", true)
    @InlineData("indexer", true)
    @InlineData("generic", true)
    @InlineData("generic-init", true)
    @InlineData("generic-indexer", true)
    @InlineData("nullable-generic", true)
    @InlineData("source-middle", true)
    @InlineData("symbolic", true)
    func CrossAssemblyAccessor_VerifiesAndDispatches(shape string, runtime bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let baseAssembly = fixture.Compile(BaseSource, "ExternalBase", executable: false)
        let reference = Path.Combine(fixture.Directory, "ExternalDerived.ref.dll")
        let leafAssembly = fixture.Compile(
            LeafSource(shape),
            "ExternalDerived",
            executable: false,
            "/r:" + baseAssembly,
            "/refout:" + reference
        )
        if !runtime {
            IlVerifier.Verify(baseAssembly)
            IlVerifier.Verify(leafAssembly, additionalReferences: []string{baseAssembly})
            Assert.Equal(ForwarderMetadata(leafAssembly), ForwarderMetadata(reference))
            return
        }
        let assemblies = EmittedFixture.LoadTogether(baseAssembly, leafAssembly)
        var leaf = assemblies[1].GetType("ExternalDerived.Leaf") ?? assemblies[1].GetType("ExternalDerived.Leaf`1") ??
            throw InvalidOperationException("Missing leaf fixture.")
        if leaf.IsGenericTypeDefinition {
            leaf = leaf.MakeGenericType(typeof(string))
        }
        let iface = Assert.Single(leaf.GetInterfaces())
        let instance object? = Activator.CreateInstance(leaf)
        let map_ = leaf.GetInterfaceMap(iface)
        Assert.Equal(
            if shape == "computed" {
                1
            } else {
                2
            },
            map_.TargetMethods.Length
        )
        Assert.All(
            map_.TargetMethods,
            (method MethodInfo) -> {
                Assert.Equal(leaf, method.DeclaringType)
                Assert.Equal(
                    MethodAttributes.Private | MethodAttributes.HideBySig | MethodAttributes.SpecialName | MethodAttributes.Virtual | MethodAttributes.Final | MethodAttributes.NewSlot,
                    method.Attributes
                )
            }
        )
        if shape == "init" || shape == "generic-init" {
            let setter = map_.TargetMethods.Single((method MethodInfo) -> method.GetParameters().Length == 1)
            Assert.Contains(
                setter.ReturnParameter.GetRequiredCustomModifiers(),
                (type Type) -> type.FullName == "System.Runtime.CompilerServices.IsExternalInit"
            )
        }
        let baseAccessors = leaf
            .BaseType
            ?.GetMethods(BindingFlags.Instance | BindingFlags.Public)
            .Where(
            (method MethodInfo) -> method.IsSpecialName &&
                (method.Name is "get_Value" or "set_Value" or "get_Item" or "set_Item")
        )
            .ToArray() ??
            throw InvalidOperationException("Missing base fixture.")
        Assert.NotEmpty(baseAccessors)
        Assert.All(baseAccessors, (method MethodInfo) -> Assert.False(method.IsVirtual))
        let property = Assert.Single(iface.GetProperties())
        if shape == "computed" {
            Assert.Equal(3, property.GetValue(instance))
        } else if shape == "indexer" {
            Assert.Equal(44, property.GetValue(instance, []object{3}))
            property.SetValue(instance, 19, []object{3})
            Assert.Equal(20, property.GetValue(instance, []object{4}))
        } else {
            let value = if shape == "generic" ||
                shape == "generic-init" ||
                shape == "generic-indexer" ||
                shape == "nullable-generic" ||
                shape == "source-middle" {
                cast[object]("selected-owner")
            } else {
                (
                    if shape == "symbolic" {
                        Activator.CreateInstance(
                            assemblies[1].GetType("ExternalDerived.Token") ??
                                throw InvalidOperationException("Missing symbolic argument fixture.")
                        ) ??
                            throw InvalidOperationException("Could not construct symbolic argument.")
                    } else {
                        17
                    }
                )
            }
            let indices[]?object = if shape == "generic-indexer" {
                []object{"key"}
            } else {
                default([]?object)
            }
            property.SetValue(instance, value, indices)
            Assert.Equal(value, property.GetValue(instance, indices))
            if shape == "nullable-generic" {
                property.SetValue(instance, nil)
                Assert.Null(property.GetValue(instance))
            }
        }
    }

    @Theory
    @InlineData("virtual", int32(5), "VirtualBase")
    @InlineData("override", int32(11), "Leaf")
    @InlineData("explicit", int32(13), "Leaf")
    @InlineData("local", int32(17), "Leaf")
    @InlineData("mapped", int32(7), "MappedBase")
    func ExistingImplementation_KeepsItsInterfaceMap(shape string, value int32, declaringType string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let baseAssembly = fixture.Compile(BaseSource, "ExternalBase", executable: false)
        let declaration = if shape == "mapped" {
            string.Empty
        } else {
            "interface IValue { prop Value int32 { get; } }"
        }
        let leafDeclaration = switch shape {
            case "virtual": "class Leaf : VirtualBase, IValue { }"
            case "override": "class Leaf : VirtualBase, IValue { override prop Value int32 -> 11 }"
            case "explicit": "class Leaf : Base, IValue { private prop (IValue) Value int32 -> 13 }"
            case "local": "class Leaf : Base, IValue { prop Value int32 -> 17 }"
            case "mapped": "class Leaf : MappedBase, IExisting { }"
            default: throw ArgumentOutOfRangeException("shape")
        }
        let leafAssembly = fixture.Compile((`package ExternalDerived
import ExternalBase
` + "$declaration" + `
` + "$leafDeclaration"), "ExternalDerived", executable: false, "/r:" + baseAssembly)
        IlVerifier.Verify(leafAssembly, additionalReferences: []string{baseAssembly})
        let leaf = EmittedFixture.LoadTogether(baseAssembly, leafAssembly)[1].GetType("ExternalDerived.Leaf") ??
            throw InvalidOperationException("Missing control fixture.")
        let iface = Assert.Single(leaf.GetInterfaces())
        let target = Assert.Single(leaf.GetInterfaceMap(iface).TargetMethods)
        Assert.Equal(declaringType, target.DeclaringType?.Name)
        Assert.Equal(value, Assert.Single(iface.GetProperties()).GetValue(Activator.CreateInstance(leaf)))
    }

    @Theory
    @InlineData("hidden", "HiddenMiddle", int32(19))
    @InlineData("overloaded-indexer", "IndexBase", int32(44))
    @InlineData("nullable", "NullableBase", nil)
    func RoslynBase_UsesExactSelectedAccessor(shape string, ownerName string, expected object?) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let baseAssembly = fixture.CompileCSharp(`namespace ExternalBase {
    public class Base { public int Value => 3; }
    public class HiddenMiddle : Base { public new int Value => 19; }
    public class IndexBase {
        public int this[int key] => 41 + key;
        public int this[string key] => 99;
    }
    public class NullableBase { public string? Value { get; set; } }
}`, "ExternalBase")
        let contract = switch shape {
            case "overloaded-indexer": "prop this[key int32] int32 { get; }"
            case "nullable": "prop Value string? { get; set; }"
            default: "prop Value int32 { get; }"
        }
        let reference = Path.Combine(fixture.Directory, "ExternalDerived.ref.dll")
        let leafAssembly = fixture.Compile((`package ExternalDerived
import ExternalBase
interface IValue { ` + "$contract" + ` }
class Leaf : ` + "$ownerName" + `, IValue { }`), "ExternalDerived", executable: false, "/r:" +
                baseAssembly, "/refout:" + reference)
        IlVerifier.Verify(leafAssembly, additionalReferences: []string{baseAssembly})
        Assert.Equal(ForwarderMetadata(leafAssembly), ForwarderMetadata(reference))
        let leaf = EmittedFixture.LoadTogether(baseAssembly, leafAssembly)[1].GetType("ExternalDerived.Leaf") ??
            throw InvalidOperationException("Missing Roslyn-base leaf.")
        let iface = Assert.Single(leaf.GetInterfaces())
        let map_ = leaf.GetInterfaceMap(iface)
        Assert.NotEmpty(map_.TargetMethods)
        for bridge in map_.TargetMethods {
            Assert.Equal(leaf, bridge.DeclaringType)
            let il = bridge.GetMethodBody()?.GetILAsByteArray() ??
                throw InvalidOperationException("Missing forwarding body.")
            let callOffset = Array.IndexOf(il, uint8(0x28))
            Assert.True(callOffset > 0, "The bridge must directly call the selected accessor.")
            let target MethodBase? = bridge.Module.ResolveMethod(BitConverter.ToInt32(il, callOffset + 1))
            Assert.Equal(ownerName, target?.DeclaringType?.Name)
            Assert.False((target as MethodInfo)?.IsVirtual)
        }
        let property = Assert.Single(iface.GetProperties())
        let instance object? = Activator.CreateInstance(leaf)
        let indices[]?object = if shape == "overloaded-indexer" {
            []object{3}
        } else {
            default([]?object)
        }
        Assert.Equal(expected, property.GetValue(instance, indices))
        if shape == "nullable" {
            property.SetValue(instance, "selected")
            Assert.Equal("selected", property.GetValue(instance))
            property.SetValue(instance, nil)
            Assert.Null(property.GetValue(instance))
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func UnsupportedRefInterfaceProperty_StillFailsLoudly(readOnly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let modifier = if readOnly {
            "ref readonly"
        } else {
            "ref"
        }
        let baseAssembly = fixture.CompileCSharp((`namespace ExternalBase {
    public class RefBase {
        private int value = 31;
        public ` + "$modifier" + ` int Value => ref value;
    }
}`), "ExternalBase")
        let (code, output) = fixture.TryCompile((`package ExternalDerived
import ExternalBase
public interface IValue { prop Value ` + "$modifier" + ` int32 { get; } }
public class Leaf : RefBase, IValue { }`), "ExternalDerived", executable: false, "/r:" + baseAssembly)
        Assert.NotEqual(0, code)
        Assert.Contains("ExternalDerived.gs(3,38,3,41): error GS0578", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "ExternalDerived.dll")))
    }

    @Fact
    func ConstructedTransitiveInterfaces_ReserveDistinctSlotsAndKeepInheritedMapping() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let baseAssembly = fixture.Compile(BaseSource, "ExternalBase", executable: false)
        let reference = Path.Combine(fixture.Directory, "ExternalDerived.ref.dll")
        let leafAssembly = fixture.Compile(`package ExternalDerived
import ExternalBase
public interface IValue[T] { prop Value int32 { get; } }
public interface IChild : IValue[int32], IValue[string] { }
public open class Middle : Base, IChild {
    shared { public func Marker() int32 { return 29 } }
}
class Leaf : Middle, IChild { }`, "ExternalDerived", executable: false, "/r:" + baseAssembly, "/refout:" + reference)
        IlVerifier.Verify(leafAssembly, additionalReferences: []string{baseAssembly})
        let consumer = fixture.Compile(`package Consumer
import ExternalDerived
class Final : Middle, IChild { }`, "Consumer", executable: false, "/r:" + baseAssembly, "/r:" + reference)
        IlVerifier.Verify(consumer, additionalReferences: []string{baseAssembly, leafAssembly})
        let assemblies = EmittedFixture.LoadTogether(baseAssembly, leafAssembly, consumer)
        let assembly = assemblies[1]
        let middle = assembly.GetType("ExternalDerived.Middle") ??
            throw InvalidOperationException("Missing forwarding middle.")
        let leaf = assembly.GetType("ExternalDerived.Leaf") ??
            throw InvalidOperationException("Missing relisting leaf.")
        let final = assemblies[2].GetType("Consumer.Final") ??
            throw InvalidOperationException("Missing reference-assembly consumer.")
        Assert.Equal(29, middle.GetMethod("Marker")?.Invoke(nil, nil))
        let interfaces = leaf.GetInterfaces().Where((type Type) -> type.IsGenericType).ToArray()
        Assert.Equal(2, interfaces.Length)
        for iface in interfaces {
            let middleTarget = Assert.Single(middle.GetInterfaceMap(iface).TargetMethods)
            let leafTarget = Assert.Single(leaf.GetInterfaceMap(iface).TargetMethods)
            Assert.Equal(middle, leafTarget.DeclaringType)
            Assert.Equal(middleTarget.Module, leafTarget.Module)
            Assert.Equal(middleTarget.MetadataToken, leafTarget.MetadataToken)
            Assert.Equal(3, Assert.Single(iface.GetProperties()).GetValue(Activator.CreateInstance(leaf)))
            let finalTarget = Assert.Single(final.GetInterfaceMap(iface).TargetMethods)
            Assert.Equal(middle, finalTarget.DeclaringType)
            Assert.Equal(middleTarget.MetadataToken, finalTarget.MetadataToken)
            Assert.Equal(3, Assert.Single(iface.GetProperties()).GetValue(Activator.CreateInstance(final)))
        }
        Assert.Empty(ForwarderMetadata(leafAssembly, "Leaf", requireImplementations: false))
        Assert.Equal(ForwarderMetadata(leafAssembly, "Middle"), ForwarderMetadata(reference, "Middle"))
    }

    shared {
        private const BaseSource string = `package ExternalBase

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
}`

        private func LeafSource(shape string) string {
            let declaration = switch shape {
                case "computed": "interface IValue { prop Value int32 { get; } }\nclass Leaf : Base, IValue { }"
                case "mutable": "interface IValue { prop Value int32 { get; set; } }\nclass Leaf : MutableBase, IValue { }"
                case "init": "interface IValue { prop Value int32 { get; init; } }\nclass Leaf : InitBase, IValue { }"
                case "indexer": "interface IValue { prop this[key int32] int32 { get; set; } }\nclass Leaf : IndexBase, IValue { }"
                case "generic": "interface IValue[T] { prop Value T { get; set; } }\nclass Leaf[T] : GenericMiddle[T], IValue[T] { }"
                case "generic-init": "interface IValue[T] { prop Value T { get; init; } }\nclass Leaf[T] : GenericInitBase[T], IValue[T] { }"
                case "generic-indexer": "interface IValue[T] { prop this[key T] T { get; set; } }\nclass Leaf[T] : GenericIndexBase[T], IValue[T] { }"
                case "nullable-generic": "interface IValue[T] { prop Value T { get; set; } }\nclass Leaf : GenericMiddle[string?], IValue[string?] { }"
                case "source-middle": `interface IValue[T] { prop Value T { get; set; } }
open class Middle : GenericMiddle[string] { }
class Leaf : Middle, IValue[string] { }`
                case "symbolic": `class Token { }
interface IValue[T] { prop Value T { get; set; } }
class Leaf : GenericMiddle[Token], IValue[Token] { }`
                default: throw ArgumentOutOfRangeException("shape")
            }
            return `package ExternalDerived
import ExternalBase
` + declaration
        }

        private func ForwarderMetadata(
            assembly string,
            typeName string = "Leaf",
            requireImplementations bool = true
        )[]string {
            using let pe = PEReader(File.OpenRead(assembly))
            let reader = pe.GetMetadataReader()
            let leaf = reader
                .TypeDefinitions
                .Select(reader.GetTypeDefinition)
                .Single(
                (type TypeDefinition) -> reader.GetString(type.Name) == typeName || reader.GetString(
                    type.Name
                ) == typeName +
                    "`1"
            )
            let implementations = leaf.GetMethodImplementations().Select(reader.GetMethodImplementation).ToArray()
            if requireImplementations {
                Assert.NotEmpty(implementations)
            }
            return implementations.Select(
                (implementation MethodImplementation) -> {
                    let body = reader.GetMethodDefinition(MethodDefinitionHandle(implementation.MethodBody))
                    return "${reader.GetString(body.Name)}:${body.Attributes}:${Convert.ToHexString(reader.GetBlobBytes(body.Signature))}" +
                        ":${implementation.MethodDeclaration.Kind}"
                }
            )
                .ToArray()
        }
    }
}
