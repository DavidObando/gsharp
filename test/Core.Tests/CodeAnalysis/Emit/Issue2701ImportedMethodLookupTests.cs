// <copyright file="Issue2701ImportedMethodLookupTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Reflection;
using System.Reflection.Emit;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

public sealed class Issue2701ImportedMethodLookupTests
{
    [Fact]
    public void MetadataContextMethod_MatchesRuntimePrimitiveGenericArrayAndByRefTypes()
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { typeof(Issue2701MethodFixture).Assembly.Location });
        Assert.True(resolver.TryResolveType(typeof(Issue2701MethodFixture).FullName!, out var declaringType));

        var runtimeTypes = new[]
        {
            TypeSymbol.Bool,
            ImportedTypeSymbol.Get(typeof(List<bool[]>)),
            ImportedTypeSymbol.Get(typeof(bool[,])),
        };
        var method = new FunctionSymbol(
            nameof(Issue2701MethodFixture.Shapes),
            ImmutableArray.Create(
                new ParameterSymbol("visible", runtimeTypes[0]),
                new ParameterSymbol("groups", runtimeTypes[1]),
                new ParameterSymbol("grid", runtimeTypes[2]),
                new ParameterSymbol("enabled", TypeSymbol.Bool, refKind: RefKind.Ref)),
            TypeSymbol.Void);

        var candidate = ReflectionMetadataEmitter.FindImportedMethod(
            declaringType,
            method,
            BindingFlags.Public | BindingFlags.Instance);

        Assert.NotNull(candidate);
        var metadataBool = candidate!.GetParameters()[0].ParameterType;
        Assert.Equal(typeof(bool).FullName, metadataBool.FullName);
        Assert.False(ReferenceEquals(metadataBool, typeof(bool)));
    }

    [Fact]
    public void StructurallyAmbiguousOverloads_ReturnNoMatch()
    {
        var first = DefineDuplicateType("Issue2701.First");
        var second = DefineDuplicateType("Issue2701.Second");
        var declaringType = DefineOverloads(first, second);
        var method = new FunctionSymbol(
            "Pick",
            ImmutableArray.Create(new ParameterSymbol("value", ImportedTypeSymbol.Get(first))),
            TypeSymbol.Void);

        var candidate = ReflectionMetadataEmitter.FindImportedMethod(
            declaringType,
            method,
            BindingFlags.Public | BindingFlags.Static);

        Assert.Null(candidate);
    }

    private static Type DefineDuplicateType(string assemblyName)
    {
        var assembly = AssemblyBuilder.DefineDynamicAssembly(new AssemblyName(assemblyName), AssemblyBuilderAccess.Run);
        return assembly.DefineDynamicModule(assemblyName).DefineType("Oahu.Cli.Duplicate").CreateType()!;
    }

    private static Type DefineOverloads(Type first, Type second)
    {
        var assembly = AssemblyBuilder.DefineDynamicAssembly(new AssemblyName("Issue2701.Overloads"), AssemblyBuilderAccess.Run);
        var type = assembly.DefineDynamicModule("Issue2701.Overloads").DefineType("Oahu.Cli.Overloads");
        DefineOverload(type, first);
        DefineOverload(type, second);
        return type.CreateType()!;
    }

    private static void DefineOverload(TypeBuilder type, Type parameterType)
    {
        var method = type.DefineMethod(
            "Pick",
            MethodAttributes.Public | MethodAttributes.Static,
            typeof(void),
            new[] { parameterType });
        method.GetILGenerator().Emit(OpCodes.Ret);
    }
}

public sealed class Issue2701MethodFixture
{
    public void Shapes(bool visible, List<bool[]> groups, bool[,] grid, ref bool enabled)
    {
    }
}
