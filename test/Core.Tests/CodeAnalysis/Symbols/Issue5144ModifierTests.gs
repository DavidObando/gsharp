// <copyright file="Issue5144ModifierTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import Xunit

/// ADR-0209 PR 2c-ii-a (#5144): custom modifiers as data beside the type, and the CallConv modifiers of function pointers.
open class Issue5144ModifierTests {
    @Fact
    func TheModifiersOfCompilerOutput_AreKeptAndAgreeWithTheContext() {
        using let fixture = CSharpFixture(
            "namespace N5144Mod { public class Holder { public volatile int Flag; public virtual void Read(in int value) {} public int Init { get; init; } } }",
            assemblyName: "Mods5144A"
        )
        using let resolver = HandleResolver([]string{fixture.AssemblyPath})
        let set = resolver.ImageSet!!
        let module = set.FindModule("Mods5144A")!!
        module.TryGetDefinition("N5144Mod.Holder", out var handle)
        let holder = module.GetTypeSymbol(handle)
        let flag = holder.Fields.First((f MetadataFieldSymbol) -> f.Name == "Flag")
        Assert.Equal(
            "System.Int32{req:System.Private.CoreLib!System.Runtime.CompilerServices.IsVolatile;opt:}",
            MetadataTypeKeys.Of(flag.FieldType) + MetadataModifiers.Format(flag.FieldType)
        )
        // The identity of a modified type is the identity of the type beneath it.
        Assert.Equal("System.Int32", MetadataTypeKeys.Of(flag.FieldType))
        Assert.Same(TypeSymbol.Int32, MetadataModifiers.Strip(flag.FieldType))
        let read = holder.Methods.First((m MetadataMethodSymbol) -> m.Name == "Read")
        Assert.Contains("value:", MetadataMemberComparison.DescribeMethod(read))
        Assert.Contains(
            "System.Int32&{req:System.Private.CoreLib!System.Runtime.InteropServices.InAttribute;opt:}",
            MetadataMemberComparison.DescribeMethod(read)
        )
        let setter = holder.Methods.First((m MetadataMethodSymbol) -> m.Name == "set_Init")
        Assert.Contains(
            "System.Void{req:System.Private.CoreLib!System.Runtime.CompilerServices.IsExternalInit;opt:}",
            MetadataMemberComparison.DescribeMethod(setter)
        )
        Assert.Empty(MetadataModelComparison.Compare(resolver, set))
    }

    @Fact
    func SeveralModifiers_KeepBlobOrder_AndRequiredAndOptionalAreListedApart() {
        let path = WriteImage(BuildModifierImage())
        using let resolver = HandleResolver([]string{path})
        let set = resolver.ImageSet!!
        let module = set.FindModule("Mods5144B")!!
        module.TryGetDefinition("N5144B.S", out var handle)
        let shapes = module.GetTypeSymbol(handle)
        let ordered = shapes.Fields.First((f MetadataFieldSymbol) -> f.Name == "Ordered")
        // Blob order: modopt(IsConst) modreq(IsVolatile) modopt(IsExternalInit).
        Assert.Equal(
            []string{
                "System.Private.CoreLib!System.Runtime.CompilerServices.IsConst",
                "System.Private.CoreLib!System.Runtime.CompilerServices.IsVolatile",
                "System.Private.CoreLib!System.Runtime.CompilerServices.IsExternalInit"
            },
            MetadataModifiers
                .Of(ordered.FieldType)
                .Select((m MetadataCustomModifier) -> MetadataTypeKeys.Of(m.Type))
                .ToArray()
        )
        Assert.Equal(
            []bool{false, true, false},
            MetadataModifiers.Of(ordered.FieldType).Select((m MetadataCustomModifier) -> m.IsRequired).ToArray()
        )
        Assert.Equal(
            "{req:System.Private.CoreLib!System.Runtime.CompilerServices.IsVolatile;opt:System.Private.CoreLib!System.Runtime.CompilerServices.IsConst,System.Private.CoreLib!System.Runtime.CompilerServices.IsExternalInit}",
            MetadataModifiers.Format(ordered.FieldType)
        )
        Assert.True(
            MetadataModelComparison.Compare(resolver, set).Count == 0,
            MetadataModelComparison.FormatReport(MetadataModelComparison.Compare(resolver, set))
        )
    }

