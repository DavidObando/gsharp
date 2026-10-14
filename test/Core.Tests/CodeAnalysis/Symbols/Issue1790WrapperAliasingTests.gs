// <copyright file="Issue1790WrapperAliasingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Immutable
import Xunit

/// Issue #1790 regression coverage: (cref:TypeSymbol.ContainsSameCompilationUserType)
/// previously had arms for Nullable/Slice/Array/Map/Function/Tuple/imported-generic
/// wrappers but was MISSING (cref:SequenceTypeSymbol),
/// (cref:AsyncSequenceTypeSymbol), (cref:ChannelTypeSymbol),
/// (cref:ByRefTypeSymbol) and (cref:PointerTypeSymbol). Because
/// these wrappers compute their `ClrType` via
/// `MakeGenericType`/`MakeByRefType`/`MakePointerType` (which
/// return `null` when the element/pointee is a
/// same-compilation user type), the missing arms caused such a wrapper to be
/// keyed by display name instead of by symbol identity
/// ((cref:FunctionTypeSymbol.AppendIdentityKey)) — aliasing two
/// same-named user types from distinct compilations. These tests pin the
/// predicate directly for every wrapper kind, and reproduce the end-to-end
/// cross-compilation alias via (cref:TupleTypeSymbol) (the same
/// process-wide cache #1624/#1777 fixed for the other wrappers).
open class Issue1790WrapperAliasingTests {
    // ---- ContainsSameCompilationUserType: true when wrapping a same-compilation user type ----
    @Fact
    func ContainsSameCompilationUserType_Sequence_OverUserType_ReturnsTrue() {
        let wrapper = SequenceTypeSymbol.Get(MakeUserStruct("UserFoo"))
        Assert.True(TypeSymbol.ContainsSameCompilationUserType(wrapper))
    }

    @Fact
    func ContainsSameCompilationUserType_AsyncSequence_OverUserType_ReturnsTrue() {
        let wrapper = AsyncSequenceTypeSymbol.Get(MakeUserStruct("UserFoo"))
        Assert.True(TypeSymbol.ContainsSameCompilationUserType(wrapper))
    }

    @Fact
    func ContainsSameCompilationUserType_Channel_OverUserType_ReturnsTrue() {
        let wrapper = ChannelTypeSymbol.Get(MakeUserStruct("UserFoo"))
        Assert.True(TypeSymbol.ContainsSameCompilationUserType(wrapper))
    }

    @Fact
    func ContainsSameCompilationUserType_ByRef_OverUserType_ReturnsTrue() {
        let wrapper = ByRefTypeSymbol.Get(MakeUserStruct("UserFoo"))
        Assert.True(TypeSymbol.ContainsSameCompilationUserType(wrapper))
    }

    @Fact
    func ContainsSameCompilationUserType_Pointer_OverUserType_ReturnsTrue() {
        let wrapper = PointerTypeSymbol.Get(MakeUserStruct("UserFoo"))
        Assert.True(TypeSymbol.ContainsSameCompilationUserType(wrapper))
    }

    @Fact
    func ContainsSameCompilationUserType_NestedSequenceOfChannelOfUserType_ReturnsTrue() {
        let wrapper = SequenceTypeSymbol.Get(ChannelTypeSymbol.Get(MakeUserStruct("UserFoo")))
        Assert.True(TypeSymbol.ContainsSameCompilationUserType(wrapper))
    }

    // ---- ContainsSameCompilationUserType: false when wrapping a plain CLR type (no false positive) ----
    @Fact
    func ContainsSameCompilationUserType_Sequence_OverInt32_ReturnsFalse() {
        let wrapper = SequenceTypeSymbol.Get(TypeSymbol.Int32)
        Assert.False(TypeSymbol.ContainsSameCompilationUserType(wrapper))
    }

    @Fact
    func ContainsSameCompilationUserType_AsyncSequence_OverInt32_ReturnsFalse() {
        let wrapper = AsyncSequenceTypeSymbol.Get(TypeSymbol.Int32)
        Assert.False(TypeSymbol.ContainsSameCompilationUserType(wrapper))
    }

    @Fact
    func ContainsSameCompilationUserType_Channel_OverInt32_ReturnsFalse() {
        let wrapper = ChannelTypeSymbol.Get(TypeSymbol.Int32)
        Assert.False(TypeSymbol.ContainsSameCompilationUserType(wrapper))
    }

    @Fact
    func ContainsSameCompilationUserType_ByRef_OverInt32_ReturnsFalse() {
        let wrapper = ByRefTypeSymbol.Get(TypeSymbol.Int32)
        Assert.False(TypeSymbol.ContainsSameCompilationUserType(wrapper))
    }

    @Fact
    func ContainsSameCompilationUserType_Pointer_OverInt32_ReturnsFalse() {
        let wrapper = PointerTypeSymbol.Get(TypeSymbol.Int32)
        Assert.False(TypeSymbol.ContainsSameCompilationUserType(wrapper))
    }

