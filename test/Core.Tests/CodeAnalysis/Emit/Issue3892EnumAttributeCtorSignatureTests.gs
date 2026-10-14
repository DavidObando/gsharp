// <copyright file="Issue3892EnumAttributeCtorSignatureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests.Fixtures
import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import Xunit

/// Issue #3892: an attribute constructor taking an ENUM emitted a
/// `MemberRef` whose signature named the enum's UNDERLYING type, so
/// `[AttributeUsage(AttributeTargets.Class)]` encoded as
/// `AttributeUsageAttribute..ctor(Int32)` — a constructor that does not
/// exist. The assembly loaded, but the moment reflection touched the attribute
/// (which is exactly what xunit discovery does when it enumerates types) the
/// runtime threw `MissingMethodException`, surfacing as the
/// `NO-TESTS-RAN` parity failure on migrated `test/Core.Tests`.
///
/// The cause was applying ECMA-335 II.23.3 — which says the enum-typed *value*
/// in a custom-attribute blob is serialised as its underlying type, and which
/// remains correct in `WriteCustomAttributeFixedArg` — to the method
/// SIGNATURE as well. II.23.2.12 requires the signature parameter to be
/// `ELEMENT_TYPE_VALUETYPE` followed by a TypeDefOrRef coded index naming
/// the enum itself.
///
/// The defect is general to any attribute constructor parameter of enum type,
/// not specific to `AttributeUsageAttribute`; both are covered below, as
/// is the anti-vacuity case that a genuinely (cref:int)-typed parameter
/// must still encode as `ELEMENT_TYPE_I4`.
open class Issue3892EnumAttributeCtorSignatureTests {
    /// The reported instance: `[AttributeUsage(AttributeTargets.Class)]`.
    /// FAILS on origin/main — the parameter encodes as `ELEMENT_TYPE_I4`.
    @Fact
    func AttributeUsage_EnumParameter_EncodesAsEnumValueTypeRef_NotInt32() {
        const Source = `package Issue3892Usage
import System

@AttributeUsage(AttributeTargets.Class)
class MarkerAttribute : Attribute {
}

@Marker
class Marked {
}`
        using let pe = EmitOrThrow(Compile(Source))
        using let peReader = PEReader(pe, PEStreamOptions.LeaveOpen)
        let md = peReader.GetMetadataReader()
        let markerDef = md
            .TypeDefinitions
            .Select(md.GetTypeDefinition)
            .Single((td TypeDefinition) -> md.GetString(td.Name) == "MarkerAttribute")
        let usage = FindAttributeByCtorParentName(md, markerDef, "AttributeUsageAttribute")
        let (elementType, typeName) = DecodeSingleCtorParameter(md, MemberReferenceHandle(usage.Constructor))
        Assert.Equal(ElementTypeValueType, elementType)
        Assert.Equal("AttributeTargets", typeName)
    }

    /// The load-time proof: enumerate the emitted assembly's exported types and
    /// materialise their attributes the way xunit discovery does. On
    /// origin/main this throws
    /// `MissingMethodException: AttributeUsageAttribute..ctor(Int32)`.
    /// ILVerify does NOT catch this (it resolves references by name and accepts
    /// the wrong element type — see #3764), so the assertion has to be a real
    /// load.
    @Fact
    func AttributeUsage_MarkedType_SurvivesReflectionDiscovery() {
        const Source = `package Issue3892Discovery
import System

@AttributeUsage(AttributeTargets.Class)
class MarkerAttribute : Attribute {
}

@Marker
class Marked {
}`
        using let pe = EmitOrThrow(Compile(Source))
        let loadContext = AssemblyLoadContext(
            "AttributeUsage_MarkedType_SurvivesReflectionDiscovery",
            isCollectible: true
        )
        try {
            let asm = loadContext.LoadFromStream(pe)
            // GetExportedTypes() is the call xunit's discoverer makes first.
            let exported = asm.GetExportedTypes()
            let marker = Assert.Single(exported, (t Type) -> t.Name == "MarkerAttribute")
            let marked = Assert.Single(exported, (t Type) -> t.Name == "Marked")
            // Resolving [AttributeUsage] on the attribute type is what the
            // runtime does while materialising @Marker on `Marked`; with an
            // Int32-typed MemberRef this is the MissingMethodException site.
            let usage AttributeUsageAttribute? = marker.GetCustomAttribute[AttributeUsageAttribute]()
            Assert.NotNull(usage)
            Assert.Equal(AttributeTargets.Class, usage!!.ValidOn)
            let applied = marked.GetCustomAttributes(inherit: true)
            Assert.Contains(applied, (a object) -> a.GetType().Name == "MarkerAttribute")
        } finally {
            loadContext.Unload()
        }
    }