    @Fact
    func AModifierTheSetLacks_MakesOnlyThatMemberSignatureMissing() {
        let path = WriteImage(BuildModifierImage())
        using let resolver = HandleResolver([]string{path})
        let set = resolver.ImageSet!!
        let module = set.FindModule("Mods5144B")!!
        module.TryGetDefinition("N5144B.S", out var handle)
        let shapes = module.GetTypeSymbol(handle)
        let gone = shapes.Fields.First((f MetadataFieldSymbol) -> f.Name == "GoneModifier")
        let plain = shapes.Fields.First((f MetadataFieldSymbol) -> f.Name == "Plain")
        Assert.True(MetadataTypeKeys.ContainsMissing(gone.FieldType))
        Assert.EndsWith("|signature-missing", MetadataMemberComparison.DescribeField(gone))
        Assert.EndsWith("|System.Int32", MetadataMemberComparison.DescribeField(plain))
    }

    @Fact
    func TheCallingConventionOfAFunctionPointer_IsTheCallConvModifierOfItsReturnType() {
        let path = WriteImage(BuildModifierImage())
        using let resolver = HandleResolver([]string{path})
        let module = resolver.ImageSet!!.FindModule("Mods5144B")!!
        module.TryGetDefinition("N5144B.S", out var handle)
        let pointerField = module.GetTypeSymbol(handle).Fields.First((f MetadataFieldSymbol) -> f.Name == "Callback")
        Assert.IsType[MetadataFunctionPointerTypeSymbol](pointerField.FieldType)
        let pointer = cast[MetadataFunctionPointerTypeSymbol](pointerField.FieldType)
        Assert.Equal(
            []string{"System.Private.CoreLib!System.Runtime.CompilerServices.CallConvCdecl"},
            pointer.UnmanagedConventions.Select((t TypeSymbol) -> MetadataTypeKeys.Of(t)).ToArray()
        )
        // A modifier that is not a calling convention is not one.
        Assert.Equal(1, MetadataModifiers.Of(pointer.ReturnType).Length)
        Assert.True(MetadataModifiers.IsCallingConvention(MetadataModifiers.Of(pointer.ReturnType)[0].Type))
        Assert.False(MetadataModifiers.IsCallingConvention(TypeSymbol.Int32))
    }

    shared {
        private func HandleResolver(paths[]string) ReferenceResolver {
            using let override_ = MetadataModel.Override(MetadataModelMode.Handles)
            return ReferenceResolver.WithReferences(paths)
        }

        private func WriteImage(image[]uint8) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "csharp-fixtures", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            let path = Path.Combine(directory, "Mods5144B.dll")
            File.WriteAllBytes(path, image)
            return path
        }

