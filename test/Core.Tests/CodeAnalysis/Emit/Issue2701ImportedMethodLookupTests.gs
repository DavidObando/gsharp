// <copyright file="Issue2701ImportedMethodLookupTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Reflection
import System.Reflection.Emit
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import Xunit

class Issue2701ImportedMethodLookupTests {
    @Fact
    func MetadataContextMethod_MatchesRuntimePrimitiveGenericArrayAndByRefTypes() {
        using let resolver = ReferenceResolver.WithReferences(
            []string{typeof(Issue2701MethodFixture).Assembly.Location}
        )
        Assert.True(resolver.TryResolveType(typeof(Issue2701MethodFixture).FullName!!, out var declaringType))
        let runtimeTypes = []TypeSymbol{
            TypeSymbol.Bool,
            ImportedTypeSymbol.Get(typeof(List[[]bool])),
            ImportedTypeSymbol.Get(typeof([,]bool))
        }
        let method = FunctionSymbol(
            "Shapes",
            ImmutableArray.Create(
                ParameterSymbol("visible", runtimeTypes[0]),
                ParameterSymbol("groups", runtimeTypes[1]),
                ParameterSymbol("grid", runtimeTypes[2]),
                ParameterSymbol("enabled", TypeSymbol.Bool, refKind: RefKind.Ref)
            ),
            TypeSymbol.Void
        )
        let candidate MethodInfo? = ReflectionMetadataEmitter.FindImportedMethod(
            declaringType,
            method,
            BindingFlags.Public | BindingFlags.Instance
        )
        Assert.NotNull(candidate)
        let metadataBool = candidate!!.GetParameters()[0].ParameterType
        Assert.Equal(typeof(bool).FullName, metadataBool.FullName)
        Assert.False(object.ReferenceEquals(metadataBool, typeof(bool)))
    }

    @Fact
    func StructurallyAmbiguousOverloads_ReturnNoMatch() {
        let first = DefineDuplicateType("Issue2701.First")
        let second = DefineDuplicateType("Issue2701.Second")
        let declaringType = DefineOverloads(first, second)
        let method = FunctionSymbol(
            "Pick",
            ImmutableArray.Create(ParameterSymbol("value", ImportedTypeSymbol.Get(first))),
            TypeSymbol.Void
        )
        let candidate MethodInfo? = ReflectionMetadataEmitter.FindImportedMethod(
            declaringType,
            method,
            BindingFlags.Public | BindingFlags.Static
        )
        Assert.Null(candidate)
    }

    shared {
        private func DefineDuplicateType(assemblyName string) Type {
            let assembly = AssemblyBuilder.DefineDynamicAssembly(AssemblyName(assemblyName), AssemblyBuilderAccess.Run)
            return assembly.DefineDynamicModule(assemblyName).DefineType("Oahu.Cli.Duplicate").CreateType()
        }

        private func DefineOverloads(first Type, second Type) Type {
            let assembly = AssemblyBuilder.DefineDynamicAssembly(
                AssemblyName("Issue2701.Overloads"),
                AssemblyBuilderAccess.Run
            )
            let type = assembly.DefineDynamicModule("Issue2701.Overloads").DefineType("Oahu.Cli.Overloads")
            DefineOverload(type, first)
            DefineOverload(type, second)
            return type.CreateType()
        }

        private func DefineOverload(type TypeBuilder, parameterType Type) {
            let method = type.DefineMethod(
                "Pick",
                MethodAttributes.Public | MethodAttributes.Static,
                typeof(Void),
                []Type{parameterType}
            )
            method.GetILGenerator().Emit(OpCodes.Ret)
        }
    }
}

class Issue2701MethodFixture {
    func Shapes(visible bool, groups List[[]bool], grid[,]bool, ref enabled bool) { }
}