    @Fact
    func ContainsSameCompilationUserType_NestedSequenceOfChannelOfInt32_ReturnsFalse() {
        let wrapper = SequenceTypeSymbol.Get(ChannelTypeSymbol.Get(TypeSymbol.Int32))
        Assert.False(TypeSymbol.ContainsSameCompilationUserType(wrapper))
    }

    // ---- Other previously-missing wrapper kinds (Pinned, NullabilityAnnotated, FunctionPointer) ----
    @Fact
    func ContainsSameCompilationUserType_Pinned_OverUserType_ReturnsTrue() {
        let wrapper = PinnedTypeSymbol(MakeUserStruct("UserFoo"))
        Assert.True(TypeSymbol.ContainsSameCompilationUserType(wrapper))
    }

    @Fact
    func ContainsSameCompilationUserType_NullabilityAnnotated_OverUserType_ReturnsTrue() {
        let wrapper = NullabilityAnnotatedTypeSymbol(MakeUserStruct("UserFoo"), ImmutableArray.Create[uint8](uint8(1)))
        Assert.True(TypeSymbol.ContainsSameCompilationUserType(wrapper))
    }

    @Fact
    func ContainsSameCompilationUserType_FunctionPointer_OverUserType_ReturnsTrue() {
        let wrapper = FunctionPointerTypeSymbol.GetManaged(
            ImmutableArray.Create[TypeSymbol](MakeUserStruct("UserFoo")),
            TypeSymbol.Void
        )
        Assert.True(TypeSymbol.ContainsSameCompilationUserType(wrapper))
    }

    // ---- End-to-end cross-compilation alias repro via the process-wide TupleTypeSymbol cache ----
    @Theory
    @MemberData("WrapperFactories")
    func TupleTypeSymbol_Get_WithDistinctSameNamedUserTypeWrapped_NeverAliases(
        _ string,
        wrap(TypeSymbol?) -> TypeSymbol
    ) {
        // Two distinct StructSymbol instances sharing the same name simulate
        // the same-named user type declared independently in two concurrent
        // compilations (both have a null ClrType, like real same-compilation
        // user types being compiled).
        let userA = MakeUserStruct("UserFoo")
        let userB = MakeUserStruct("UserFoo")
        let wrapperA = wrap(userA)
        let wrapperB = wrap(userB)
        let wrapperAAgain = wrap(userA)
        let tupleA = TupleTypeSymbol.Get(ImmutableArray.Create(wrapperA, TypeSymbol.String))
        let tupleB = TupleTypeSymbol.Get(ImmutableArray.Create(wrapperB, TypeSymbol.String))
        let tupleAAgain = TupleTypeSymbol.Get(ImmutableArray.Create(wrapperAAgain, TypeSymbol.String))
        Assert.NotSame(tupleA, tupleB)
        // Positive interning check within the same compilation: reusing the
        // same underlying user-type instance still resolves to the same
        // cached tuple.
        Assert.Same(tupleA, tupleAAgain)
    }

    /// Secondary issue: (cref:SequenceTypeSymbol) and
    /// (cref:AsyncSequenceTypeSymbol) share the display-name format
    /// `sequence[{element.Name}]` (by design — ADR-0041's surface
    /// syntax for both is `sequence[T]`). With the primary fix, a
    /// same-compilation user element routes both through the per-instance
    /// `!ut<id>` identity key rather than the shared name, so
    /// `Sequence[UserFoo]` and `AsyncSequence[UserFoo]` (same
    /// element instance) must still key distinctly.
    @Fact
    func TupleTypeSymbol_Get_WithSequenceVsAsyncSequenceOfSameUserType_NeverAliases() {
        let user = MakeUserStruct("UserFoo")
        let seq = SequenceTypeSymbol.Get(user)
        let aseq = AsyncSequenceTypeSymbol.Get(user)
        let tupleSeq = TupleTypeSymbol.Get(ImmutableArray.Create(seq, TypeSymbol.String))
        let tupleAseq = TupleTypeSymbol.Get(ImmutableArray.Create(aseq, TypeSymbol.String))
        Assert.NotSame(tupleSeq, tupleAseq)
    }

    shared {
        private func MakeUserStruct(name string) StructSymbol -> StructSymbol(
            name,
            ImmutableArray[FieldSymbol].Empty,
            Accessibility.Public,
            declaration: nil,
            packageName: "test"
        )

        func WrapperFactories() sequence[[]object] {
            yield[]object{"Sequence", Func[TypeSymbol, TypeSymbol](((e TypeSymbol) -> SequenceTypeSymbol.Get(e)))}
            yield[]object{
                "AsyncSequence",
                Func[TypeSymbol, TypeSymbol](((e TypeSymbol) -> AsyncSequenceTypeSymbol.Get(e)))
            }
            yield[]object{"Channel", Func[TypeSymbol, TypeSymbol](((e TypeSymbol) -> ChannelTypeSymbol.Get(e)))}
            yield[]object{"ByRef", Func[TypeSymbol, TypeSymbol](((e TypeSymbol) -> ByRefTypeSymbol.Get(e)))}
            yield[]object{"Pointer", Func[TypeSymbol, TypeSymbol](((e TypeSymbol) -> PointerTypeSymbol.Get(e)))}
        }
    }
}
