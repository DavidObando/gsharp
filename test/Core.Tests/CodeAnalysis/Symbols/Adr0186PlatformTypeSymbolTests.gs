// <copyright file="Adr0186PlatformTypeSymbolTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Symbols.Display
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// ADR-0186 step 1: (cref:PlatformTypeSymbol), its display forms, and
/// `ClrNullability`'s three-state classifier.
///
/// <b>Why the classifier is asserted directly rather than through a
/// compilation.</b> ADR-0154 asks each test to name the wrong answer it would
/// catch. With `--nullability=platform-types` <b>off</b> — the default,
/// and the mode every other test in the suite runs under — the bytes `0`
/// and `2` deliberately produce the <em>same</em> symbol
/// ((cref:NullableTypeSymbol)), because "no behaviour change when off"
/// is this step's load-bearing claim. A classifier that answered
/// (cref:ClrNullabilityState.Annotated) for an oblivious byte would
/// therefore be completely invisible downstream while the flag is off. So the
/// witness has to live at the classifier's own return value, and the
/// symbol-level assertions have to run with the mode on.
///
/// <b>Step 2 has landed.</b> Conversions (§3), the coercion check (§4),
/// member lookup (§5) and operator acceptance (§6) are now taught about
/// `T!`, and they are covered end-to-end by
/// `Adr0186PlatformTypeConversionTests` (the §3 table and the
/// generic-container rule, at the classifier) and
/// `Adr0186PlatformTypeBindingTests` (§4's check, §5's two-clause
/// mutation witness and §6's operator matrix, against real oblivious
/// metadata). <em>This</em> fixture keeps its original scope deliberately —
/// the symbol, its display forms and the three-state classifier — because
/// those are the facts the rest of the design is derived from and they
/// deserve a witness that does not depend on any of it.
///
/// Still to come: step 3 flips the mode on by default, at which point the
/// mode-off assertions here become assertions about a mode nobody selects
/// and should be revisited rather than merely kept green.
open class Adr0186PlatformTypeSymbolTests {
    /// ADR-0186 §2's table, read directly. Each row names a `flags` shape
    /// and a position; the expected state is the ADR's own third column.
    ///
    /// The oblivious rows are the discrimination witnesses: an implementation
    /// that folded oblivious into (cref:ClrNullabilityState.Annotated) (the
    /// pre-ADR-0186 reading, where `0` and `2` were the same answer)
    /// turns every one of them red, while leaving the `1` and `2`
    /// rows — and every existing test in the suite — green.
    /// @param flags The nullable-flags byte array under test.
    /// @param index The DFS position index.
    /// @param expected The `ClrNullabilityState` ADR-0186 §2's table assigns to it, as its ordinal — the
    /// enum is internal to the compiler, and an internal type cannot appear in a public test signature.
    @Theory
    @InlineData([0]uint8, int32(0), int32(0))
    @InlineData([0]uint8, int32(3), int32(0))
    @InlineData([]uint8{0}, int32(0), int32(0))
    @InlineData([]uint8{0}, int32(7), int32(0))
    @InlineData([]uint8{1}, int32(0), int32(1))
    @InlineData([]uint8{1}, int32(7), int32(1))
    @InlineData([]uint8{2}, int32(0), int32(2))
    @InlineData([]uint8{2}, int32(7), int32(2))
    @InlineData([]uint8{0, 1, 2}, int32(0), int32(0))
    @InlineData([]uint8{0, 1, 2}, int32(1), int32(1))
    @InlineData([]uint8{0, 1, 2}, int32(2), int32(2))
    @InlineData([]uint8{1, 2, 0}, int32(0), int32(1))
    @InlineData([]uint8{1, 2, 0}, int32(1), int32(2))
    @InlineData([]uint8{1, 2, 0}, int32(2), int32(0))
    @InlineData([]uint8{2, 0, 1}, int32(0), int32(2))
    @InlineData([]uint8{2, 0, 1}, int32(1), int32(0))
    @InlineData([]uint8{2, 0, 1}, int32(2), int32(1))
    @InlineData([]uint8{1, 1}, int32(2), int32(0))
    @InlineData([]uint8{2, 2}, int32(9), int32(0))
    func ClassifyPosition_Matches_The_Adr0186_Table(flags[]uint8, index int32, expected int32) {
        Assert.Equal(
            ClrNullabilityState(expected),
            ClrNullability.ClassifyPosition(ImmutableArray.Create(flags), index)
        )
    }

