// <copyright file="ImportedEnumAttributeEmitTests.cs" company="GSharp">
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

/// Regression tests for issue #418 (P1-8): emitting a custom attribute whose
/// named-arg member is an enum defined in a referenced (non-BCL) assembly
/// must not lose the attribute. Such enum (cref:System.Type) instances
/// are reified through a (cref:System.Reflection.MetadataLoadContext),
/// so the attribute-blob writer cannot call (cref:System.Enum.GetUnderlyingType)
/// (which is runtime-Type only and throws (cref:System.NotSupportedException)) —
/// it must instead read the `value__` instance field's type per
/// ECMA-335 II.14.3.
open class ImportedEnumAttributeEmitTests {
    @Fact
    func Emit_Imported_Enum_NamedArg_Is_Written_To_Blob() {
        // Before the fix, ReflectionMetadataEmitter.WriteCustomAttributeFixedArg
        // called Enum.GetUnderlyingType on the MetadataLoadContext-resolved
        // enum and threw NotSupportedException; the surrounding try/catch
        // would drop the attribute, so the emitted Tagged type carried zero
        // custom attributes. After the fix the attribute (and its enum
        // named-arg value) must round-trip through the blob.
        let source = `package Demo
import GSharp.Core.Tests.Fixtures

@ImportedEnumArg(Mode: ImportedAttributeMode.Warning)
class Tagged {
}`
        let compilation = CompileWithFixtures(source)
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream)
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        peStream.Position = 0
        using let peReader = PEReader(peStream, PEStreamOptions.LeaveOpen)
        let md = peReader.GetMetadataReader()
        let taggedDef = md
            .TypeDefinitions
            .Select(md.GetTypeDefinition)
            .Single((td TypeDefinition) -> md.GetString(td.Name) == "Tagged")
        // The Tagged type carries our fixture attribute plus an emitter-injected
        // [NullableContext(1)] (ADR-0136). Select the fixture attribute by its
        // constructor's declaring type rather than asserting a single attribute.
        let attr = taggedDef
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
                ) == "ImportedEnumArgAttribute"
            }
        )
        // The constructor reference must point at ImportedEnumArgAttribute..ctor.
        let ctorRef = md.GetMemberReference(MemberReferenceHandle(attr.Constructor))
        let attrTypeName = md.GetString(md.GetTypeReference(TypeReferenceHandle(ctorRef.Parent)).Name)
        Assert.Equal("ImportedEnumArgAttribute", attrTypeName)
        // Sanity: the blob is non-empty (prolog + zero positional args +
        // one named arg payload).
        let blob = md.GetBlobBytes(attr.Value)
        Assert.NotEmpty(blob)
    }

    @Fact
    func Emit_Imported_Enum_NamedArg_Roundtrips_Through_Reflection() {
        // Stronger check: load the emitted PE and read the attribute via
        // System.Reflection.CustomAttributeData. The named-arg enum value
        // must round-trip with its correct underlying int value.
        let source = `package Demo
import GSharp.Core.Tests.Fixtures

@ImportedEnumArg(Mode: ImportedAttributeMode.Warning)
class Tagged {
}`
        let compilation = CompileWithFixtures(source)
        using let peStream = MemoryStream()
        let emit = compilation.Emit(peStream)
        Assert.True(emit.Success, string.Join("; ", emit.Diagnostics.Select((d Diagnostic) -> d.Message)))
        peStream.Position = 0
        let loadContext = AssemblyLoadContext(
            "Emit_Imported_Enum_NamedArg_Roundtrips_Through_Reflection",
            isCollectible: true
        )
        try {
            // The emitted assembly references the fixture (test) assembly; the
            // loader needs to be told to reuse the test runtime's instance.
            loadContext.Resolving += (ctx AssemblyLoadContext, name AssemblyName) -> {
                if name.Name == typeof(ImportedEnumArgAttribute).Assembly.GetName().Name {
                    return typeof(ImportedEnumArgAttribute).Assembly
                }
                return nil
            }
            let asm = loadContext.LoadFromStream(peStream)
            let tagged = asm.GetTypes().Single((t Type) -> t.Name == "Tagged")
            let cad = CustomAttributeData.GetCustomAttributes(tagged).Single(
                (c CustomAttributeData) -> c.AttributeType == typeof(ImportedEnumArgAttribute)
            )
            Assert.Empty(cad.ConstructorArguments)
            let named = Assert.Single(cad.NamedArguments)
            Assert.Equal("Mode", named.MemberName)
            Assert.Equal(typeof(ImportedAttributeMode), named.TypedValue.ArgumentType)
            Assert.Equal(ImportedAttributeMode.Warning, ImportedAttributeMode(named.TypedValue.Value!!))
        } finally {
            loadContext.Unload()
        }
    }

    shared {
        private func FixtureResolver() ReferenceResolver {
            // Adding the test-assembly path forces every type from it to be
            // reified through a MetadataLoadContext when resolved by the compiler.
            let fixturePath = typeof(ImportedEnumArgAttribute).Assembly.Location
            return ReferenceResolver.WithReferences([]string{fixturePath})
        }

        private func CompileWithFixtures(source string) Compilation {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Compilation(FixtureResolver(), tree)
        }
    }
}