        // Writes an assembly with one type S and four fields:
        //   Ordered      int with modopt(IsConst) modreq(IsVolatile) modopt(IsExternalInit)
        //   GoneModifier int with modreq of a type from an assembly that is not supplied
        //   Plain        int
        //   Callback     an unmanaged function pointer to void() with modopt(CallConvCdecl) on its return type
        private func BuildModifierImage()[]uint8 {
            let metadata = MetadataBuilder()
            metadata.AddModule(
                0,
                metadata.GetOrAddString("Mods5144B.dll"),
                metadata.GetOrAddGuid(Guid.NewGuid()),
                GuidHandle(),
                GuidHandle()
            )
            metadata.AddAssembly(
                metadata.GetOrAddString("Mods5144B"),
                Version(1, 0, 0, 0),
                StringHandle(),
                BlobHandle(),
                cast[AssemblyFlags](0),
                AssemblyHashAlgorithm.None
            )
            let runtime = metadata.AddAssemblyReference(
                metadata.GetOrAddString("System.Runtime"),
                Version(10, 0, 0, 0),
                StringHandle(),
                BlobHandle(),
                cast[AssemblyFlags](0),
                BlobHandle()
            )
            let absent = metadata.AddAssemblyReference(
                metadata.GetOrAddString("Absent5144B"),
                Version(1, 0, 0, 0),
                StringHandle(),
                BlobHandle(),
                cast[AssemblyFlags](0),
                BlobHandle()
            )
            let isConst = metadata.AddTypeReference(
                runtime,
                metadata.GetOrAddString("System.Runtime.CompilerServices"),
                metadata.GetOrAddString("IsConst")
            )
            let isVolatile = metadata.AddTypeReference(
                runtime,
                metadata.GetOrAddString("System.Runtime.CompilerServices"),
                metadata.GetOrAddString("IsVolatile")
            )
            let isExternalInit = metadata.AddTypeReference(
                runtime,
                metadata.GetOrAddString("System.Runtime.CompilerServices"),
                metadata.GetOrAddString("IsExternalInit")
            )
            let cdecl = metadata.AddTypeReference(
                runtime,
                metadata.GetOrAddString("System.Runtime.CompilerServices"),
                metadata.GetOrAddString("CallConvCdecl")
            )
            let gone = metadata.AddTypeReference(
                absent,
                metadata.GetOrAddString("N5144B"),
                metadata.GetOrAddString("Gone")
            )
            metadata.AddTypeDefinition(
                cast[TypeAttributes](0),
                StringHandle(),
                metadata.GetOrAddString("<Module>"),
                EntityHandle(),
                MetadataTokens.FieldDefinitionHandle(1),
                MetadataTokens.MethodDefinitionHandle(1)
            )
            metadata.AddTypeDefinition(
                TypeAttributes.Public,
                metadata.GetOrAddString("N5144B"),
                metadata.GetOrAddString("S"),
                EntityHandle(),
                MetadataTokens.FieldDefinitionHandle(1),
                MetadataTokens.MethodDefinitionHandle(1)
            )

            metadata.AddFieldDefinition(
                FieldAttributes.Public,
                metadata.GetOrAddString("Ordered"),
                metadata.GetOrAddBlob(OrderedField(isConst, isVolatile, isExternalInit))
            )
            metadata.AddFieldDefinition(
                FieldAttributes.Public,
                metadata.GetOrAddString("GoneModifier"),
                metadata.GetOrAddBlob(ModifiedField(gone))
            )
            metadata.AddFieldDefinition(
                FieldAttributes.Public,
                metadata.GetOrAddString("Plain"),
                metadata.GetOrAddBlob(PlainField())
            )
            metadata.AddFieldDefinition(
                FieldAttributes.Public,
                metadata.GetOrAddString("Callback"),
                metadata.GetOrAddBlob(CallbackField(cdecl))
            )
            let image = BlobBuilder()
            ManagedPEBuilder(
                PEHeaderBuilder.CreateLibraryHeader(),
                MetadataRootBuilder(metadata),
                BlobBuilder()
            ).Serialize(image)
            return image.ToArray()
        }

        private func OrderedField(
            isConst EntityHandle,
            isVolatile EntityHandle,
            isExternalInit EntityHandle
        ) BlobBuilder {
            let blob = BlobBuilder()
            let field = BlobEncoder(blob).FieldSignature()
            field
                .CustomModifiers()
                .AddModifier(isConst, true)
                .AddModifier(isVolatile, false)
                .AddModifier(isExternalInit, true)
            field.Int32()
            return blob
        }

        private func ModifiedField(modifier EntityHandle) BlobBuilder {
            let blob = BlobBuilder()
            let field = BlobEncoder(blob).FieldSignature()
            field.CustomModifiers().AddModifier(modifier, false)
            field.Int32()
            return blob
        }

        private func PlainField() BlobBuilder {
            let blob = BlobBuilder()
            BlobEncoder(blob).FieldSignature().Int32()
            return blob
        }

        private func CallbackField(cdecl EntityHandle) BlobBuilder {
            let blob = BlobBuilder()
            let signature = BlobEncoder(blob).FieldSignature().FunctionPointer(
                SignatureCallingConvention.Unmanaged,
                FunctionPointerAttributes.None,
                0
            )
            var returnType ReturnTypeEncoder = default(ReturnTypeEncoder)
            var parameters ParametersEncoder = default(ParametersEncoder)
            signature.Parameters(0, out returnType, out parameters)
            returnType.CustomModifiers().AddModifier(cdecl, true)
            returnType.Void()
            return blob
        }
    }
}