    /// A default (`IsDefault`, not merely empty) flags array is the shape
    /// several readers actually hand over, and it must not throw.
    @Fact
    func ClassifyPosition_Treats_A_Default_Array_As_Oblivious() {
        Assert.Equal(ClrNullabilityState.Oblivious, ClrNullability.ClassifyPosition(default(ImmutableArray[uint8]), 0))
    }

    /// The per-byte classifier, which `NullableFlagsBuilder` uses because
    /// it reads bytes out of an already-expanded array and so has no position
    /// to classify.
    /// @param flag The metadata byte.
    /// @param expected What it says, as a `ClrNullabilityState` ordinal.
    @Theory
    @InlineData(uint8(0), int32(0))
    @InlineData(uint8(1), int32(1))
    @InlineData(uint8(2), int32(2))
    @InlineData(uint8(7), int32(0))
    func ClassifyFlag_Maps_Each_Byte(flag uint8, expected int32) -> Assert.Equal(
        ClrNullabilityState(expected),
        ClrNullability.ClassifyFlag(flag)
    )

    /// ADR-0136's `IsFlagNonNull` / `IsPositionNonNull` are now
    /// projections of the classifier, and their answers are <b>unchanged</b> —
    /// which is what makes this step a no-op with the mode off. This pins the
    /// projection: exactly (cref:ClrNullabilityState.NotAnnotated) is
    /// non-null, and the other two states are not.
    /// @param flag The metadata byte.
    /// @param expectedNonNull Whether ADR-0136 calls it non-null.
    @Theory
    @InlineData(uint8(0), false)
    @InlineData(uint8(1), true)
    @InlineData(uint8(2), false)
    func IsFlagNonNull_Is_Unchanged_By_The_Three_State_Read(flag uint8, expectedNonNull bool) {
        Assert.Equal(expectedNonNull, ClrNullability.IsFlagNonNull(flag))
        Assert.Equal(expectedNonNull, ClrNullability.IsPositionNonNull(ImmutableArray.Create(flag), 0))
    }

    /// The `enabled` half of ADR-0186's central claim: under ADR-0136's
    /// reading an oblivious position produces `T?` via
    /// (cref:NullableTypeSymbol), indistinguishable from an explicitly
    /// annotated one.
    ///
    /// <b>Step 3 made the scope explicit.</b> This used to rely on the
    /// ambient default being (cref:NullabilityMode.Enabled), which is
    /// no longer true — and relying on an ambient default to assert what a
    /// non-default mode does was always the weaker form of the test. Entering
    /// the mode says what is being asserted.
    /// @param state The declaration's state, as a `ClrNullabilityState` ordinal.
    @Theory
    @InlineData(int32(0))
    @InlineData(int32(2))
    func SymbolForState_Yields_Nullable_For_Both_NonNonNull_States_Under_TheEnabledMode(state int32) {
        using let scope_ = NullabilityOptions.Enter(NullabilityMode.Enabled)
        let symbol = ClrNullability.SymbolForState(TypeSymbol.String, ClrNullabilityState(state))
        Assert.IsType[NullableTypeSymbol](symbol)
        Assert.Same(NullableTypeSymbol.Get(TypeSymbol.String), symbol)
    }

    /// The mode-on half: oblivious becomes `T!` and <em>only</em>
    /// oblivious does. The `Annotated` and `NotAnnotated` rows are
    /// the negative controls — ADR-0186 changes exactly one cell of ADR-0136's
    /// table, so an implementation that widened the pivot to the annotated
    /// states (un-annotating the BCL, which the ADR explicitly forbids) fails
    /// here.
    @Fact
    func SymbolForState_Yields_PlatformType_For_Oblivious_Only_When_The_Mode_Is_On() {
        using let scope_ = NullabilityOptions.Enter(NullabilityMode.PlatformTypes)
        let platform = ClrNullability.SymbolForState(TypeSymbol.String, ClrNullabilityState.Oblivious)
        Assert.IsType[PlatformTypeSymbol](platform)
        Assert.Same(TypeSymbol.String, (cast[PlatformTypeSymbol](platform)).UnderlyingType)
        Assert.IsType[NullableTypeSymbol](
            ClrNullability.SymbolForState(TypeSymbol.String, ClrNullabilityState.Annotated)
        )
        Assert.Same(
            TypeSymbol.String,
            ClrNullability.SymbolForState(TypeSymbol.String, ClrNullabilityState.NotAnnotated)
        )
    }

