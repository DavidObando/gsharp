// <copyright file="GenericRemapPrecedenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import Xunit

class GenericRemapPrecedenceTests {
    @Fact
    func ImportedElementToken_MethodTypeParameter_PrefersStateMachineRemap() {
        let typeParameter = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None){
            IsMethodTypeParameter = true
        }
        AssertEncoding(typeParameter, SignatureTypeCode.GenericTypeParameter, expectedOrdinal: 1)
    }

    @Fact
    func ImportedElementToken_MethodTypeParameter_UsesLambdaRemapWithoutStateMachine() {
        let typeParameter = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None){
            IsMethodTypeParameter = true
        }
        AssertEncoding(
            typeParameter,
            SignatureTypeCode.GenericMethodParameter,
            expectedOrdinal: 2,
            includeStateMachineRemap: false
        )
    }

    @Fact
    func ImportedElementToken_ClassTypeParameter_PrefersStateMachineRemap() {
        let typeParameter = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        AssertEncoding(typeParameter, SignatureTypeCode.GenericTypeParameter, expectedOrdinal: 1)
    }

    shared {
        private let Package PackageSymbol = PackageSymbol("main", declaration: nil)

        private func AssertEncoding(
            typeParameter TypeParameterSymbol,
            expectedCode SignatureTypeCode,
            expectedOrdinal int32,
            includeStateMachineRemap bool = true
        ) {
            let emitter = CreateEmitter()
            let stateMachine = StructSymbol(
                "StateMachine",
                ImmutableArray[FieldSymbol].Empty,
                Accessibility.Internal,
                declaration: nil,
                packageName: Package.Name,
                isData: false,
                isInline: false,
                isClass: true
            )
            let lambda = FunctionSymbol(
                "lambda",
                ImmutableArray[ParameterSymbol].Empty,
                TypeSymbol.Void,
                $package: Package
            )
            if includeStateMachineRemap {
                emitter.remaps.RegisterClassRemap(
                    stateMachine,
                    Dictionary[TypeParameterSymbol, int32]{[typeParameter] = 1}
                )
            }
            emitter.remaps.RegisterLambdaMethodRemap(
                lambda,
                Dictionary[TypeParameterSymbol, int32]{[typeParameter] = 2}
            )
            emitter
                .emitCtx
                .Metadata
                .AddModule(
                0,
                emitter.emitCtx.Metadata.GetOrAddString("test"),
                emitter.emitCtx.Metadata.GetOrAddGuid(Guid.Empty),
                default(GuidHandle),
                default(GuidHandle)
            )
            var handle EntityHandle
            {
                using let _ = emitter.remaps.PushLambdaMethodRemap(lambda)
                {
                    using let _ = emitter.remaps.PushSmRemap(stateMachine)
                    handle = emitter.memberRefs.GetElementTypeToken(typeParameter)
                }
            }
            let metadata = BlobBuilder()
            MetadataRootBuilder(emitter.emitCtx.Metadata).Serialize(metadata, 0, 0)
            using let provider = MetadataReaderProvider.FromMetadataImage(metadata.ToImmutableArray())
            let reader = provider.GetMetadataReader()
            let specification = reader.GetTypeSpecification(TypeSpecificationHandle(handle))
            var signature = reader.GetBlobReader(specification.Signature)
            Assert.Equal(expectedCode, signature.ReadSignatureTypeCode())
            Assert.Equal(expectedOrdinal, signature.ReadCompressedInteger())
        }

        private func CreateEmitter() ReflectionMetadataEmitter {
            let program = BoundProgram(
                Package,
                ImmutableArray.Create(Package),
                ImmutableArray[Diagnostic].Empty,
                ImmutableDictionary[FunctionSymbol, BoundBlockStatement].Empty,
                entryPoint: nil,
                statement: BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty),
                structs: ImmutableArray[StructSymbol].Empty,
                interfaces: ImmutableArray[InterfaceSymbol].Empty
            )
            let constructor = typeof(ReflectionMetadataEmitter).GetConstructors(
                BindingFlags.Instance | BindingFlags.NonPublic
            )
                .Single()
            return cast[ReflectionMetadataEmitter](
                constructor.Invoke(
                    []object? {program, ReferenceResolver.Default(), "GenericRemapPrecedenceTests", false, nil}
                )
            )
        }
    }
}
