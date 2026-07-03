// <copyright file="Issue1790WrapperAliasingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// Issue #1790 regression coverage: <see cref="TypeSymbol.ContainsSameCompilationUserType"/>
/// previously had arms for Nullable/Slice/Array/Map/Function/Tuple/imported-generic
/// wrappers but was MISSING <see cref="SequenceTypeSymbol"/>,
/// <see cref="AsyncSequenceTypeSymbol"/>, <see cref="ChannelTypeSymbol"/>,
/// <see cref="ByRefTypeSymbol"/> and <see cref="PointerTypeSymbol"/>. Because
/// these wrappers compute their <c>ClrType</c> via
/// <c>MakeGenericType</c>/<c>MakeByRefType</c>/<c>MakePointerType</c> (which
/// return <see langword="null"/> when the element/pointee is a
/// same-compilation user type), the missing arms caused such a wrapper to be
/// keyed by display name instead of by symbol identity
/// (<see cref="FunctionTypeSymbol.AppendIdentityKey"/>) — aliasing two
/// same-named user types from distinct compilations. These tests pin the
/// predicate directly for every wrapper kind, and reproduce the end-to-end
/// cross-compilation alias via <see cref="TupleTypeSymbol"/> (the same
/// process-wide cache #1624/#1777 fixed for the other wrappers).
/// </summary>
public class Issue1790WrapperAliasingTests
{
    private static StructSymbol MakeUserStruct(string name) => new(
        name,
        ImmutableArray<FieldSymbol>.Empty,
        Accessibility.Public,
        declaration: null!,
        packageName: "test");

    // ---- ContainsSameCompilationUserType: true when wrapping a same-compilation user type ----

    [Fact]
    public void ContainsSameCompilationUserType_Sequence_OverUserType_ReturnsTrue()
    {
        var wrapper = SequenceTypeSymbol.Get(MakeUserStruct("UserFoo"));
        Assert.True(TypeSymbol.ContainsSameCompilationUserType(wrapper));
    }

    [Fact]
    public void ContainsSameCompilationUserType_AsyncSequence_OverUserType_ReturnsTrue()
    {
        var wrapper = AsyncSequenceTypeSymbol.Get(MakeUserStruct("UserFoo"));
        Assert.True(TypeSymbol.ContainsSameCompilationUserType(wrapper));
    }

    [Fact]
    public void ContainsSameCompilationUserType_Channel_OverUserType_ReturnsTrue()
    {
        var wrapper = ChannelTypeSymbol.Get(MakeUserStruct("UserFoo"));
        Assert.True(TypeSymbol.ContainsSameCompilationUserType(wrapper));
    }

    [Fact]
    public void ContainsSameCompilationUserType_ByRef_OverUserType_ReturnsTrue()
    {
        var wrapper = ByRefTypeSymbol.Get(MakeUserStruct("UserFoo"));
        Assert.True(TypeSymbol.ContainsSameCompilationUserType(wrapper));
    }

    [Fact]
    public void ContainsSameCompilationUserType_Pointer_OverUserType_ReturnsTrue()
    {
        var wrapper = PointerTypeSymbol.Get(MakeUserStruct("UserFoo"));
        Assert.True(TypeSymbol.ContainsSameCompilationUserType(wrapper));
    }

    [Fact]
    public void ContainsSameCompilationUserType_NestedSequenceOfChannelOfUserType_ReturnsTrue()
    {
        var wrapper = SequenceTypeSymbol.Get(ChannelTypeSymbol.Get(MakeUserStruct("UserFoo")));
        Assert.True(TypeSymbol.ContainsSameCompilationUserType(wrapper));
    }

    // ---- ContainsSameCompilationUserType: false when wrapping a plain CLR type (no false positive) ----

    [Fact]
    public void ContainsSameCompilationUserType_Sequence_OverInt32_ReturnsFalse()
    {
        var wrapper = SequenceTypeSymbol.Get(TypeSymbol.Int32);
        Assert.False(TypeSymbol.ContainsSameCompilationUserType(wrapper));
    }

    [Fact]
    public void ContainsSameCompilationUserType_AsyncSequence_OverInt32_ReturnsFalse()
    {
        var wrapper = AsyncSequenceTypeSymbol.Get(TypeSymbol.Int32);
        Assert.False(TypeSymbol.ContainsSameCompilationUserType(wrapper));
    }

    [Fact]
    public void ContainsSameCompilationUserType_Channel_OverInt32_ReturnsFalse()
    {
        var wrapper = ChannelTypeSymbol.Get(TypeSymbol.Int32);
        Assert.False(TypeSymbol.ContainsSameCompilationUserType(wrapper));
    }

    [Fact]
    public void ContainsSameCompilationUserType_ByRef_OverInt32_ReturnsFalse()
    {
        var wrapper = ByRefTypeSymbol.Get(TypeSymbol.Int32);
        Assert.False(TypeSymbol.ContainsSameCompilationUserType(wrapper));
    }

    [Fact]
    public void ContainsSameCompilationUserType_Pointer_OverInt32_ReturnsFalse()
    {
        var wrapper = PointerTypeSymbol.Get(TypeSymbol.Int32);
        Assert.False(TypeSymbol.ContainsSameCompilationUserType(wrapper));
    }