    /// The mode is scoped, not global: leaving the scope restores the previous
    /// reading. Without this, one test changing the mode would silently
    /// change what every later test in the same process imports.
    ///
    /// Written against the `enabled` mode since step 3, because that is
    /// now the non-default one — a restore test whose inner and outer modes
    /// are both the default asserts nothing. It also covers the shape step 3
    /// had to fix in `NullabilityOptions`: an unset ambient value must
    /// resolve to `DefaultMode`, not to the enum's zero value, or a
    /// restored "nothing" would silently mean `enabled` forever after.
    @Fact
    func The_Mode_Is_Restored_When_Its_Scope_Ends() {
        Assert.True(NullabilityOptions.PlatformTypesEnabled)
        {
            using let _ = NullabilityOptions.Enter(NullabilityMode.Enabled)
            Assert.False(NullabilityOptions.PlatformTypesEnabled)
            Assert.IsType[NullableTypeSymbol](
                ClrNullability.SymbolForState(TypeSymbol.String, ClrNullabilityState.Oblivious)
            )
        }
        Assert.True(NullabilityOptions.PlatformTypesEnabled)
        Assert.IsType[PlatformTypeSymbol](
            ClrNullability.SymbolForState(TypeSymbol.String, ClrNullabilityState.Oblivious)
        )
    }

    /// ADR-0186 §1: `T!` is reference-unique per underlying type.
    /// `SymbolEqualityComparer.Default` is `ReferenceEquals`, so two
    /// independently-constructed wrappers over one underlying type would be two
    /// different types to every symbol set and identity comparison in the
    /// binder. `Get` is also idempotent over its own wrapper, exactly as
    /// (cref:NullableTypeSymbol.Get) is.
    @Fact
    func Get_Is_Cached_And_Idempotent() {
        let first = PlatformTypeSymbol.Get(TypeSymbol.String)
        let second = PlatformTypeSymbol.Get(TypeSymbol.String)
        Assert.Same(first, second)
        Assert.Same(first, PlatformTypeSymbol.Get(first))
        Assert.True(SymbolEqualityComparer.Default.Equals(first, second))
        // A different underlying type is a different platform type.
        Assert.NotSame(first, PlatformTypeSymbol.Get(TypeSymbol.Object))
    }

    /// ADR-0186 §1: the wrapper is a binder-level annotation only — its
    /// (cref:TypeSymbol.ClrType) is the underlying type's, which is what
    /// makes it erase to `T` at emit.
    @Fact
    func ClrType_Is_The_Underlying_Types() {
        Assert.Same(TypeSymbol.String.ClrType, PlatformTypeSymbol.Get(TypeSymbol.String).ClrType)
    }

    /// ADR-0186 §1 / ADR-0132: the `!` is positional, and the two
    /// positions mean different types.
    ///
    /// `[]!T` is a platform slice; `[]T!` is a slice of platform
    /// elements. An implementation that simply appended `!` to the
    /// underlying type's name would render <b>both</b> as `[]T!` and make
    /// them indistinguishable in every diagnostic — which is exactly the defect
    /// ADR-0132 fixed for `?`, and which does not fall out for `!`
    /// for free.
    @Fact
    func Display_Binds_The_Marker_Positionally_For_Arrays_And_Slices() {
        let platformSlice = PlatformTypeSymbol.Get(SliceTypeSymbol.Get(TypeSymbol.Int32))
        let sliceOfPlatform = SliceTypeSymbol.Get(PlatformTypeSymbol.Get(TypeSymbol.String))
        Assert.Equal("[]!int32", platformSlice.Name)
        Assert.Equal("[]!int32", SymbolDisplay.ToTypeDisplayString(platformSlice))
        Assert.Equal("[]string!", SymbolDisplay.ToTypeDisplayString(sliceOfPlatform))
        Assert.NotEqual(
            SymbolDisplay.ToTypeDisplayString(platformSlice),
            SymbolDisplay.ToTypeDisplayString(sliceOfPlatform)
        )
        let platformArray = PlatformTypeSymbol.Get(ArrayTypeSymbol.Get(TypeSymbol.Int32, 3))
        Assert.Equal("[3]!int32", platformArray.Name)
        Assert.Equal("[3]!int32", SymbolDisplay.ToTypeDisplayString(platformArray))
        let platformRectangular = PlatformTypeSymbol.Get(RectangularArrayTypeSymbol.Get(TypeSymbol.Int32, 2))
        Assert.Equal("[,]!int32", platformRectangular.Name)
        Assert.Equal("[,]!int32", SymbolDisplay.ToTypeDisplayString(platformRectangular))
    }