    /// Generality: the defect is not `AttributeUsage`-specific. Any
    /// attribute constructor with an enum-typed positional parameter was
    /// mis-encoded. FAILS on origin/main.
    @Fact
    func UserAttribute_EnumCtorParameter_EncodesAsEnumValueTypeRef_AndRoundTrips() {
        const Source = `package Issue3892General
import GSharp.Core.Tests.Fixtures

@ImportedEnumCtor(ImportedAttributeMode.Warning)
class Tagged {
}`
        using let pe = EmitOrThrow(CompileWithFixtures(Source))
        {
            using let peReader = PEReader(pe, PEStreamOptions.LeaveOpen)
            let md = peReader.GetMetadataReader()
            let taggedDef = md
                .TypeDefinitions
                .Select(md.GetTypeDefinition)
                .Single((td TypeDefinition) -> md.GetString(td.Name) == "Tagged")
            let attr = FindAttributeByCtorParentName(md, taggedDef, "ImportedEnumCtorAttribute")
            let (elementType, typeName) = DecodeSingleCtorParameter(md, MemberReferenceHandle(attr.Constructor))
            Assert.Equal(ElementTypeValueType, elementType)
            Assert.Equal("ImportedAttributeMode", typeName)
        }
        pe.Position = 0
        let loadContext = AssemblyLoadContext(
            "UserAttribute_EnumCtorParameter_EncodesAsEnumValueTypeRef_AndRoundTrips",
            isCollectible: true
        )
        try {
            loadContext.Resolving += (ctx AssemblyLoadContext, name AssemblyName) -> if name.Name == typeof(
                ImportedEnumCtorAttribute
            )
                .Assembly
                .GetName()
                .Name {
                typeof(ImportedEnumCtorAttribute).Assembly
            } else {
                default(Assembly?)
            }
            let asm = loadContext.LoadFromStream(pe)
            let tagged = Assert.Single(asm.GetExportedTypes(), (t Type) -> t.Name == "Tagged")
            // Materialising the attribute instance (not just reading metadata)
            // is what actually invokes the referenced constructor.
            let instance = tagged.GetCustomAttributes(inherit: false).OfType[ImportedEnumCtorAttribute]().Single()
            Assert.Equal(ImportedAttributeMode.Warning, instance.Mode)
        } finally {
            loadContext.Unload()
        }
    }

