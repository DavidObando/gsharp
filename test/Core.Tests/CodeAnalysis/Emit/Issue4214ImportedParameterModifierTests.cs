// <copyright file="Issue4214ImportedParameterModifierTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.CompilerServices;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

public class Issue4214ImportedParameterModifierTests
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void ImportedMethodAndConstructor_PreserveParameterModifiers(bool metadataReferences, bool required)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "parameter-modifiers", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var name = "ModifierContract" + Guid.NewGuid().ToString("N");
            var path = Path.Combine(directory, name + ".dll");
            var builder = new PersistedAssemblyBuilder(new AssemblyName(name), typeof(object).Assembly);
            var module = builder.DefineDynamicModule(name);
            var type = module.DefineType("ModifierContract.API", TypeAttributes.Public);
            var field = type.DefineField("Value", typeof(int), FieldAttributes.Public);
            var parameterTypes = new[] { typeof(int) };
            var modifiers = new[] { new[] { typeof(IsConst) } };
            var requiredModifiers = required ? modifiers : null;
            var optionalModifiers = required ? null : modifiers;
            var constructor = type.DefineConstructor(
                MethodAttributes.Public, CallingConventions.Standard,
                parameterTypes, requiredModifiers, optionalModifiers);
            var constructorIl = constructor.GetILGenerator();
            constructorIl.Emit(OpCodes.Ldarg_0);
            constructorIl.Emit(OpCodes.Call, typeof(object).GetConstructor(Type.EmptyTypes));
            constructorIl.Emit(OpCodes.Ldarg_0);
            constructorIl.Emit(OpCodes.Ldarg_1);
            constructorIl.Emit(OpCodes.Stfld, field);
            constructorIl.Emit(OpCodes.Ret);
            var method = type.DefineMethod(
                "Take", MethodAttributes.Public, CallingConventions.Standard,
                typeof(int), null, null, parameterTypes, requiredModifiers, optionalModifiers);
            var methodIl = method.GetILGenerator();
            methodIl.Emit(OpCodes.Ldarg_0);
            methodIl.Emit(OpCodes.Ldfld, field);
            methodIl.Emit(OpCodes.Ldarg_1);
            methodIl.Emit(OpCodes.Add);
            methodIl.Emit(OpCodes.Ret);
            type.CreateType();
            builder.Save(path);

            using var references = metadataReferences
                ? ReferenceResolver.WithReferences(new[] { path })
                : ReferenceResolver.WithRuntimeReferences(new[] { path });
            Assert.True(references.TryResolveType("ModifierContract.API", out var api));
            foreach (var member in new MethodBase[] { Assert.Single(api.GetConstructors()), api.GetMethod("Take") })
            {
                var parameter = Assert.Single(member.GetParameters());
                Assert.Single(required ? parameter.GetRequiredCustomModifiers() : parameter.GetOptionalCustomModifiers());
            }

            var consumer = new Compilation(references, SyntaxTree.Parse("""
                package ModifierConsumer
                import ModifierContract
                class Runner {
                    shared { func Run() int32 -> API(4).Take(6) }
                }
                """)) { IsLibrary = true };
            using var output = new MemoryStream();
            var result = consumer.Emit(output);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
            var image = output.ToArray();
            using var pe = new PEReader(new MemoryStream(image));
            var metadata = pe.GetMetadataReader();
            var checkedMembers = 0;
            foreach (var handle in metadata.MemberReferences)
            {
                var member = metadata.GetMemberReference(handle);
                var memberName = metadata.GetString(member.Name);
                if (member.Parent.Kind != HandleKind.TypeReference || (memberName != ".ctor" && memberName != "Take"))
                {
                    continue;
                }

                var owner = metadata.GetTypeReference((TypeReferenceHandle)member.Parent);
                if (metadata.GetString(owner.Namespace) != "ModifierContract")
                {
                    continue;
                }

                var signature = metadata.GetBlobReader(member.Signature);
                signature.ReadSignatureHeader();
                Assert.Equal(1, signature.ReadCompressedInteger());
                signature.ReadSignatureTypeCode();
                Assert.Equal(
                    required ? SignatureTypeCode.RequiredModifier : SignatureTypeCode.OptionalModifier,
                    signature.ReadSignatureTypeCode());
                checkedMembers++;
            }

            Assert.Equal(2, checkedMembers);
            var assembly = EmittedFixture.Load(image, directory);
            Assert.Equal(10, assembly.GetType("ModifierConsumer.Runner").GetMethod("Run").Invoke(null, null));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ImportedInParameter_ResolvesItsRequiredModifier(bool metadataReferences)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "in-parameter-contracts", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var name = "InContract";
            var path = Path.Combine(directory, name + ".dll");
            using (var stream = File.Create(path))
            {
                var contract = new Compilation(SyntaxTree.Parse("""
                    package InContract
                    class API {
                        shared { func Take(in value int32) int32 -> value }
                    }
                    """)) { IsLibrary = true, AssemblyName = name };
                var emitted = contract.Emit(stream);
                Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
            }

            using var references = metadataReferences
                ? ReferenceResolver.WithReferences(new[] { path })
                : ReferenceResolver.WithRuntimeReferences(new[] { path });
            Assert.True(references.TryResolveType("InContract.API", out var api));
            var parameter = Assert.Single(api.GetMethod("Take").GetParameters());
            Assert.NotEmpty(parameter.GetRequiredCustomModifiers());
            var consumer = new Compilation(references, SyntaxTree.Parse("""
                package InConsumer
                import InContract
                class Runner {
                    shared {
                        func Run() int32 {
                            var value = 6
                            return API.Take(in value)
                        }
                    }
                }
                """)) { IsLibrary = true };
            using var output = new MemoryStream();
            var result = consumer.Emit(output);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
            var assembly = EmittedFixture.Load(output.ToArray(), directory);
            Assert.Equal(6, assembly.GetType("InConsumer.Runner").GetMethod("Run").Invoke(null, null));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