    /// Issue #2160's rule, applied to `!`: the marker must bind to the
    /// whole arrow shape, never to the return type alone.
    @Fact
    func Display_Parenthesises_A_Platform_Function_Type() {
        let function = FunctionTypeSymbol.Get(ImmutableArray.Create(TypeSymbol.Int32), TypeSymbol.Void)
        let platform = PlatformTypeSymbol.Get(function)
        Assert.Equal("(${function.Name})!", platform.Name)
        Assert.StartsWith("(", SymbolDisplay.ToTypeDisplayString(platform))
        Assert.EndsWith(")!", SymbolDisplay.ToTypeDisplayString(platform))
    }

    /// The plain case, and the one hover shows most: `string!`.
    @Fact
    func Display_Trails_The_Marker_For_An_Ordinary_Type() {
        let platform = PlatformTypeSymbol.Get(TypeSymbol.String)
        Assert.Equal("string!", platform.Name)
        Assert.Equal("string!", SymbolDisplay.ToTypeDisplayString(platform))
    }

    /// ADR-0186 §1: `T!` must be a wrapper to the canonical structural
    /// walk, not a leaf. Issue #1790 centralised that walk precisely because a
    /// wrapper kind missing from it falls through as "no inner type" and
    /// silently aliases across compilations.
    @Fact
    func The_Wrapper_Participates_In_The_Canonical_Structural_Walk() {
        let parameter = TypeParameter()
        let platform = PlatformTypeSymbol.Get(SliceTypeSymbol.Get(parameter))
        Assert.True(TypeSymbol.ContainsTypeParameter(platform))
        let sink = List[TypeParameterSymbol]()
        TypeSymbol.CollectReferencedTypeParameters(platform, sink)
        Assert.Same(parameter, Assert.Single(sink))
    }

    /// The <b>writer</b> half of the same walk, and the half that fails worse.
    ///
    /// The readers above and `TrySubstituteCompositeType` are two sides of
    /// one contract: what (cref:TypeSymbol.GetWrappedTypes) can see
    /// inside, substitution must be able to rebuild. A wrapper present in the
    /// readers and absent from the writer is not a missed answer but a
    /// <em>wrong</em> one — the readers report that a `T!` over a type
    /// parameter contains one, the writer answers "not a composite shape", and
    /// the caller keeps the unsubstituted type. That is issue #1790's own bug
    /// class, which is why ADR-0186 touches these walkers at all.
    @Fact
    func The_Wrapper_Is_Rebuilt_By_The_Canonical_Substitution() {
        let parameter = TypeParameter()
        // `[]T!` — the platform wrapper outermost.
        let platformSlice = PlatformTypeSymbol.Get(SliceTypeSymbol.Get(parameter))
        Assert.True(
            TypeSymbol.TrySubstituteCompositeType(
                platformSlice,
                (inner TypeSymbol) -> SubstituteRecursively(inner, parameter, TypeSymbol.Int32),
                out var substituted
            )
        )
        let rebuilt = Assert.IsType[PlatformTypeSymbol](substituted)
        let rebuiltSlice = Assert.IsType[SliceTypeSymbol](rebuilt.UnderlyingType)
        Assert.Same(TypeSymbol.Int32, rebuiltSlice.ElementType)
        // `[]T!` with the wrapper nested one level down, so it is reached
        // through the recursion rather than at the root.
        let sliceOfPlatform = SliceTypeSymbol.Get(PlatformTypeSymbol.Get(parameter))
        Assert.True(
            TypeSymbol.TrySubstituteCompositeType(
                sliceOfPlatform,
                (inner TypeSymbol) -> SubstituteRecursively(inner, parameter, TypeSymbol.String),
                out var nested
            )
        )
        let nestedSlice = Assert.IsType[SliceTypeSymbol](nested)
        Assert.Same(
            PlatformTypeSymbol.Get(TypeSymbol.String),
            Assert.IsType[PlatformTypeSymbol](nestedSlice.ElementType)
        )
        // ADR-0193 §2: substituting a VALUE type rebuilds through
        // `PlatformTypeSymbol.Get`, which normalises `int32!` to `int32` —
        // there is no reference nullability to leave unstated.
        Assert.True(
            TypeSymbol.TrySubstituteCompositeType(
                sliceOfPlatform,
                (inner TypeSymbol) -> SubstituteRecursively(inner, parameter, TypeSymbol.Int32),
                out var nestedValue
            )
        )
        Assert.Same(TypeSymbol.Int32, Assert.IsType[SliceTypeSymbol](nestedValue).ElementType)
        // An identity substitution must return the very same symbol, not an
        // equal copy — the cache is what makes `T!` one type.
        Assert.True(TypeSymbol.TrySubstituteCompositeType(platformSlice, (t TypeSymbol) -> t, out var unchanged))
        Assert.Same(platformSlice, unchanged)
    }

