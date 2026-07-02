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

    /// <summary>
    /// #1777 follow-up regression: <see cref="SliceTypeSymbol"/> and
    /// <see cref="ArrayTypeSymbol"/> both build their <c>ClrType</c> as
    /// <c>elementType.ClrType.MakeArrayType()</c> (the fixed length is
    /// symbol-only metadata, absent from the CLR shape), so
    /// <c>[]int32</c>, <c>[3]int32</c>, and <c>[5]int32</c> all share the
    /// identical <c>typeof(int[])</c> instance. Neither carries a type
    /// parameter or same-compilation user type, so the ClrType-identity
    /// fallback introduced by #1777 would alias all three as tuple
    /// elements -- the same failure mode as #1624.
    /// </summary>
    [Fact]
    public void TupleTypeSymbol_Get_WithSliceVsFixedArrayElements_NeverAliases()
    {
        var slice = SliceTypeSymbol.Get(TypeSymbol.Int32);
        var array3 = ArrayTypeSymbol.Get(TypeSymbol.Int32, 3);
        var array5 = ArrayTypeSymbol.Get(TypeSymbol.Int32, 5);
        var array3Again = ArrayTypeSymbol.Get(TypeSymbol.Int32, 3);

        var tupleSlice = TupleTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(slice, TypeSymbol.String));
        var tupleArray3 = TupleTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(array3, TypeSymbol.String));
        var tupleArray5 = TupleTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(array5, TypeSymbol.String));
        var tupleArray3Again = TupleTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(array3Again, TypeSymbol.String));

        Assert.NotSame(tupleSlice, tupleArray3);
        Assert.NotSame(tupleArray3, tupleArray5);
        Assert.NotSame(tupleSlice, tupleArray5);

        // Positive interning check: the same shape used twice still resolves
        // to the same cached symbol -- the fix must not over-fragment.
        Assert.Same(tupleArray3, tupleArray3Again);
    }

    /// <summary>
    /// #1777 follow-up regression: <see cref="PinnedTypeSymbol"/> copies its
    /// underlying type's <c>ClrType</c> verbatim, so a pinned wrapper and its
    /// bare underlying type would alias as tuple elements under the
    /// ClrType-identity fallback.
    /// </summary>
    [Fact]
    public void TupleTypeSymbol_Get_WithPinnedVsUnpinnedUnderlying_NeverAliases()
    {
        var pinned = new PinnedTypeSymbol(TypeSymbol.String);

        var tuplePinned = TupleTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(pinned, TypeSymbol.Int32));
        var tupleBare = TupleTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(TypeSymbol.String, TypeSymbol.Int32));

        Assert.NotSame(tuplePinned, tupleBare);
    }

    /// <summary>
    /// #1777 follow-up regression: <see cref="NullabilityAnnotatedTypeSymbol"/>
    /// inherits both <c>Name</c> and <c>ClrType</c> from its <c>BaseType</c>
    /// unchanged, so an annotated element (e.g. carrying a nullable inner
    /// generic argument byte) would alias its bare base type as a tuple
    /// element -- and two annotated wrappers of the same base with different
    /// nullability flags (key vs. value nullable) would alias each other too.
    /// </summary>
    [Fact]
    public void TupleTypeSymbol_Get_WithNullabilityAnnotatedVsBareElements_NeverAliases()
    {
        var annotatedA = new NullabilityAnnotatedTypeSymbol(TypeSymbol.String, ImmutableArray.Create<byte>(1, 2));
        var annotatedB = new NullabilityAnnotatedTypeSymbol(TypeSymbol.String, ImmutableArray.Create<byte>(1, 1));
        var annotatedAAgain = new NullabilityAnnotatedTypeSymbol(TypeSymbol.String, ImmutableArray.Create<byte>(1, 2));

        var tupleAnnotatedA = TupleTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(annotatedA, TypeSymbol.Int32));
        var tupleAnnotatedB = TupleTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(annotatedB, TypeSymbol.Int32));
        var tupleBare = TupleTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(TypeSymbol.String, TypeSymbol.Int32));
        var tupleAnnotatedAAgain = TupleTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(annotatedAAgain, TypeSymbol.Int32));

        Assert.NotSame(tupleAnnotatedA, tupleBare);
        Assert.NotSame(tupleAnnotatedA, tupleAnnotatedB);

        // Positive interning check: same shape (same base + same flags) still
        // resolves to the same cached symbol.
        Assert.Same(tupleAnnotatedA, tupleAnnotatedAAgain);
    }
}