    [Fact]
    public void ContainsSameCompilationUserType_NestedSequenceOfChannelOfInt32_ReturnsFalse()
    {
        var wrapper = SequenceTypeSymbol.Get(ChannelTypeSymbol.Get(TypeSymbol.Int32));
        Assert.False(TypeSymbol.ContainsSameCompilationUserType(wrapper));
    }

    // ---- Other previously-missing wrapper kinds (Pinned, NullabilityAnnotated, FunctionPointer) ----

    [Fact]
    public void ContainsSameCompilationUserType_Pinned_OverUserType_ReturnsTrue()
    {
        var wrapper = new PinnedTypeSymbol(MakeUserStruct("UserFoo"));
        Assert.True(TypeSymbol.ContainsSameCompilationUserType(wrapper));
    }

    [Fact]
    public void ContainsSameCompilationUserType_NullabilityAnnotated_OverUserType_ReturnsTrue()
    {
        var wrapper = new NullabilityAnnotatedTypeSymbol(MakeUserStruct("UserFoo"), ImmutableArray.Create<byte>(1));
        Assert.True(TypeSymbol.ContainsSameCompilationUserType(wrapper));
    }

    [Fact]
    public void ContainsSameCompilationUserType_FunctionPointer_OverUserType_ReturnsTrue()
    {
        var wrapper = FunctionPointerTypeSymbol.GetManaged(
            ImmutableArray.Create<TypeSymbol>(MakeUserStruct("UserFoo")),
            TypeSymbol.Void);
        Assert.True(TypeSymbol.ContainsSameCompilationUserType(wrapper));
    }

    // ---- End-to-end cross-compilation alias repro via the process-wide TupleTypeSymbol cache ----

    [Theory]
    [MemberData(nameof(WrapperFactories))]
    public void TupleTypeSymbol_Get_WithDistinctSameNamedUserTypeWrapped_NeverAliases(
        string _, System.Func<TypeSymbol, TypeSymbol> wrap)
    {
        // Two distinct StructSymbol instances sharing the same name simulate
        // the same-named user type declared independently in two concurrent
        // compilations (both have a null ClrType, like real same-compilation
        // user types being compiled).
        var userA = MakeUserStruct("UserFoo");
        var userB = MakeUserStruct("UserFoo");

        var wrapperA = wrap(userA);
        var wrapperB = wrap(userB);
        var wrapperAAgain = wrap(userA);

        var tupleA = TupleTypeSymbol.Get(ImmutableArray.Create(wrapperA, TypeSymbol.String));
        var tupleB = TupleTypeSymbol.Get(ImmutableArray.Create(wrapperB, TypeSymbol.String));
        var tupleAAgain = TupleTypeSymbol.Get(ImmutableArray.Create(wrapperAAgain, TypeSymbol.String));

        Assert.NotSame(tupleA, tupleB);

        // Positive interning check within the same compilation: reusing the
        // same underlying user-type instance still resolves to the same
        // cached tuple.
        Assert.Same(tupleA, tupleAAgain);
    }

    public static System.Collections.Generic.IEnumerable<object[]> WrapperFactories()
    {
        yield return new object[] { "Sequence", (System.Func<TypeSymbol, TypeSymbol>)(e => SequenceTypeSymbol.Get(e)) };
        yield return new object[] { "AsyncSequence", (System.Func<TypeSymbol, TypeSymbol>)(e => AsyncSequenceTypeSymbol.Get(e)) };
        yield return new object[] { "Channel", (System.Func<TypeSymbol, TypeSymbol>)(e => ChannelTypeSymbol.Get(e)) };
        yield return new object[] { "ByRef", (System.Func<TypeSymbol, TypeSymbol>)(e => ByRefTypeSymbol.Get(e)) };
        yield return new object[] { "Pointer", (System.Func<TypeSymbol, TypeSymbol>)(e => PointerTypeSymbol.Get(e)) };
    }

    /// <summary>
    /// Secondary issue: <see cref="SequenceTypeSymbol"/> and
    /// <see cref="AsyncSequenceTypeSymbol"/> share the display-name format
    /// <c>sequence[{element.Name}]</c> (by design — ADR-0041's surface
    /// syntax for both is <c>sequence[T]</c>). With the primary fix, a
    /// same-compilation user element routes both through the per-instance
    /// <c>!ut&lt;id&gt;</c> identity key rather than the shared name, so
    /// <c>Sequence[UserFoo]</c> and <c>AsyncSequence[UserFoo]</c> (same
    /// element instance) must still key distinctly.
    /// </summary>
    [Fact]
    public void TupleTypeSymbol_Get_WithSequenceVsAsyncSequenceOfSameUserType_NeverAliases()
    {
        var user = MakeUserStruct("UserFoo");
        var seq = SequenceTypeSymbol.Get(user);
        var aseq = AsyncSequenceTypeSymbol.Get(user);

        var tupleSeq = TupleTypeSymbol.Get(ImmutableArray.Create(seq, TypeSymbol.String));
        var tupleAseq = TupleTypeSymbol.Get(ImmutableArray.Create(aseq, TypeSymbol.String));

        Assert.NotSame(tupleSeq, tupleAseq);
    }
}