    /// ADR-0186 §1: `T!` carries reference-nullability information with no
    /// distinct runtime `Type`, so it must both (a) count as such an
    /// annotation for gates that decide whether reflection can re-derive a
    /// type, and (b) be stripped by the comparison that comes to a runtime
    /// signature <em>ignoring</em> reference nullability. Those two are the
    /// same fact read in opposite directions, and getting either wrong makes
    /// `string!` and `string` differ where they must not.
    @Fact
    func The_Wrapper_Is_Reference_Nullability_Only() {
        let platform = PlatformTypeSymbol.Get(TypeSymbol.String)
        Assert.True(TypeSymbol.ContainsReferenceNullableAnnotation(platform))
        Assert.True(TypeSymbol.ContainsReferenceNullableAnnotation(SliceTypeSymbol.Get(platform)))
        Assert.True(TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(platform, TypeSymbol.String))
        Assert.True(
            TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(
                platform,
                NullableTypeSymbol.Get(TypeSymbol.String)
            )
        )
        // …but it is still not the same runtime signature as an unrelated type.
        Assert.False(TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(platform, TypeSymbol.Object))
    }

    /// ADR-0186 §8's third round-trip value: a platform position is emitted as
    /// the <b>oblivious</b> byte `0`, never as `1`.
    ///
    /// This replaces step 1's
    /// `Emit_Refuses_A_Platform_Type_Rather_Than_Encoding_It_As_NonNull`,
    /// which pinned a `NotSupportedException`. That refusal was
    /// right while `PlatformTypeSymbol` could not reach the emitter and
    /// the only alternative was `Append`'s fall-through to
    /// `AppendClrType`. It stopped being right at step 3: an inferred
    /// local whose initializer is an oblivious CLR call has type `T!`,
    /// and the moment it is captured into a closure display class, an async
    /// state machine or a script result slot, its type is written to metadata
    /// as a synthesized member's signature — ordinary default-on source, not
    /// §9 territory.
    ///
    /// <b>The constraint that did not move is the important half</b>: byte
    /// `1` would launder an unknown into a guarantee in metadata, where
    /// the next reader has no way to tell. §8 offers two legal shapes for an
    /// oblivious declaration and says both "read back as `T!`"; this is
    /// the per-position byte of the second.
    @Fact
    func Emit_Encodes_A_Platform_Type_As_The_Oblivious_Byte() {
        let platform = PlatformTypeSymbol.Get(TypeSymbol.String)
        Assert.Equal([]uint8{0}, NullableFlagsBuilder.Build(platform).ToArray())
        // …and nested, where a fall-through would be quietest of all. Both
        // positions are asserted because ADR-0132 binds the marker
        // POSITIONALLY: `[]string!` (a non-null slice of platform elements)
        // and `[]!string` (a platform slice of non-null elements) are
        // different types and must not encode to the same bytes.
        Assert.Equal([]uint8{1, 0}, NullableFlagsBuilder.Build(SliceTypeSymbol.Get(platform)).ToArray())
        Assert.Equal(
            []uint8{0, 1},
            NullableFlagsBuilder.Build(PlatformTypeSymbol.Get(SliceTypeSymbol.Get(TypeSymbol.String))).ToArray()
        )
        // The negative control: the shapes this builder already handled are
        // untouched, so this is a new arm and not a changed rule.
        Assert.Equal([]uint8{2}, NullableFlagsBuilder.Build(NullableTypeSymbol.Get(TypeSymbol.String)).ToArray())
        Assert.Equal([]uint8{1}, NullableFlagsBuilder.Build(TypeSymbol.String).ToArray())
    }

