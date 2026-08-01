// <copyright file="GenericRemapPrecedenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

public sealed class GenericRemapPrecedenceTests
{
    private static readonly PackageSymbol Package = new PackageSymbol("main", declaration: null);

    [Fact]
    public void ImportedElementToken_MethodTypeParameter_PrefersStateMachineRemap()
    {
        var typeParameter = new TypeParameterSymbol(
            "T",
            0,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None)
        {
            IsMethodTypeParameter = true,
        };

        AssertEncoding(
            typeParameter,
            SignatureTypeCode.GenericTypeParameter,
            expectedOrdinal: 1);
    }

    [Fact]
    public void ImportedElementToken_ClassTypeParameter_UsesLambdaRemap()
    {
        var typeParameter = new TypeParameterSymbol(
            "T",
            0,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None);

        AssertEncoding(
            typeParameter,
            SignatureTypeCode.GenericMethodParameter,
            expectedOrdinal: 2);
    }

    private static void AssertEncoding(
        TypeParameterSymbol typeParameter,
        SignatureTypeCode expectedCode,
        int expectedOrdinal)
    {
        var emitter = CreateEmitter();
        var stateMachine = new StructSymbol(
            "StateMachine",
            ImmutableArray<FieldSymbol>.Empty,
            Accessibility.Internal,
            declaration: null,
            packageName: Package.Name,
            isData: false,
            isInline: false,
            isClass: true);
        var lambda = new FunctionSymbol(
            "lambda",
            ImmutableArray<ParameterSymbol>.Empty,
            TypeSymbol.Void,
            package: Package);

        emitter.remaps.RegisterClassRemap(
            stateMachine,
            new Dictionary<TypeParameterSymbol, int> { [typeParameter] = 1 });
        emitter.remaps.RegisterLambdaMethodRemap(
            lambda,
            new Dictionary<TypeParameterSymbol, int> { [typeParameter] = 2 });

        emitter.emitCtx.Metadata.AddModule(
            0,
            emitter.emitCtx.Metadata.GetOrAddString("test"),
            emitter.emitCtx.Metadata.GetOrAddGuid(Guid.Empty),
            default,
            default);

        EntityHandle handle;
        using (emitter.remaps.PushLambdaMethodRemap(lambda))
        using (emitter.remaps.PushSmRemap(stateMachine))
        {
            handle = emitter.memberRefs.GetElementTypeToken(typeParameter);
        }

        var metadata = new BlobBuilder();
        new MetadataRootBuilder(emitter.emitCtx.Metadata).Serialize(metadata, 0, 0);

        using var provider = MetadataReaderProvider.FromMetadataImage(metadata.ToImmutableArray());
        var reader = provider.GetMetadataReader();
        var specification = reader.GetTypeSpecification((TypeSpecificationHandle)handle);
        var signature = reader.GetBlobReader(specification.Signature);

        Assert.Equal(expectedCode, signature.ReadSignatureTypeCode());
        Assert.Equal(expectedOrdinal, signature.ReadCompressedInteger());
    }

    private static ReflectionMetadataEmitter CreateEmitter()
    {
        var program = new BoundProgram(
            Package,
            ImmutableArray.Create(Package),
            ImmutableArray<Diagnostic>.Empty,
            ImmutableDictionary<FunctionSymbol, BoundBlockStatement>.Empty,
            entryPoint: null,
            statement: new BoundBlockStatement(null, ImmutableArray<BoundStatement>.Empty),
            structs: ImmutableArray<StructSymbol>.Empty,
            interfaces: ImmutableArray<InterfaceSymbol>.Empty);
        var constructor = typeof(ReflectionMetadataEmitter)
            .GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic)
            .Single();

        return (ReflectionMetadataEmitter)constructor.Invoke(new object[]
        {
            program,
            ReferenceResolver.Default(),
            "GenericRemapPrecedenceTests",
            false,
            null,
        });
    }
}
