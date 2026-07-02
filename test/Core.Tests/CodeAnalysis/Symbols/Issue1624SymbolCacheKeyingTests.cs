// <copyright file="Issue1624SymbolCacheKeyingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.InteropServices;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// Issue #1624 regression coverage: <see cref="TupleTypeSymbol"/> and
/// <see cref="FunctionPointerTypeSymbol"/> used to key their process-wide
/// caches by display name alone (or, for tuples, validated identity on
/// lookup but then raced a plain-write replace on mismatch). Two distinct
/// <see cref="TypeParameterSymbol"/> instances that share a name (as happens
/// across separate compilations reusing a letter like <c>T</c>) must never
/// alias to the same cached tuple / function-pointer instance.
/// </summary>
public class Issue1624SymbolCacheKeyingTests
{
    [Fact]
    public void TupleTypeSymbol_Get_WithDistinctSameNamedElementTypes_NeverAliases()
    {
        var t1 = new TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None);
        var t2 = new TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None);

        var tupleA = TupleTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(t1, TypeSymbol.String));
        var tupleB = TupleTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(t2, TypeSymbol.String));
        var tupleAAgain = TupleTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(t1, TypeSymbol.String));

        Assert.NotSame(tupleA, tupleB);
        Assert.Same(tupleA, tupleAAgain);
    }

    [Fact]
    public void FunctionPointerTypeSymbol_GetUnmanaged_WithDistinctSameNamedParameterTypes_NeverAliases()
    {
        var t1 = new TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None);
        var t2 = new TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None);

        var fpA = FunctionPointerTypeSymbol.Get(CallingConvention.Cdecl, ImmutableArray.Create<TypeSymbol>(t1), TypeSymbol.Void);
        var fpB = FunctionPointerTypeSymbol.Get(CallingConvention.Cdecl, ImmutableArray.Create<TypeSymbol>(t2), TypeSymbol.Void);
        var fpAAgain = FunctionPointerTypeSymbol.Get(CallingConvention.Cdecl, ImmutableArray.Create<TypeSymbol>(t1), TypeSymbol.Void);

        Assert.NotSame(fpA, fpB);
        Assert.Same(fpA, fpAAgain);
    }

    [Fact]
    public void FunctionPointerTypeSymbol_GetManaged_WithDistinctSameNamedParameterTypes_NeverAliases()
    {
        var t1 = new TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None);
        var t2 = new TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None);

        var fpA = FunctionPointerTypeSymbol.GetManaged(ImmutableArray.Create<TypeSymbol>(t1), TypeSymbol.Void);
        var fpB = FunctionPointerTypeSymbol.GetManaged(ImmutableArray.Create<TypeSymbol>(t2), TypeSymbol.Void);
        var fpAAgain = FunctionPointerTypeSymbol.GetManaged(ImmutableArray.Create<TypeSymbol>(t1), TypeSymbol.Void);

        Assert.NotSame(fpA, fpB);
        Assert.Same(fpA, fpAAgain);
    }

    /// <summary>
    /// Regression for the fix-up in this same PR: the original #1624 patch
    /// keyed a plain imported CLR reference-type element (one with a
    /// non-null <c>ClrType</c>, e.g. a class from a project reference) by
    /// name alone, so two *distinct* same-named CLR types (as happens across
    /// separate compilations, each loading their own copy of a same-named
    /// class) aliased to a single cached <see cref="TupleTypeSymbol"/> —
    /// which broke <c>Tuple2_OneClrRefType_ReturnsAndDestructures</c> and
    /// <c>Tuple_AsParameterType</c> in Compiler.Tests. This builds two
    /// dynamic assemblies that each define an unrelated "Holder" class (same
    /// simple name, different <see cref="System.Type"/> identity) and
    /// asserts they never alias, while confirming the same CLR type used
    /// twice still interns to one shared instance.
    /// </summary>
    [Fact]
    public void TupleTypeSymbol_Get_WithDistinctSameNamedClrRefTypeElements_NeverAliases()
    {
        var holderA = ImportedTypeSymbol.Get(DefineHolderType("HolderAsm.A"));
        var holderB = ImportedTypeSymbol.Get(DefineHolderType("HolderAsm.B"));

        var tupleA = TupleTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(holderA, TypeSymbol.String));
        var tupleB = TupleTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(holderB, TypeSymbol.String));
        var tupleAAgain = TupleTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(holderA, TypeSymbol.String));

        Assert.NotSame(tupleA, tupleB);
        Assert.Same(tupleA, tupleAAgain);
    }

    private static System.Type DefineHolderType(string assemblyName)
    {
        var asm = AssemblyBuilder.DefineDynamicAssembly(new AssemblyName(assemblyName), AssemblyBuilderAccess.Run);
        var module = asm.DefineDynamicModule(assemblyName);
        var type = module.DefineType("Holder", TypeAttributes.Public | TypeAttributes.Class);
        return type.CreateType();
    }
}