    /// ADR-0186 §8's round-trip guarantee, made <b>total</b>: non-null stays
    /// non-null, nullable stays nullable, <b>oblivious stays oblivious</b>.
    ///
    /// The emit half alone proves nothing — a byte is only correct if the
    /// reader gives it back. This asserts the composition
    /// `NullableFlagsBuilder.Build` → `ClrNullability.ClassifyPosition`
    /// → `SymbolForState` for all three states, in both modes, off the
    /// same emitted bytes. Under ADR-0136 the third case was not expressible
    /// at all; an oblivious G# declaration had to be emitted as something it
    /// was not.
    ///
    /// The mode-off arm is the one that shows the encoding is not a
    /// platform-types-only convention: byte `0` is what ADR-0136 already
    /// read as "not non-null", so an assembly emitted by a platform-types
    /// compilation stays readable by an `Enabled` one — it simply reads
    /// `T?` there, which is ADR-0136's answer for the same declaration.
    @Fact
    func Emit_And_Read_RoundTrip_All_Three_States() {
        let cases = [](Emitted TypeSymbol, Expected uint8){
            (TypeSymbol.String, 1),
            (NullableTypeSymbol.Get(TypeSymbol.String), 2),
            (PlatformTypeSymbol.Get(TypeSymbol.String), 0)
        }
        for (emitted, expectedByte) in cases {
            let flags = NullableFlagsBuilder.Build(emitted)
            Assert.Equal([]uint8{expectedByte}, flags.ToArray())
        }
        {
            using let _ = NullabilityOptions.Enter(NullabilityMode.PlatformTypes)
            Assert.Equal(
                ClrNullabilityState.NotAnnotated,
                ClrNullability.ClassifyPosition(ImmutableArray.Create(uint8(1)), 0)
            )
            Assert.Equal(
                ClrNullabilityState.Annotated,
                ClrNullability.ClassifyPosition(ImmutableArray.Create(uint8(2)), 0)
            )
            Assert.Equal(
                ClrNullabilityState.Oblivious,
                ClrNullability.ClassifyPosition(ImmutableArray.Create(uint8(0)), 0)
            )
            Assert.IsType[PlatformTypeSymbol](
                ClrNullability.SymbolForState(TypeSymbol.String, ClrNullabilityState.Oblivious)
            )
        }
        // Under `enabled`: the very same emitted byte still reads as "not
        // non-null", which is ADR-0136's answer. The encoding is
        // forward-compatible in both directions rather than a private
        // convention, which is what makes an assembly emitted by a
        // platform-types compilation still readable by an `enabled` one.
        {
            using let _ = NullabilityOptions.Enter(NullabilityMode.Enabled)
            Assert.IsType[NullableTypeSymbol](
                ClrNullability.SymbolForState(TypeSymbol.String, ClrNullabilityState.Oblivious)
            )
        }
    }

    shared {
        /// The recursive substitution callback shape every real caller of
        /// `TrySubstituteCompositeType` passes: replace the leaf, else let the
        /// canonical walk rebuild the composite around a recursive call.
        /// @param type The type to substitute in.
        /// @param from The type parameter to replace.
        /// @param to Its replacement.
        /// @returns The substituted type.
        private func SubstituteRecursively(type TypeSymbol, from TypeParameterSymbol, to TypeSymbol) TypeSymbol {
            if object.ReferenceEquals(type, from) {
                return to
            }
            return if TypeSymbol.TrySubstituteCompositeType(
                type,
                (inner TypeSymbol) -> SubstituteRecursively(inner, from, to),
                out var result
            ) {
                result
            } else {
                type
            }
        }

        private func TypeParameter() TypeParameterSymbol -> TypeParameterSymbol(
            "T",
            ordinal: 0,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None
        )
    }
}
