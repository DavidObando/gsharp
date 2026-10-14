// <copyright file="Issue4214ImportedParameterModifierTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System
import System.IO
import System.Reflection
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.CompilerServices
import Xunit

open class Issue4214ImportedParameterModifierTests {
    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func ImportedMethodAndConstructor_PreserveParameterModifiers(metadataReferences bool, required bool) {
        let directory = Path.Combine(AppContext.BaseDirectory, "parameter-modifiers", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let name = "ModifierContract" + Guid.NewGuid().ToString("N")
            let path = Path.Combine(directory, name + ".dll")
            let builder = PersistedAssemblyBuilder(AssemblyName(name), typeof(object).Assembly)
            let module = builder.DefineDynamicModule(name)
            let type = module.DefineType("ModifierContract.API", TypeAttributes.Public)
            let field = type.DefineField("Value", typeof(int32), FieldAttributes.Public)
            let parameterTypes = []Type{typeof(int32)}
            let modifiers = [][]Type{[]Type{typeof(IsConst)}}
            let requiredModifiers[]?[]Type = if required {
                modifiers
            } else {
                default([]?[]Type)
            }
            let optionalModifiers[]?[]Type = if required {
                default([]?[]Type)
            } else {
                modifiers
            }
            let constructor = type.DefineConstructor(
                MethodAttributes.Public,
                CallingConventions.Standard,
                parameterTypes,
                requiredModifiers,
                optionalModifiers
            )
            let constructorIl = constructor.GetILGenerator()
            constructorIl.Emit(OpCodes.Ldarg_0)
            constructorIl.Emit(OpCodes.Call, typeof(object).GetConstructor(Type.EmptyTypes)!!)
            constructorIl.Emit(OpCodes.Ldarg_0)
            constructorIl.Emit(OpCodes.Ldarg_1)
            constructorIl.Emit(OpCodes.Stfld, field)
            constructorIl.Emit(OpCodes.Ret)
            let method = type.DefineMethod(
                "Take",
                MethodAttributes.Public,
                CallingConventions.Standard,
                typeof(int32),
                nil,
                nil,
                parameterTypes,
                requiredModifiers,
                optionalModifiers
            )
            let methodIl = method.GetILGenerator()
            methodIl.Emit(OpCodes.Ldarg_0)
            methodIl.Emit(OpCodes.Ldfld, field)
            methodIl.Emit(OpCodes.Ldarg_1)
            methodIl.Emit(OpCodes.Add)
            methodIl.Emit(OpCodes.Ret)
            type.CreateType()
            builder.Save(path)
            using let references = if metadataReferences {
                ReferenceResolver.WithReferences([]string{path})
            } else {
                ReferenceResolver.WithRuntimeReferences([]string{path})
            }
            Assert.True(references.TryResolveType("ModifierContract.API", out var api))
            for member in[]MethodBase{Assert.Single(api.GetConstructors()), api.GetMethod("Take")!!} {
                let parameter = Assert.Single(member.GetParameters())
                Assert.Single(
                    if required {
                        parameter.GetRequiredCustomModifiers()
                    } else {
                        parameter.GetOptionalCustomModifiers()
                    }
                )
            }
            let consumer = Compilation(references, SyntaxTree.Parse(`package ModifierConsumer
import ModifierContract
class Runner {
    shared { func Run() int32 -> API(4).Take(6) }
}`)){IsLibrary = true}
            using let output = MemoryStream()
            let result = consumer.Emit(output)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            let image = output.ToArray()
            using let pe = PEReader(MemoryStream(image))
            let metadata = pe.GetMetadataReader()
            var checkedMembers = 0
            for handle in metadata.MemberReferences {
                let member = metadata.GetMemberReference(handle)
                let memberName = metadata.GetString(member.Name)
                if member.Parent.Kind != HandleKind.TypeReference || (memberName != ".ctor" && memberName != "Take") {
                    continue
                }
                let owner = metadata.GetTypeReference(TypeReferenceHandle(member.Parent))
                if metadata.GetString(owner.Namespace) != "ModifierContract" {
                    continue
                }
                var signature = metadata.GetBlobReader(member.Signature)
                signature.ReadSignatureHeader()
                Assert.Equal(1, signature.ReadCompressedInteger())
                signature.ReadSignatureTypeCode()
                Assert.Equal(
                    if required {
                        SignatureTypeCode.RequiredModifier
                    } else {
                        SignatureTypeCode.OptionalModifier
                    },
                    signature.ReadSignatureTypeCode()
                )
                checkedMembers++
            }
            Assert.Equal(2, checkedMembers)
            let assembly = EmittedFixture.Load(image, directory)
            Assert.Equal(10, assembly.GetType("ModifierConsumer.Runner")!!.GetMethod("Run")!!.Invoke(nil, nil))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedInParameter_ResolvesItsRequiredModifier(metadataReferences bool) {
        let directory = Path.Combine(AppContext.BaseDirectory, "in-parameter-contracts", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let name = "InContract"
            let path = Path.Combine(directory, name + ".dll")
            {
                using let stream = File.Create(path)
                let contract = Compilation(SyntaxTree.Parse(`package InContract
class API {
    shared { func Take(in value int32) int32 -> value }
}`)){IsLibrary = true, AssemblyName = name}
                let emitted = contract.Emit(stream)
                Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            }
            using let references = if metadataReferences {
                ReferenceResolver.WithReferences([]string{path})
            } else {
                ReferenceResolver.WithRuntimeReferences([]string{path})
            }
            Assert.True(references.TryResolveType("InContract.API", out var api))
            let parameter = Assert.Single(api.GetMethod("Take")!!.GetParameters())
            Assert.NotEmpty(parameter.GetRequiredCustomModifiers())
            let consumer = Compilation(references, SyntaxTree.Parse(`package InConsumer
import InContract
class Runner {
    shared {
        func Run() int32 {
            var value = 6
            return API.Take(in value)
        }
    }
}`)){IsLibrary = true}
            using let output = MemoryStream()
            let result = consumer.Emit(output)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            let assembly = EmittedFixture.Load(output.ToArray(), directory)
            Assert.Equal(6, assembly.GetType("InConsumer.Runner")!!.GetMethod("Run")!!.Invoke(nil, nil))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }
}
