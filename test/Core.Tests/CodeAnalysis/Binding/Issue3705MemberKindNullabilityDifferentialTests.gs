// <copyright file="Issue3705MemberKindNullabilityDifferentialTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Runtime.Loader
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Core.CodeAnalysis
import System.Reflection

/// Issue #3705, family 2 — the nullability differential gate.
///
/// The companion of (cref:Issue3705MemberKindAccessibilityDifferentialTests)
/// (member kind × accessibility) and of
/// `Issue3705LoadContextDifferentialTests` (compiler query × load context).
/// The family-2 shape is #3703: a signature position read with a bare
/// `TypeSymbol.FromClrType` where the sibling position one line away used
/// the nullability-aware `ClrNullability` reader — so an imported
/// `string?` bound as non-null `string`, the unsound direction.
///
/// So rather than one test per site, this fixture asserts the INVARIANT: for a
/// reference-typed signature position on an imported member, whether the bound
/// type is nullable depends only on the DECLARATION's annotation state, and
/// never on the member kind or receiver shape through which the position was
/// reached. Neither appears on the right-hand side of either expectation; the
/// table IS the invariant.
///
/// There are FOUR annotation states, not three, and the fourth is the one the
/// original family-2 deferral missed. Issue #1354 says a reference position is
/// non-null only for an explicit `1`; oblivious reaches the compiler in two
/// physically different shapes and a fix that only handles the first leaves the
/// kinds disagreeing:
/// - `ObliviousAbsent` — no `[Nullable]` and no `[NullableContext]` anywhere, so the flags array is
/// EMPTY.
/// - `ObliviousZero` — a `#nullable disable` member of a `[NullableContext(1)]` type, which csc
/// annotates with an explicit `[Nullable(0)]`: a NON-empty flags array holding the oblivious byte.
/// `MergeDeclarationNullability`'s empty-flags short-circuit never saw this one at all; it fell through
/// to an `ApplyRootAnnotation` that open-coded C#'s "nullable iff the byte is 2" instead of G#'s
/// "non-null iff the byte is 1".
///
/// Guard rails, and they are half the point: the `NonNull` rows are the
/// negative controls. They fail if a fix widens an annotated non-null position
/// to nullable — the #3704-shaped regression the family-2 triage warned about,
/// where a widened declaration reaches a position that consumes it as non-null.
/// (cref:Fixture_Really_Presents_Four_Distinct_AnnotationStates) is the
/// anti-vacuity assertion: it reads the emitted metadata directly and proves
/// the four states carry genuinely different `[Nullable]` bytes, so the
/// table cannot go green because every row secretly tested the same thing. In
/// particular it pins `ObliviousZero` to the byte `[0]`, because if
/// csc ever chose a different `[NullableContext]` for that type the state
/// would silently collapse into `ObliviousAbsent` and stop testing the
/// second mechanism.
///
/// Every row also EXECUTES its emitted assembly. A nullability edit changes the
/// types the emitter sees, and binding cleanly with zero diagnostics is not
/// evidence that the emitted IL runs; the marker each program prints is derived
/// from the annotation state alone, exactly like the bind expectation.
class Issue3705MemberKindNullabilityDifferentialTests {
    /// The family-2 invariant, over all four annotation states.
    ///
    /// Existing rows pass on the current `origin/main` and remain as guard
    /// rails. The inherited-class and explicit-`base` rows added for the
    /// remaining #3705 base-member group fail there for every nullable state:
    /// those paths used bare `TypeSymbol.FromClrType` instead of the same
    /// nullability-aware readers as direct imported member access.
    ///
    /// The `NonNull` rows are the negative controls: routing these paths
    /// through `ClrNullability` must not widen an explicitly non-null
    /// declaration.
    ///
    /// <b>ADR-0186 step 3 changed the oblivious rows and nothing else.</b>
    /// Both `Oblivious*` states now bind to a non-null local, because
    /// the position reads as `T!` and `T! → T` is an implicit
    /// conversion carrying §4's runtime check rather than a compile error.
    /// The ADR names this fixture's expected column as the precise,
    /// mechanical statement of its whole metadata-reading change; the
    /// `NonNull` and `Nullable` rows are unchanged and are what
    /// keeps that an amendment to one cell rather than a weakening of the
    /// gate. The <em>runtime marker</em> column did not move at all: an
    /// oblivious position still holds a non-null value, and a
    /// `Nullable` one still holds nil.
    ///
    /// The uniformity claim is unchanged and is the point: every one of the
    /// thirteen signature positions must give the <em>same</em> answer for a
    /// given annotation state. The kind never appears on the right-hand side.
    /// @param kind The signature-position kind.
    /// @param state The declaration's annotation state.
    /// @param expectedNonNull Whether the position must bind into a non-null local.
    @Theory
    @MemberData("Matrix")
    func SignaturePositions_Agree_On_DeclarationNullability(kind string, state string, expectedNonNull bool) {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitCSharpLibrary(directory, LibraryAssemblyName, CSharpLibrarySource)
            // The probe binds the position to a NON-NULL `string` local, which
            // succeeds only when the position itself bound as non-null.
            let strict = CompileGSharp(BuildSource(kind, state, nullableTarget: false), libraryPath)
            // …and to a `string?` local, which must succeed either way. This
            // arm is what distinguishes "bound nullable" from "did not bind at
            // all" — without it a lookup regression would read as a passing row.
            let lenient = CompileGSharp(BuildSource(kind, state, nullableTarget: true), libraryPath)
            Assert.True(lenient.Success, "$kind/$state: the position must bind at all: ${Describe(lenient)}")
            if expectedNonNull {
                Assert.True(
                    strict.Success,
                    "$kind/$state should bind NON-NULL, but assigning it to a " +
                        "non-null local failed: ${Describe(strict)}"
                )
            } else {
                Assert.False(
                    strict.Success,
                    "$kind/$state should bind NULLABLE, but it assigned to a " + "non-null local without a diagnostic."
                )
            }
            // Binding cleanly is not the same as emitting something that runs.
            // The marker is a function of the annotation state alone: every
            // position that is not `Nullable` holds a non-null value.
            let expectedMarker = if state == "Nullable" {
                "nil"
            } else {
                "value"
            }
            Assert.Equal(expectedMarker, RunGSharp(lenient, libraryPath, "$kind-$state").Trim())
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    /// The write-side sibling of the inherited/base property reads in
    /// (cref:SignaturePositions_Agree_On_DeclarationNullability).
    /// @param state The declaration's annotation state.
    /// @param acceptsNil Whether assigning `nil` must compile.
    @Theory
    @InlineData("NonNull", false)
    @InlineData("Nullable", true)
    @InlineData("ObliviousAbsent", true)
    @InlineData("ObliviousZero", true)
    func BasePropertyWrite_Uses_DeclarationNullability(state string, acceptsNil bool) {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitCSharpLibrary(directory, LibraryAssemblyName, CSharpLibrarySource)
            let baseType = if state.StartsWith("Oblivious", StringComparison.Ordinal) {
                state + "Surface"
            } else {
                "Surface"
            }
            let compiled = CompileGSharp((`package ` + "$ConsumerAssemblyName" + `
import Issue3705.NullabilityLibrary

class Derived : ` + "$baseType" + ` {
    func Clear() {
        base.` + "$state" + `Property = nil
    }
}

func Main() {
    Derived().Clear()
}`), libraryPath)
            Assert.True(
                compiled.Success == acceptsNil,
                "$state: expected acceptsNil=$acceptsNil: ${Describe(compiled)}"
            )
            if !acceptsNil {
                Assert.Contains(
                    compiled.Diagnostics,
                    (
                        diagnostic Issue3705MemberKindNullabilityDifferentialTests.DiagnosticInfo
                    ) -> diagnostic.Id == "GS0155"
                )
            }
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    /// A user interface that extends an imported interface must read the
    /// inherited property's declaration nullability, just like a user class
    /// that extends an imported base class.
    /// @param nullable Whether the imported property is nullable.
    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedBaseInterfaceProperty_Uses_DeclarationNullability(nullable bool) {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitCSharpLibrary(directory, LibraryAssemblyName, CSharpLibrarySource)
            let suffix = if nullable {
                "Nullable"
            } else {
                "NonNull"
            }
            let propertyType = if nullable {
                "string?"
            } else {
                "string"
            }
            let value = if nullable {
                "nil"
            } else {
                "\"V\""
            }
            let BuildSource = func (target string) string {
                let report = if target == "string?" {
                    `    if probe == nil {
        Console.WriteLine("nil")
    } else {
        Console.WriteLine("value")
    }`
                } else {
                    "    Console.WriteLine(probe)"
                }
                return (`package ` + "$ConsumerAssemblyName" + `
import Issue3705.NullabilityLibrary

interface Local : I` + "$suffix" + `Inherited {}

class Impl : Local {
    prop Value ` + "$propertyType" + ` {
        get { return ` + "$value" + ` }
    }
}

func Read(receiver Local) ` + "$target" + ` {
    return receiver.Value
}

func Main() {
    let probe ` + "$target" + ` = Read(Impl())
` + "$report" + `
}`)
            }
            let strict = CompileGSharp(BuildSource("string"), libraryPath)
            let lenient = CompileGSharp(BuildSource("string?"), libraryPath)
            Assert.Equal(!nullable, strict.Success)
            Assert.True(lenient.Success, Describe(lenient))
            Assert.Equal(
                if nullable {
                    "nil"
                } else {
                    "value"
                },
                RunGSharp(lenient, libraryPath, suffix).Trim()
            )
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    /// The soundness case, executed. An oblivious imported field that really is
    /// `null` at run time.
    ///
    /// The local is INFERRED rather than annotated, so on `origin/main`
    /// it infers non-null `string` and the `nil` guard is rejected —
    /// which is the whole defect: main hands a null to a position it has typed
    /// as non-null and offers no way to check. With the #1354 rule applied
    /// through receiver substitution the guard binds, the program runs, and the
    /// guard fires.
    @Fact
    func ObliviousField_That_Is_Null_At_Runtime_Is_Guardable_And_Runs() {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitCSharpLibrary(directory, LibraryAssemblyName, CSharpLibrarySource)
            let source = (`package ` + "$ConsumerAssemblyName" + `
import Issue3705.NullabilityLibrary

func Main() {
    let surface = ObliviousNullAtRuntimeSurface()
    let probe = surface.ObliviousField
    if probe == nil {
        Console.WriteLine("guarded")
    } else {
        Console.WriteLine("leaked")
    }
}`)
            let compiled = CompileGSharp(source, libraryPath)
            Assert.True(
                compiled.Success,
                "an oblivious imported field must bind nullable, so a nil guard " +
                    "over it binds: ${Describe(compiled)}"
            )
            Assert.Equal("guarded", RunGSharp(compiled, libraryPath, "NullAtRuntime").Trim())
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    /// The one carve-out from the uniformity above, pinned so it stays a
    /// decision rather than decaying into "we gave up".
    ///
    /// #1354 is a rule about CONCRETE reference positions in imported metadata.
    /// An OPEN type-parameter position is not one: its nullability arrives with
    /// the type ARGUMENT at substitution. Applying the declaration's missing
    /// byte there would overwrite the caller's answer with a guess, and for an
    /// unconstrained `T` substituted with a value type it would silently
    /// mean `Nullable<T>`.
    ///
    /// So `Box<string>.Value` read off an oblivious holder must be
    /// `string` — the argument's own nullability — and NOT `string?`,
    /// even though the holder carries no nullability metadata at all and every
    /// concrete position on it does widen. `Box<int>.Value` is the
    /// value-type control: it must stay a plain `int32`.
    ///
    /// The in-tree guard rail for the same rule is
    /// `Issue3311OpenMapMemberLookupEmitTests.GenericFunc_Keys_FullyOpen_ReturnsFirstKey_As_K`
    /// (`map[K, V].Keys` must iterate as `K`); this row is the
    /// imported-metadata twin of it, and both fail if the carve-out is dropped.
    @Fact
    func OpenTypeParameterPositions_Take_Nullability_From_The_Argument() {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitCSharpLibrary(directory, LibraryAssemblyName, CSharpLibrarySource)
            // A reference type argument: `ObliviousBox[string].Value` is
            // `string`, not `string?`, despite the declaration being fully
            // oblivious. The receiver is constructed in G# so that its OWN
            // nullability is not in question — the only thing under test is the
            // open `T` slot.
            let reference = CompileGSharp((`package ` + "$ConsumerAssemblyName" + `
import Issue3705.NullabilityLibrary

func Main() {
    let boxed = ObliviousBox[string]("V")
    let probe string = boxed.Value
    Console.WriteLine(probe)
}`), libraryPath)
            Assert.True(
                reference.Success,
                "an open type-parameter position must take the ARGUMENT's " +
                    "nullability, not the declaration's: ${Describe(reference)}"
            )
            Assert.Equal("V", RunGSharp(reference, libraryPath, "OpenTypeParamRef").Trim())
            // A value type argument: the case where widening would not merely
            // be noisy but would change the type to `Nullable<int>`.
            let value = CompileGSharp((`package ` + "$ConsumerAssemblyName" + `
import Issue3705.NullabilityLibrary

func Main() {
    let boxed = ObliviousBox[int32](7)
    let probe int32 = boxed.Value
    Console.WriteLine(probe)
}`), libraryPath)
            Assert.True(value.Success, "a value-type argument must not become nullable: ${Describe(value)}")
            Assert.Equal("7", RunGSharp(value, libraryPath, "OpenTypeParamValue").Trim())
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    /// Anti-vacuity. #3716's load-context table nearly shipped a fixture that
    /// would have passed even if its "MLC twin" had silently been the host
    /// type; the analogous trap here is a fixture whose annotation states all
    /// carry the same metadata, which would make every row above assert the
    /// same thing. Read the emitted `[Nullable]` bytes back through the
    /// same reader the binder uses and prove the four states really differ.
    @Fact
    func Fixture_Really_Presents_Four_Distinct_AnnotationStates() {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitCSharpLibrary(directory, LibraryAssemblyName, CSharpLibrarySource)
            using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
            Assert.True(resolver.TryResolveType("Issue3705.NullabilityLibrary.Surface", out var surface))
            Assert.True(resolver.TryResolveType("Issue3705.NullabilityLibrary.ObliviousAbsentSurface", out var absent))
            Assert.True(resolver.TryResolveType("Issue3705.NullabilityLibrary.ObliviousZeroSurface", out var zero))
            let nonNullField = surface.GetField("NonNullField")!!
            let nullableField = surface.GetField("NullableField")!!
            let absentField = absent.GetField("ObliviousAbsentField")!!
            let zeroField = zero.GetField("ObliviousZeroField")!!
            // Annotated non-null is the only one of the four that is not
            // nullable — if this ever collapses, every non-`NonNull` row above
            // becomes vacuous.
            //
            // ADR-0186 step 3: the "three nullable states" claim is a
            // statement about ADR-0136's reading, so it is asserted under
            // `enabled` explicitly now that that is not the default. Under
            // `platform-types` the two oblivious states read as `T!`
            // instead, which is the flip and is asserted immediately below —
            // the anti-vacuity property this method exists for is that the
            // four states are DISTINCT, and they are distinct in both modes.
            {
                using let _ = NullabilityOptions.Enter(NullabilityMode.Enabled)
                Assert.IsNotType[NullableTypeSymbol](ClrNullability.GetFieldTypeSymbol(nonNullField))
                Assert.IsType[NullableTypeSymbol](ClrNullability.GetFieldTypeSymbol(nullableField))
                Assert.IsType[NullableTypeSymbol](ClrNullability.GetFieldTypeSymbol(absentField))
                Assert.IsType[NullableTypeSymbol](ClrNullability.GetFieldTypeSymbol(zeroField))
            }
            // The default reading: annotated non-null stays `T`, annotated
            // nullable stays `T?`, and both oblivious shapes are `T!`.
            Assert.IsNotType[NullableTypeSymbol](ClrNullability.GetFieldTypeSymbol(nonNullField))
            Assert.IsNotType[PlatformTypeSymbol](ClrNullability.GetFieldTypeSymbol(nonNullField))
            Assert.IsType[NullableTypeSymbol](ClrNullability.GetFieldTypeSymbol(nullableField))
            Assert.IsType[PlatformTypeSymbol](ClrNullability.GetFieldTypeSymbol(absentField))
            Assert.IsType[PlatformTypeSymbol](ClrNullability.GetFieldTypeSymbol(zeroField))
            // …and the three nullable states must not be nullable for the SAME
            // reason. `ObliviousZero` in particular must be a NON-empty `[0]`:
            // if csc ever picked a different `[NullableContext]` for that type
            // it would collapse into `ObliviousAbsent` and silently stop
            // covering the second divergence mechanism.
            Assert.Equal([]uint8{1}, ClrNullability.ReadNullableFlags(nonNullField, surface).ToArray())
            Assert.Equal([]uint8{2}, ClrNullability.ReadNullableFlags(nullableField, surface).ToArray())
            Assert.Empty(ClrNullability.ReadNullableFlags(absentField, absent))
            Assert.Equal([]uint8{0}, ClrNullability.ReadNullableFlags(zeroField, zero).ToArray())
            // The constrained rows read off an INTERFACE, whose `[NullableContext]`
            // majority vote is computed separately from the surface class's. Pin
            // it too, or the constrained ObliviousZero rows could silently
            // degrade into ObliviousAbsent while the table stayed green.
            Assert.True(
                resolver.TryResolveType(
                    "Issue3705.NullabilityLibrary.IObliviousZeroConstrained",
                    out var zeroConstrained
                )
            )
            Assert.Equal(
                []uint8{0},
                ClrNullability.ReadNullableFlags(
                    zeroConstrained.GetProperty("ObliviousZeroProperty")!!,
                    zeroConstrained
                )
                    .ToArray()
            )
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    /// ADR-0186 step 1 — <b>the third column</b>.
    ///
    /// The four annotation states above collapse onto <em>two</em> answers:
    /// `NonNull` binds non-null and the other three bind nullable. That
    /// collapse is exactly what ADR-0186 ends. Under
    /// `--nullability=platform-types` the table gains a third answer, and
    /// it changes in the oblivious row and nowhere else:
    ///
    /// ```xmldoc
    /// <list type="table">
    /// <listheader><term>State</term><description>mode off → mode on</description></listheader>
    /// <item><term>NonNull</term><description><c>string</c> → <c>string</c></description></item>
    /// <item><term>Nullable</term><description><c>string?</c> → <c>string?</c></description></item>
    /// <item><term>ObliviousAbsent</term><description><c>string?</c> → <b><c>string!</c></b></description></item>
    /// <item><term>ObliviousZero</term><description><c>string?</c> → <b><c>string!</c></b></description></item>
    /// </list>
    /// ```
    ///
    /// <b>Why this row asserts symbols rather than compiling a probe.</b> Step 1
    /// builds the symbol and its read path only; conversions, member lookup and
    /// the coercion check are step 2. A G# program that reads a `string!`
    /// member therefore has nothing yet to bind that read <em>against</em>, so
    /// an end-to-end probe here would be testing unbuilt machinery. What is
    /// built — and what the whole pivot rests on — is that the three reading
    /// paths give the same three-state answer for one declaration, so that is
    /// what is asserted, off the same real csc-emitted metadata every other row
    /// in this fixture uses.
    ///
    /// The `NonNull` and `Nullable` assertions are the negative
    /// controls, and they are the point as much as the oblivious ones are:
    /// ADR-0186 changes <b>one</b> cell of ADR-0136's table, and an
    /// implementation that widened the pivot — reading an annotated
    /// `[Nullable(2)]` as a platform type, which would un-annotate the
    /// entire modern BCL — fails here rather than in a corpus run.
    ///
    /// <b>Step 2 has landed, and the probe shape it unblocked lives
    /// elsewhere.</b> `Adr0186PlatformTypeBindingTests` compiles and
    /// <em>runs</em> G# against oblivious metadata in both modes — §4's check
    /// throwing at each coercion site, §5's two-clause mutation witness, §6's
    /// operator matrix. This row deliberately stays at the symbol level: its
    /// job in this fixture is the <em>uniformity</em> claim — that all three
    /// reading paths give one answer for one declaration — which is a
    /// statement about the reader, not about what the binder later does with
    /// the result, and which an end-to-end probe would test only indirectly.
    @Fact
    func ObliviousStates_Read_As_PlatformType_Only_Under_The_Platform_Types_Mode() {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitCSharpLibrary(directory, LibraryAssemblyName, CSharpLibrarySource)
            using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
            Assert.True(resolver.TryResolveType("Issue3705.NullabilityLibrary.Surface", out var surface))
            Assert.True(resolver.TryResolveType("Issue3705.NullabilityLibrary.ObliviousAbsentSurface", out var absent))
            Assert.True(resolver.TryResolveType("Issue3705.NullabilityLibrary.ObliviousZeroSurface", out var zero))
            Assert.True(resolver.TryResolveType("Issue3705.NullabilityLibrary.ObliviousBox`1", out var box))
            let fields = [](State string, Field FieldInfo, Expected ClrNullabilityState){
                ("NonNull", surface.GetField("NonNullField")!!, ClrNullabilityState.NotAnnotated),
                ("Nullable", surface.GetField("NullableField")!!, ClrNullabilityState.Annotated),
                ("ObliviousAbsent", absent.GetField("ObliviousAbsentField")!!, ClrNullabilityState.Oblivious),
                ("ObliviousZero", zero.GetField("ObliviousZeroField")!!, ClrNullabilityState.Oblivious)
            }
            // The classifier, first: this is the assertion that discriminates.
            // With the mode OFF the two non-`NotAnnotated` states produce the
            // same symbol by design, so a classifier that answered `Annotated`
            // for an oblivious byte would be invisible at the symbol level.
            for (state, field, expected) in fields {
                Assert.Equal(
                    expected,
                    ClrNullability.ClassifyPosition(ClrNullability.ReadNullableFlags(field, field.DeclaringType), 0)
                )
            }
            // The `enabled` mode — ADR-0136's answers, asserted on the same
            // four real declarations. ADR-0186 step 3 made the scope
            // explicit: this is no longer the default, and a claim about a
            // specific mode should say which mode it is about.
            {
                using let _ = NullabilityOptions.Enter(NullabilityMode.Enabled)
                Assert.IsNotType[NullableTypeSymbol](ClrNullability.GetFieldTypeSymbol(fields[0].Field))
                for (state, field, _) in fields[1 ..] {
                    Assert.IsType[NullableTypeSymbol](ClrNullability.GetFieldTypeSymbol(field))
                }
            }
            // Mode ON — the third column.
            {
                using let _ = NullabilityOptions.Enter(NullabilityMode.PlatformTypes)
                Assert.IsNotType[NullableTypeSymbol](ClrNullability.GetFieldTypeSymbol(fields[0].Field))
                Assert.IsNotType[PlatformTypeSymbol](ClrNullability.GetFieldTypeSymbol(fields[0].Field))
                // The negative control: an explicit `[Nullable(2)]` stays `T?`.
                Assert.IsType[NullableTypeSymbol](ClrNullability.GetFieldTypeSymbol(fields[1].Field))
                // Both physical shapes of "the declarer said nothing" — an
                // EMPTY flags array and an explicit `[Nullable(0)]` — must give
                // the same answer, which is what #3705 family 2 was about and
                // what ADR-0186 preserves.
                Assert.IsType[PlatformTypeSymbol](ClrNullability.GetFieldTypeSymbol(fields[2].Field))
                Assert.IsType[PlatformTypeSymbol](ClrNullability.GetFieldTypeSymbol(fields[3].Field))
                Assert.Equal("string!", ClrNullability.GetFieldTypeSymbol(fields[2].Field).Name)
                // The LAYOUT path, not just the scalar one. A generic member
                // read through `MergeDeclarationNullability` expands the
                // declaration's flags before classifying them, and if that
                // expansion still fills absent positions with `2` the two paths
                // disagree about one declaration — the #3705 family-2 defect
                // ADR-0136's single-predicate rule exists to prevent, and which
                // ADR-0186 §2 explicitly preserves. A scalar-only assertion
                // passes while that drift is live.
                let openValue = box.GetProperty("Value")!!
                let merged = NullableFlagsBuilder.MergeDeclarationNullability(
                    TypeSymbol.String,
                    openValue.PropertyType,
                    ClrNullability.ReadNullableFlags(openValue, box)
                )
                // ADR-0186 §2 keeps ADR-0136's open-type-parameter exclusion
                // verbatim: the slot's nullability arrives with the ARGUMENT,
                // so an oblivious open `T` is neither `T?` nor `T!`.
                Assert.Same(TypeSymbol.String, merged)
                // …while a CONCRETE oblivious position reached through the same
                // expansion does become a platform type.
                let concrete = zero.GetProperty("ObliviousZeroProperty")!!
                let concreteMerged = NullableFlagsBuilder.MergeDeclarationNullability(
                    TypeSymbol.String,
                    concrete.PropertyType,
                    ClrNullability.ReadNullableFlags(concrete, zero)
                )
                Assert.IsType[PlatformTypeSymbol](concreteMerged)
                let concreteAbsent = absent.GetProperty("ObliviousAbsentProperty")!!
                Assert.IsType[PlatformTypeSymbol](
                    NullableFlagsBuilder.MergeDeclarationNullability(
                        TypeSymbol.String,
                        concreteAbsent.PropertyType,
                        ClrNullability.ReadNullableFlags(concreteAbsent, absent)
                    )
                )
            }
            // …and the mode is scoped, so the rest of the suite is
            // unaffected. Shown the other way round since step 3: leaving
            // the `platform-types` scope must restore the DEFAULT, which is
            // now `platform-types` itself, not the enum's zero value. The
            // `enabled` reading is asserted inside its own scope above.
            Assert.IsType[PlatformTypeSymbol](ClrNullability.GetFieldTypeSymbol(fields[2].Field))
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    /// ADR-0186 step 1: the plumbing, end to end —
    /// `/nullability:platform-types` → `CommandLineArgs` →
    /// (cref:GsCompilation.Nullability) → the ambient scope →
    /// `ClrNullability`.
    ///
    /// Every other flag-on assertion in this fixture calls
    /// `ClrNullability` directly, which is right for what step 1 builds
    /// but leaves the scope-installation sites untested: a
    /// `NullabilityOptions.Enter` placed on the wrong side of the lazy
    /// bind would be completely invisible. This row is the one that fails if
    /// the mode never reaches the importer.
    ///
    /// The observation is the bound type of a global whose type is
    /// <em>inferred</em> from an oblivious imported field — the one place step
    /// 1 alone already makes the two modes produce different symbols, with no
    /// conversion, lookup or coercion rule involved. Anything downstream of the
    /// read is step 2's.
    @Fact
    func Compilation_Threads_Its_Nullability_Mode_Into_Metadata_Import() {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitCSharpLibrary(directory, LibraryAssemblyName, CSharpLibrarySource)
            let source = (`package ` + "$ConsumerAssemblyName" + `
import Issue3705.NullabilityLibrary

let probe = ObliviousNullAtRuntimeSurface().ObliviousField`)
            // Mode off: ADR-0136's reading, unchanged.
            Assert.IsType[NullableTypeSymbol](BindGlobalProbeType(source, NullabilityMode.Enabled, libraryPath))
            // Mode on: the read path produces `T!` — which can only happen if
            // `Compilation.Nullability` actually reached `ClrNullability`.
            let platform = BindGlobalProbeType(source, NullabilityMode.PlatformTypes, libraryPath)
            Assert.IsType[PlatformTypeSymbol](platform)
            Assert.Equal("string!", platform.Name)
            // …and the mode is scoped to the compilation that asked for it,
            // which is now shown the other way round: the `enabled`
            // compilation above must not have left `enabled` installed
            // ambiently, so the default reading is back in force here.
            Assert.True(NullabilityOptions.PlatformTypesEnabled)
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    private data struct CompileResult(
        Success bool,
        Diagnostics[]Issue3705MemberKindNullabilityDifferentialTests.DiagnosticInfo,
        PeBytes[]uint8
    ) : IEquatable[Issue3705MemberKindNullabilityDifferentialTests.CompileResult] { }

    private data struct DiagnosticInfo(Id string, Message string?) : IEquatable[
        Issue3705MemberKindNullabilityDifferentialTests.DiagnosticInfo
    ] { }

    shared {
        private const ConsumerAssemblyName string = "Issue3705.NullabilityConsumer"
        private const LibraryAssemblyName string = "Issue3705.NullabilityLibrary"

        /// One reference-typed signature position of every kind, in each of the
        /// four annotation states.
        ///
        /// Every position that is not `Nullable` holds a non-null value at
        /// runtime and every `Nullable` position holds `null`, so the
        /// executed marker is a function of the annotation state alone.
        ///
        /// `#nullable disable` alone is what makes the `Oblivious*`
        /// members oblivious; whether that shows up as absent metadata or as an
        /// explicit `[Nullable(0)]` is decided by the enclosing type's
        /// `[NullableContext]`, which is why the `ObliviousZero` types
        /// carry enough non-null anchors to push csc's majority vote to `1`.
        private const CSharpLibrarySource string = (`#nullable enable
using System;
using System.Collections.Generic;

namespace Issue3705.NullabilityLibrary;

public class Surface
{
    public string NonNullField = "V";
    public string? NullableField = null;

    public string NonNullProperty { get; set; } = "V";
    public string? NullableProperty { get; set; }

    public string NonNullMethod() => "V";
    public string? NullableMethod() => null;

    public string this[int index] => "V";
    public string? this[long index] => null;

    public void Deconstruct(out string first, out int second)
    {
        first = "V";
        second = 0;
    }
}

public class NullableDeconstructSurface
{
    public void Deconstruct(out string? first, out int second)
    {
        first = null;
        second = 0;
    }
}

public interface IConstrained
{
    string NonNullMethod();

    string? NullableMethod();

    string NonNullProperty { get; }

    string? NullableProperty { get; }

    string this[int index] { get; }

    string? this[long index] { get; }
}

public class Constrained : IConstrained
{
    public string NonNullMethod() => "V";

    public string? NullableMethod() => null;

    public string NonNullProperty => "V";

    public string? NullableProperty => null;

    public string this[int index] => "V";

    public string? this[long index] => null;
}

public interface INonNullInherited
{
    string Value { get; }
}

public interface INullableInherited
{
    string? Value { get; }
}

// ObliviousZero: a ` + "`" + `[NullableContext(1)]` + "`" + ` type whose ` + "`" + `#nullable disable` + "`" + `
// members therefore carry an explicit ` + "`" + `[Nullable(0)]` + "`" + `. The anchors exist
// only to win csc's per-type majority vote.
public class ObliviousZeroSurface
{
    public string Anchor1 = "V";
    public string Anchor2 = "V";
    public string Anchor3 = "V";
    public string Anchor4 = "V";
    public string Anchor5 = "V";
    public string Anchor6 = "V";
    public string Anchor7 = "V";
    public string Anchor8 = "V";
    public string Anchor9 = "V";
    public string Anchor10 = "V";
    public string Anchor11 = "V";
    public string Anchor12 = "V";

#nullable disable
    public string ObliviousZeroField = "V";

    public string ObliviousZeroProperty { get; set; } = "V";

    public string ObliviousZeroMethod() => "V";

    public string this[int index] => "V";

    public void Deconstruct(out string first, out int second)
    {
        first = "V";
        second = 0;
    }
#nullable enable
}

public interface IObliviousZeroConstrained
{
    string Anchor1();

    string Anchor2();

    string Anchor3();

    string Anchor4();

    string Anchor5();

    string Anchor6();

    string Anchor7();

    string Anchor8();

    string Anchor9();

    string Anchor10();

#nullable disable
    string ObliviousZeroMethod();

    string ObliviousZeroProperty { get; }

    string this[int index] { get; }
#nullable enable
}

public class ObliviousZeroConstrained : IObliviousZeroConstrained
{
    public string Anchor1() => "V";

    public string Anchor2() => "V";

    public string Anchor3() => "V";

    public string Anchor4() => "V";

    public string Anchor5() => "V";

    public string Anchor6() => "V";

    public string Anchor7() => "V";

    public string Anchor8() => "V";

    public string Anchor9() => "V";

    public string Anchor10() => "V";

#nullable disable
    public string ObliviousZeroMethod() => "V";

    public string ObliviousZeroProperty => "V";

    public string this[int index] => "V";
#nullable enable
}

#nullable disable

// ObliviousAbsent: no ` + "`" + `[Nullable]` + "`" + ` and no ` + "`" + `[NullableContext]` + "`" + ` reaches
// these members at all, so the flags array the binder reads is empty.
public class ObliviousAbsentSurface
{
    public string ObliviousAbsentField = "V";

    public string ObliviousAbsentProperty { get; set; } = "V";

    public string ObliviousAbsentMethod() => "V";

    public string this[int index] => "V";

    public void Deconstruct(out string first, out int second)
    {
        first = "V";
        second = 0;
    }
}

public interface IObliviousAbsentConstrained
{
    string ObliviousAbsentMethod();

    string ObliviousAbsentProperty { get; }

    string this[int index] { get; }
}

// The open-type-parameter carve-out, declared in an OBLIVIOUS region —
// which is exactly where the #1354 default would otherwise fire and
// rewrite the declaration's ` + "`" + `T` + "`" + ` into ` + "`" + `T?` + "`" + `. ` + "`" + `Value` + "`" + `'s metadata slot is
// an OPEN ` + "`" + `T` + "`" + ` with no nullability byte at all.
public class ObliviousBox<T>
{
    public ObliviousBox(T value)
    {
        Value = value;
    }

    public T Value { get; }
}

public class ObliviousAbsentConstrained : IObliviousAbsentConstrained
{
    public string ObliviousAbsentMethod() => "V";

    public string ObliviousAbsentProperty => "V";

    public string this[int index] => "V";
}

// The soundness demonstration: oblivious AND genuinely null at runtime.
public class ObliviousNullAtRuntimeSurface
{
    public string ObliviousField;
}`)

        /// Gets the signature-position kinds and receiver shapes under test. Each
        /// names a distinct reader inside the compiler; the invariant is that they
        /// all give the same answer for the same declaration.
        private prop Kinds[]string -> []string{
            "Field",
            "Property",
            "MethodReturn",
            "IndexerElement",
            "ConstrainedMethodReturn",
            "ConstrainedProperty",
            "ConstrainedIndexer",
            "DeconstructOut",
            "InheritedField",
            "InheritedProperty",
            "BareInheritedField",
            "BareInheritedProperty",
            "BaseProperty"
        }

        /// Gets the annotation states. `ObliviousAbsent` and
        /// `ObliviousZero` are the two physical shapes of "unannotated"; #1354
        /// gives them the same answer and so must every kind.
        private prop States[]string -> []string{"NonNull", "Nullable", "ObliviousAbsent", "ObliviousZero"}

        /// Gets the differential matrix: signature-position path × annotation
        /// state. Both expectations — "does this bind as non-null?" and "what does
        /// the emitted program print?" — are computed from the annotation state
        /// ALONE. The kind never appears on the right-hand side.
        /// @returns The theory rows.
        func Matrix() sequence[[]object] {
            for kind in Kinds {
                for state in States {
                    // ADR-0186 step 3 — "its expected column changes in the
                    // oblivious row and nowhere else", which is the ADR's own
                    // precise, mechanical statement of its entire
                    // metadata-reading change, and this line is that statement
                    // in code.
                    //
                    // Both oblivious states now bind to a NON-NULL local, because
                    // the position is `T!` and `T! -> T` is an implicit
                    // conversion carrying §4's runtime check rather than a
                    // compile error. The `NonNull` and `Nullable` rows are
                    // untouched, and they are the controls that keep this an
                    // amendment to one cell rather than a weakening of the gate:
                    // an annotated-nullable position still must not bind to a
                    // non-null local.
                    let bindsNonNull = state == "NonNull" || state.StartsWith("Oblivious", StringComparison.Ordinal)
                    yield[]object{kind, state, bindsNonNull}
                }
            }
        }

        /// Binds [`source`](paramref) under [`nullability`](paramref) and
        /// returns the inferred type of its `probe` global.
        /// @param source The G# source.
        /// @param nullability The mode the compilation declares.
        /// @param references Reference assemblies.
        /// @returns The bound type of the `probe` global.
        private func BindGlobalProbeType(source string, nullability NullabilityMode, references ...string) TypeSymbol {
            using let resolver = ReferenceResolver.WithReferences(references)
            resolver.CurrentAssemblyName = ConsumerAssemblyName
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){
                AssemblyName = ConsumerAssemblyName,
                Nullability = nullability
            }
            let scope_ = compilation.GlobalScope
            Assert.DoesNotContain(
                scope_.Diagnostics,
                (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
            )
            return Assert.Single(scope_.Variables, (variable VariableSymbol) -> variable.Name == "probe").Type
        }

        private func BuildSource(kind string, state string, nullableTarget bool) string {
            let target = if nullableTarget {
                "string?"
            } else {
                "string"
            }
            // The oblivious members live on their own types, so the receiver varies
            // with the state rather than with the kind.
            let isOblivious = state.StartsWith("Oblivious", StringComparison.Ordinal)
            let receiverType = if isOblivious {
                state + "Surface"
            } else {
                "Surface"
            }
            let memberPrefix = state
            let indexArgument = if state == "Nullable" {
                "1L"
            } else {
                "1"
            }
            let constrainedInterface = if isOblivious {
                "I" + state + "Constrained"
            } else {
                "IConstrained"
            }
            let constrainedImpl = if isOblivious {
                state + "Constrained"
            } else {
                "Constrained"
            }
            let inheritedBase = if isOblivious {
                state + "Surface"
            } else {
                "Surface"
            }
            let deconstructReceiver = switch state {
                case "NonNull": "Surface"
                case "Nullable": "NullableDeconstructSurface"
                default: state + "Surface"
            }
            let body = switch kind {
                case "Field": (`    let receiver = ` + "$receiverType" + `()
`) + "    let probe $target = receiver.${memberPrefix}Field"
                case "Property": (`    let receiver = ` + "$receiverType" + `()
`) + "    let probe $target = receiver.${memberPrefix}Property"
                case "MethodReturn": (`    let receiver = ` + "$receiverType" + `()
`) + "    let probe $target = receiver.${memberPrefix}Method()"
                case "IndexerElement": (`    let receiver = ` + "$receiverType" + `()
`) + "    let probe $target = receiver[$indexArgument]"
                case "ConstrainedMethodReturn": "    let probe $target = ViaConstraint($constrainedImpl())"
                case "ConstrainedProperty": "    let probe $target = ViaConstraint($constrainedImpl())"
                case "ConstrainedIndexer": "    let probe $target = ViaConstraint($constrainedImpl())"
                case "DeconstructOut": (`    let receiver = ` + "$deconstructReceiver" + `()
`) + "    let (first, second) = receiver\n" + "    let probe $target = first"
                case "InheritedField" or
                    "InheritedProperty" or
                    "BareInheritedField" or
                    "BareInheritedProperty" or
                    "BaseProperty": "    let probe $target = Derived().Read()"
                default: throw ArgumentOutOfRangeException("kind")
            }
            // Only the nullable-target arm can ask the `nil` question; on the
            // non-null arm the comparison would be rejected on its own merits.
            let report = if nullableTarget {
                `    if probe == nil {
        Console.WriteLine("nil")
    } else {
        Console.WriteLine("value")
    }`
            } else {
                "    Console.WriteLine(\"value\")"
            }
            // The constrained rows all use the SAME generic helper shape and differ
            // only in which member kind they read off the constrained receiver `T`.
            let constrainedRead string? = switch kind {
                case "ConstrainedMethodReturn": "value.${memberPrefix}Method()"
                case "ConstrainedProperty": "value.${memberPrefix}Property"
                case "ConstrainedIndexer": "value[${(if state == "Nullable" { "1L" } else { "1" })}]"
                default: default(string?)
            }
            var helper = if constrainedRead == nil {
                string.Empty
            } else {
                (`
func ViaConstraint[T ` + "$constrainedInterface" + `](value T) ` + "$target" + ` {
    return ` + "$constrainedRead" + `
}`)
            }
            let inheritedRead string? = switch kind {
                case "InheritedField": "this.${memberPrefix}Field"
                case "InheritedProperty": "this.${memberPrefix}Property"
                case "BareInheritedField": "${memberPrefix}Field"
                case "BareInheritedProperty": "${memberPrefix}Property"
                case "BaseProperty": "base.${memberPrefix}Property"
                default: default(string?)
            }
            if inheritedRead != nil {
                helper = (`
class Derived : ` + "$inheritedBase" + ` {
    func Read() ` + "$target" + ` {
        return ` + "$inheritedRead" + `
    }
}`)
            }
            return (`package ` + "$ConsumerAssemblyName" + `
import Issue3705.NullabilityLibrary

func Main() {
` + "$body" + `
` + "$report" + `
}
` + "$helper")
        }

        private func Describe(result Issue3705MemberKindNullabilityDifferentialTests.CompileResult) string -> string
            .Join(
            Environment.NewLine,
            result.Diagnostics.Select(
                (d Issue3705MemberKindNullabilityDifferentialTests.DiagnosticInfo) -> d.Id + ": " + d.Message
            )
        )

        private func CompileGSharp(source string, references ...string) Issue3705MemberKindNullabilityDifferentialTests
            .CompileResult {
            using let resolver = ReferenceResolver.WithReferences(references)
            resolver.CurrentAssemblyName = ConsumerAssemblyName
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){
                AssemblyName = ConsumerAssemblyName
            }
            using let output = MemoryStream()
            let emit = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: ConsumerAssemblyName)
            return Issue3705MemberKindNullabilityDifferentialTests.CompileResult(
                emit.Success,
                emit
                    .Diagnostics
                    .Select(
                    (
                        d GSharp.Core.CodeAnalysis.Diagnostic
                    ) -> Issue3705MemberKindNullabilityDifferentialTests.DiagnosticInfo(d.Id, d.Message)
                )
                    .ToArray(),
                if emit.Success {
                    output.ToArray()
                } else {
                    Array.Empty[uint8]()
                }
            )
        }

        /// Loads and runs the emitted assembly, capturing stdout. A nullability
        /// edit moves the types the emitter sees, so "it bound with no diagnostics"
        /// is not evidence the emitted IL is executable.
        private func RunGSharp(
            compiled Issue3705MemberKindNullabilityDifferentialTests.CompileResult,
            libraryPath string,
            contextName string
        ) string {
            let loadContext = AssemblyLoadContext(
                "Issue3705MemberKindNullabilityDifferentialTests" + "-" + contextName,
                isCollectible: true
            )
            loadContext.Resolving += (context AssemblyLoadContext, name AssemblyName) -> if string.Equals(
                name.Name,
                LibraryAssemblyName,
                StringComparison.Ordinal
            ) {
                context.LoadFromAssemblyPath(libraryPath)
            } else {
                default(Assembly?)
            }
            try {
                using let peStream = MemoryStream(compiled.PeBytes)
                let assembly = loadContext.LoadFromStream(peStream)
                let entry MethodInfo? = assembly.EntryPoint
                Assert.NotNull(entry)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    let arguments[]?object = if entry!!.GetParameters().Length == 0 {
                        default([]?object)
                    } else {
                        []object{Array.Empty[string]()}
                    }
                    entry!!.Invoke(nil, arguments)
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }

        private func EmitCSharpLibrary(directory string, assemblyName string, source string) string {
            let references = (
                (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                    Array.Empty[string]()
            )
                .Where(File.Exists).Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let path = Path.Combine(directory, assemblyName + ".dll")
            using let output = File.Create(path)
            let emit = compilation.Emit(output)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            return path
        }

        private func CreateOutputDirectory() string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue3705MemberKindNullabilityDifferentialTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            return directory
        }

        private func DeleteOutputDirectory(directory string) {
            try {
                Directory.Delete(directory, recursive: true)
            } catch (IOException) { }
        }
    }
}
