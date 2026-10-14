// <copyright file="Issue4493CovariantReturnOverrideEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import System
import System.IO
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import Xunit

class Issue4493CovariantReturnOverrideEmitTests {
    @Fact
    func SourcePropertyCovariantReturn_LoadsAndDispatchesThroughBaseSlot() {
        const source = `package i4493
import System

open class Symbol { }
class PropertySymbol : Symbol { }

open class Base {
    open prop Property Symbol {
        get;
    }
}

class Derived : Base {
    private var value PropertySymbol = PropertySymbol()
    override prop Property PropertySymbol -> this.value
}

func Main() {
    let value Base = Derived()
    Console.WriteLine(value.Property.GetType().Name)
}`
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "issue4493.ref.dll")
        let assembly = fixture.Compile(source, "issue4493", executable: true, "/refout:" + reference)
        IlVerifier.Verify(assembly)
        AssertCovariantOverrideMetadata(assembly, "Derived", HandleKind.MethodDefinition)
        AssertCovariantOverrideMetadata(reference, "Derived", HandleKind.MethodDefinition)
        Assert.Equal("PropertySymbol\n", fixture.Run(assembly))
    }

    @Fact
    func ConstructedGenericBaseProperty_UsesTypeSpecMemberRefAndRuns() {
        const source = `package i4493generic
import System

open class Symbol { }
class PropertySymbol : Symbol { }

open class Base[T] {
    open prop Property T {
        get;
    }
}

class Derived : Base[Symbol] {
    private var value PropertySymbol = PropertySymbol()
    override prop Property PropertySymbol -> this.value
}

func Main() {
    let value Base[Symbol] = Derived()
    Console.WriteLine(value.Property.GetType().Name)
}`
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "issue4493generic.ref.dll")
        let assembly = fixture.Compile(source, "issue4493generic", executable: true, "/refout:" + reference)
        IlVerifier.Verify(assembly)
        AssertCovariantOverrideMetadata(assembly, "Derived", HandleKind.MemberReference)
        AssertCovariantOverrideMetadata(reference, "Derived", HandleKind.MemberReference)
        Assert.Equal("PropertySymbol\n", fixture.Run(assembly))
    }

    @Fact
    func ThreeLevelCovariantPropertyChain_DispatchesToLeaf() {
        const source = `package i4493chain
import System

open class Symbol { }
open class MiddleSymbol : Symbol { }
class LeafSymbol : MiddleSymbol { }

open class Base {
    open prop Property Symbol {
        get;
    }
}

open class Middle : Base {
    open override prop Property MiddleSymbol -> MiddleSymbol()
}

class Leaf : Middle {
    override prop Property LeafSymbol -> LeafSymbol()
}

func Main() {
    let baseValue Base = Leaf()
    let middleValue Middle = Leaf()
    Console.WriteLine(baseValue.Property.GetType().Name)
    Console.WriteLine(middleValue.Property.GetType().Name)
}`
        using let fixture = NativeSliceLanguageTests.Fixture()
        let assembly = fixture.Compile(source, "issue4493chain", executable: true)
        IlVerifier.Verify(assembly)
        AssertCovariantOverrideMetadata(assembly, "Middle", HandleKind.MethodDefinition)
        AssertCovariantOverrideMetadata(assembly, "Leaf", HandleKind.MethodDefinition)
        Assert.Equal(`LeafSymbol
LeafSymbol
`, fixture.Run(assembly))
    }

    @Theory
    @InlineData(`open class Base {
    open prop Property int32 {
        get;
    }
}
class Derived : Base {
    override prop Property string -> ""
}`)
    @InlineData(`open class Symbol { }
class PropertySymbol : Symbol { }
open class Base {
    open prop Property Symbol {
        get;
        set;
    }
}
class Derived : Base {
    override prop Property PropertySymbol {
        get;
        set;
    }
}`)
    func InvalidCovariantPropertyShapes_ReportGS0185(declarations string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(
            "package i4493invalid\n" + declarations,
            "issue4493invalid",
            executable: false
        )
        Assert.NotEqual(0, code)
        Assert.Equal(1, CountOccurrences(output, "error GS0185:"))
    }

    shared {
        private func AssertCovariantOverrideMetadata(assemblyPath string, typeName string, declarationKind HandleKind) {
            using let stream = File.OpenRead(assemblyPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let derived = FindType(reader, typeName)
            let getter = FindMethod(reader, derived, "get_Property")
            let getterDefinition = reader.GetMethodDefinition(getter)
            Assert.True((getterDefinition.Attributes & MethodAttributes.Virtual) != 0)
            Assert.True((getterDefinition.Attributes & MethodAttributes.NewSlot) != 0)
            let methodImpl = Assert.Single(
                reader.GetTypeDefinition(derived).GetMethodImplementations(),
                (handle MethodImplementationHandle) -> reader.GetMethodImplementation(handle).MethodBody == getter
            )
            let declaration = reader.GetMethodImplementation(methodImpl).MethodDeclaration
            Assert.Equal(declarationKind, declaration.Kind)
            Assert.True(HasPreserveBaseOverridesAttribute(reader, getter))
            if declarationKind == HandleKind.MemberReference {
                Assert.Equal(
                    HandleKind.TypeSpecification,
                    reader.GetMemberReference(MemberReferenceHandle(declaration)).Parent.Kind
                )
            }
        }

        private func HasPreserveBaseOverridesAttribute(reader MetadataReader, method MethodDefinitionHandle) bool {
            for attributeHandle in reader.GetMethodDefinition(method).GetCustomAttributes() {
                let attribute = reader.GetCustomAttribute(attributeHandle)
                if attribute.Constructor.Kind != HandleKind.MemberReference {
                    continue
                }
                let constructor = reader.GetMemberReference(MemberReferenceHandle(attribute.Constructor))
                if constructor.Parent.Kind != HandleKind.TypeReference {
                    continue
                }
                let attributeType = reader.GetTypeReference(TypeReferenceHandle(constructor.Parent))
                if reader.GetString(attributeType.Namespace) == "System.Runtime.CompilerServices" && reader.GetString(
                    attributeType.Name
                ) == "PreserveBaseOverridesAttribute" {
                    return true
                }
            }
            return false
        }

        private func CountOccurrences(text string, value string) int32 {
            var count = 0
            for var index = 0;
                (index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0;
                index += value.Length {
                count++
            }
            return count
        }

        private func FindType(reader MetadataReader, name string) TypeDefinitionHandle {
            for handle in reader.TypeDefinitions {
                if reader.GetString(reader.GetTypeDefinition(handle).Name) == name {
                    return handle
                }
            }
            throw InvalidOperationException("Type '$name' was not emitted.")
        }

        private func FindMethod(reader MetadataReader, type TypeDefinitionHandle, name string) MethodDefinitionHandle {
            for handle in reader.GetTypeDefinition(type).GetMethods() {
                if reader.GetString(reader.GetMethodDefinition(handle).Name) == name {
                    return handle
                }
            }
            throw InvalidOperationException("Method '$name' was not emitted.")
        }
    }
}