    /// Anti-vacuity: a constructor parameter that is genuinely (cref:int)
    /// must STILL encode as `ELEMENT_TYPE_I4`. This test passes on
    /// origin/main and guards against "fixing" #3892 by encoding every
    /// integral parameter as a value-type reference.
    @Fact
    func UserAttribute_Int32CtorParameter_StillEncodesAsInt32() {
        const Source = `package Issue3892AntiVacuity
import GSharp.Core.Tests.Fixtures

@ImportedInt32Ctor(42)
class Tagged {
}`
        using let pe = EmitOrThrow(CompileWithFixtures(Source))
        {
            using let peReader = PEReader(pe, PEStreamOptions.LeaveOpen)
            let md = peReader.GetMetadataReader()
            let taggedDef = md
                .TypeDefinitions
                .Select(md.GetTypeDefinition)
                .Single((td TypeDefinition) -> md.GetString(td.Name) == "Tagged")
            let attr = FindAttributeByCtorParentName(md, taggedDef, "ImportedInt32CtorAttribute")
            let (elementType, typeName) = DecodeSingleCtorParameter(md, MemberReferenceHandle(attr.Constructor))
            Assert.Equal(ElementTypeI4, elementType)
            Assert.Equal(string.Empty, typeName)
        }
        pe.Position = 0
        let loadContext = AssemblyLoadContext(
            "UserAttribute_Int32CtorParameter_StillEncodesAsInt32",
            isCollectible: true
        )
        try {
            loadContext.Resolving += (ctx AssemblyLoadContext, name AssemblyName) -> if name.Name == typeof(
                ImportedInt32CtorAttribute
            )
                .Assembly
                .GetName()
                .Name {
                typeof(ImportedInt32CtorAttribute).Assembly
            } else {
                default(Assembly?)
            }
            let asm = loadContext.LoadFromStream(pe)
            let tagged = Assert.Single(asm.GetExportedTypes(), (t Type) -> t.Name == "Tagged")
            let instance = tagged.GetCustomAttributes(inherit: false).OfType[ImportedInt32CtorAttribute]().Single()
            Assert.Equal(42, instance.Value)
        } finally {
            loadContext.Unload()
        }
    }

    shared {
        private const ElementTypeVoid uint8 = uint8(0x01)
        private const ElementTypeI4 uint8 = uint8(0x08)
        private const ElementTypeValueType uint8 = uint8(0x11)

        /// Decodes the single positional parameter of a `.ctor` MemberRef
        /// signature, returning its leading element-type byte and — for a
        /// VALUETYPE/CLASS parameter — the simple name of the type it references.
        private func DecodeSingleCtorParameter(md MetadataReader, ctorHandle MemberReferenceHandle)(
            ElementType uint8,
            TypeName string
        ) {
            var reader = md.GetBlobReader(md.GetMemberReference(ctorHandle).Signature)
            var header = reader.ReadSignatureHeader()
            Assert.True(header.IsInstance, "an attribute .ctor signature is HASTHIS")
            let parameterCount = reader.ReadCompressedInteger()
            Assert.Equal(1, parameterCount)
            Assert.Equal(ElementTypeVoid, reader.ReadByte())
            let elementType = reader.ReadByte()
            if elementType == ElementTypeValueType || elementType == uint8(0x12) {
                let typeHandle = reader.ReadTypeHandle()
                let name = switch typeHandle.Kind {
                    case HandleKind.TypeReference: md.GetString(
                        md.GetTypeReference(TypeReferenceHandle(typeHandle)).Name
                    )
                    case HandleKind.TypeDefinition: md.GetString(
                        md.GetTypeDefinition(TypeDefinitionHandle(typeHandle)).Name
                    )
                    default: string.Empty
                }
                return (elementType, name)
            }
            return (elementType, string.Empty)
        }

        private func FindAttributeByCtorParentName(
            md MetadataReader,
            owner TypeDefinition,
            attributeTypeName string
        ) CustomAttribute -> owner
            .GetCustomAttributes()
            .Select(md.GetCustomAttribute)
            .Single(
            (a CustomAttribute) -> {
                if a.Constructor.Kind != HandleKind.MemberReference {
                    return false
                }
                let cr = md.GetMemberReference(MemberReferenceHandle(a.Constructor))
                return cr.Parent.Kind == HandleKind.TypeReference && md.GetString(
                    md.GetTypeReference(TypeReferenceHandle(cr.Parent)).Name
                ) == attributeTypeName
            }
        )

        private func EmitOrThrow(compilation Compilation) MemoryStream {
            let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            return peStream
        }

        private func CompileWithFixtures(source string) Compilation {
            let fixturePath = typeof(ImportedEnumCtorAttribute).Assembly.Location
            let resolver = ReferenceResolver.WithReferences([]string{fixturePath})
            return Compilation(resolver, SyntaxTree.Parse(SourceText.From(source)))
        }

        private func Compile(source string) Compilation -> Compilation(SyntaxTree.Parse(SourceText.From(source)))
    }
}
