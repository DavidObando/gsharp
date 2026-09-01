// <copyright file="Issue3705MemberKindNullabilityDifferentialTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3705, family 2 — the nullability differential gate.
/// <para>
/// The companion of <see cref="Issue3705MemberKindAccessibilityDifferentialTests"/>
/// (member kind × accessibility) and of
/// <c>Issue3705LoadContextDifferentialTests</c> (compiler query × load context).
/// The family-2 shape is #3703: a signature position read with a bare
/// <c>TypeSymbol.FromClrType</c> where the sibling position one line away used
/// the nullability-aware <c>ClrNullability</c> reader — so an imported
/// <c>string?</c> bound as non-null <c>string</c>, the unsound direction.
/// </para>
/// <para>
/// So rather than one test per site, this fixture asserts the INVARIANT: for a
/// reference-typed signature position on an imported member, whether the bound
/// type is nullable depends only on the DECLARATION's annotation state, and
/// never on the member kind through which the position was reached. The member
/// kind never appears on the right-hand side of either expectation; the table
/// IS the invariant.
/// </para>
/// <para>
/// There are FOUR annotation states, not three, and the fourth is the one the
/// original family-2 deferral missed. Issue #1354 says a reference position is
/// non-null only for an explicit <c>1</c>; oblivious reaches the compiler in two
/// physically different shapes and a fix that only handles the first leaves the
/// kinds disagreeing:
/// <list type="bullet">
/// <item><c>ObliviousAbsent</c> — no <c>[Nullable]</c> and no
/// <c>[NullableContext]</c> anywhere, so the flags array is EMPTY.</item>
/// <item><c>ObliviousZero</c> — a <c>#nullable disable</c> member of a
/// <c>[NullableContext(1)]</c> type, which csc annotates with an explicit
/// <c>[Nullable(0)]</c>: a NON-empty flags array holding the oblivious byte.
/// <c>MergeDeclarationNullability</c>'s empty-flags short-circuit never saw
/// this one at all; it fell through to an <c>ApplyRootAnnotation</c> that
/// open-coded C#'s "nullable iff the byte is 2" instead of G#'s "non-null iff
/// the byte is 1".</item>
/// </list>
/// </para>
/// <para>
/// Guard rails, and they are half the point: the <c>NonNull</c> rows are the
/// negative controls. They fail if a fix widens an annotated non-null position
/// to nullable — the #3704-shaped regression the family-2 triage warned about,
/// where a widened declaration reaches a position that consumes it as non-null.
/// <see cref="Fixture_Really_Presents_Four_Distinct_AnnotationStates"/> is the
/// anti-vacuity assertion: it reads the emitted metadata directly and proves
/// the four states carry genuinely different <c>[Nullable]</c> bytes, so the
/// table cannot go green because every row secretly tested the same thing. In
/// particular it pins <c>ObliviousZero</c> to the byte <c>[0]</c>, because if
/// csc ever chose a different <c>[NullableContext]</c> for that type the state
/// would silently collapse into <c>ObliviousAbsent</c> and stop testing the
/// second mechanism.
/// </para>
/// <para>
/// Every row also EXECUTES its emitted assembly. A nullability edit changes the
/// types the emitter sees, and binding cleanly with zero diagnostics is not
/// evidence that the emitted IL runs; the marker each program prints is derived
/// from the annotation state alone, exactly like the bind expectation.
/// </para>
/// </summary>
public sealed class Issue3705MemberKindNullabilityDifferentialTests
{
    private const string ConsumerAssemblyName = "Issue3705.NullabilityConsumer";
    private const string LibraryAssemblyName = "Issue3705.NullabilityLibrary";

    /// <summary>
    /// One reference-typed signature position of every kind, in each of the
    /// four annotation states.
    /// <para>
    /// Every position that is not <c>Nullable</c> holds a non-null value at
    /// runtime and every <c>Nullable</c> position holds <c>null</c>, so the
    /// executed marker is a function of the annotation state alone.
    /// </para>
    /// <para>
    /// <c>#nullable disable</c> alone is what makes the <c>Oblivious*</c>
    /// members oblivious; whether that shows up as absent metadata or as an
    /// explicit <c>[Nullable(0)]</c> is decided by the enclosing type's
    /// <c>[NullableContext]</c>, which is why the <c>ObliviousZero</c> types
    /// carry enough non-null anchors to push csc's majority vote to <c>1</c>.
    /// </para>
    /// </summary>
    private const string CSharpLibrarySource = """
        #nullable enable
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

        // ObliviousZero: a `[NullableContext(1)]` type whose `#nullable disable`
        // members therefore carry an explicit `[Nullable(0)]`. The anchors exist
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

        // ObliviousAbsent: no `[Nullable]` and no `[NullableContext]` reaches
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
        // rewrite the declaration's `T` into `T?`. `Value`'s metadata slot is
        // an OPEN `T` with no nullability byte at all.
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
        }
        """;

    /// <summary>
    /// Gets the signature-position kinds under test. Each names a distinct
    /// reader inside the compiler; the invariant is that they all give the
    /// same answer for the same declaration.
    /// </summary>
    private static string[] Kinds => new[]
    {
        "Field",
        "Property",
        "MethodReturn",
        "IndexerElement",
        "ConstrainedMethodReturn",
        "ConstrainedProperty",
        "ConstrainedIndexer",
        "DeconstructOut",
    };

    /// <summary>
    /// Gets the annotation states. <c>ObliviousAbsent</c> and
    /// <c>ObliviousZero</c> are the two physical shapes of "unannotated"; #1354
    /// gives them the same answer and so must every kind.
    /// </summary>
    private static string[] States => new[]
    {
        "NonNull",
        "Nullable",
        "ObliviousAbsent",
        "ObliviousZero",
    };

    /// <summary>
    /// Gets the differential matrix: signature-position kind × annotation
    /// state. Both expectations — "does this bind as non-null?" and "what does
    /// the emitted program print?" — are computed from the annotation state
    /// ALONE. The kind never appears on the right-hand side.
    /// </summary>
    /// <returns>The theory rows.</returns>
    public static IEnumerable<object[]> Matrix()
    {
        foreach (var kind in Kinds)
        {
            foreach (var state in States)
            {
                yield return new object[] { kind, state, state == "NonNull" };
            }
        }
    }

    /// <summary>
    /// The family-2 invariant, over all four annotation states.
    /// <para>
    /// Rows that pass on <c>origin/main</c> and are here as guard rails: every
    /// <c>NonNull</c> and <c>Nullable</c> row (#3741 landed those), and the
    /// <c>Oblivious*</c> rows for <c>Property</c>, <c>MethodReturn</c> and
    /// <c>IndexerElement</c>, which already took the plain
    /// <c>ClrNullability</c> readers.
    /// </para>
    /// <para>
    /// Rows that FAIL on <c>origin/main</c>: the <c>Oblivious*</c> rows for
    /// <c>Field</c>, <c>ConstrainedMethodReturn</c> and <c>DeconstructOut</c>,
    /// the three kinds that route through
    /// <c>NullableFlagsBuilder.MergeDeclarationNullability</c>. On main they
    /// bind an unannotated imported reference position as non-null, which is
    /// the pre-#1354 answer.
    /// </para>
    /// </summary>
    /// <param name="kind">The signature-position kind.</param>
    /// <param name="state">The declaration's annotation state.</param>
    /// <param name="expectedNonNull">Whether the position must bind non-null.</param>
    [Theory]
    [MemberData(nameof(Matrix))]
    public void SignaturePositions_Agree_On_DeclarationNullability(
        string kind,
        string state,
        bool expectedNonNull)
    {
        var directory = CreateOutputDirectory();
        try
        {
            var libraryPath = EmitCSharpLibrary(directory, LibraryAssemblyName, CSharpLibrarySource);

            // The probe binds the position to a NON-NULL `string` local, which
            // succeeds only when the position itself bound as non-null.
            var strict = CompileGSharp(BuildSource(kind, state, nullableTarget: false), libraryPath);

            // …and to a `string?` local, which must succeed either way. This
            // arm is what distinguishes "bound nullable" from "did not bind at
            // all" — without it a lookup regression would read as a passing row.
            var lenient = CompileGSharp(BuildSource(kind, state, nullableTarget: true), libraryPath);

            Assert.True(
                lenient.Success,
                $"{kind}/{state}: the position must bind at all: {Describe(lenient)}");

            if (expectedNonNull)
            {
                Assert.True(
                    strict.Success,
                    $"{kind}/{state} should bind NON-NULL, but assigning it to a "
                    + $"non-null local failed: {Describe(strict)}");
            }
            else
            {
                Assert.False(
                    strict.Success,
                    $"{kind}/{state} should bind NULLABLE, but it assigned to a "
                    + "non-null local without a diagnostic.");
            }

            // Binding cleanly is not the same as emitting something that runs.
            // The marker is a function of the annotation state alone: every
            // position that is not `Nullable` holds a non-null value.
            var expectedMarker = state == "Nullable" ? "nil" : "value";
            Assert.Equal(
                expectedMarker,
                RunGSharp(lenient, libraryPath, $"{kind}-{state}").Trim());
        }
        finally
        {
            DeleteOutputDirectory(directory);
        }
    }

    /// <summary>
    /// The soundness case, executed. An oblivious imported field that really is
    /// <c>null</c> at run time.
    /// <para>
    /// The local is INFERRED rather than annotated, so on <c>origin/main</c>
    /// it infers non-null <c>string</c> and the <c>nil</c> guard is rejected —
    /// which is the whole defect: main hands a null to a position it has typed
    /// as non-null and offers no way to check. With the #1354 rule applied
    /// through receiver substitution the guard binds, the program runs, and the
    /// guard fires.
    /// </para>
    /// </summary>
    [Fact]
    public void ObliviousField_That_Is_Null_At_Runtime_Is_Guardable_And_Runs()
    {
        var directory = CreateOutputDirectory();
        try
        {
            var libraryPath = EmitCSharpLibrary(directory, LibraryAssemblyName, CSharpLibrarySource);
            var source = $$"""
                package {{ConsumerAssemblyName}}
                import Issue3705.NullabilityLibrary

                func Main() {
                    let surface = ObliviousNullAtRuntimeSurface()
                    let probe = surface.ObliviousField
                    if probe == nil {
                        Console.WriteLine("guarded")
                    } else {
                        Console.WriteLine("leaked")
                    }
                }
                """;

            var compiled = CompileGSharp(source, libraryPath);
            Assert.True(
                compiled.Success,
                "an oblivious imported field must bind nullable, so a nil guard "
                + $"over it binds: {Describe(compiled)}");
            Assert.Equal("guarded", RunGSharp(compiled, libraryPath, "NullAtRuntime").Trim());
        }
        finally
        {
            DeleteOutputDirectory(directory);
        }
    }

    /// <summary>
    /// The one carve-out from the uniformity above, pinned so it stays a
    /// decision rather than decaying into "we gave up".
    /// <para>
    /// #1354 is a rule about CONCRETE reference positions in imported metadata.
    /// An OPEN type-parameter position is not one: its nullability arrives with
    /// the type ARGUMENT at substitution. Applying the declaration's missing
    /// byte there would overwrite the caller's answer with a guess, and for an
    /// unconstrained <c>T</c> substituted with a value type it would silently
    /// mean <c>Nullable&lt;T&gt;</c>.
    /// </para>
    /// <para>
    /// So <c>Box&lt;string&gt;.Value</c> read off an oblivious holder must be
    /// <c>string</c> — the argument's own nullability — and NOT <c>string?</c>,
    /// even though the holder carries no nullability metadata at all and every
    /// concrete position on it does widen. <c>Box&lt;int&gt;.Value</c> is the
    /// value-type control: it must stay a plain <c>int32</c>.
    /// </para>
    /// <para>
    /// The in-tree guard rail for the same rule is
    /// <c>Issue3311OpenMapMemberLookupEmitTests.GenericFunc_Keys_FullyOpen_ReturnsFirstKey_As_K</c>
    /// (<c>map[K, V].Keys</c> must iterate as <c>K</c>); this row is the
    /// imported-metadata twin of it, and both fail if the carve-out is dropped.
    /// </para>
    /// </summary>
    [Fact]
    public void OpenTypeParameterPositions_Take_Nullability_From_The_Argument()
    {
        var directory = CreateOutputDirectory();
        try
        {
            var libraryPath = EmitCSharpLibrary(directory, LibraryAssemblyName, CSharpLibrarySource);

            // A reference type argument: `ObliviousBox[string].Value` is
            // `string`, not `string?`, despite the declaration being fully
            // oblivious. The receiver is constructed in G# so that its OWN
            // nullability is not in question — the only thing under test is the
            // open `T` slot.
            var reference = CompileGSharp(
                $$"""
                package {{ConsumerAssemblyName}}
                import Issue3705.NullabilityLibrary

                func Main() {
                    let boxed = ObliviousBox[string]("V")
                    let probe string = boxed.Value
                    Console.WriteLine(probe)
                }
                """,
                libraryPath);
            Assert.True(
                reference.Success,
                "an open type-parameter position must take the ARGUMENT's "
                + $"nullability, not the declaration's: {Describe(reference)}");
            Assert.Equal("V", RunGSharp(reference, libraryPath, "OpenTypeParamRef").Trim());

            // A value type argument: the case where widening would not merely
            // be noisy but would change the type to `Nullable<int>`.
            var value = CompileGSharp(
                $$"""
                package {{ConsumerAssemblyName}}
                import Issue3705.NullabilityLibrary

                func Main() {
                    let boxed = ObliviousBox[int32](7)
                    let probe int32 = boxed.Value
                    Console.WriteLine(probe)
                }
                """,
                libraryPath);
            Assert.True(
                value.Success,
                $"a value-type argument must not become nullable: {Describe(value)}");
            Assert.Equal("7", RunGSharp(value, libraryPath, "OpenTypeParamValue").Trim());
        }
        finally
        {
            DeleteOutputDirectory(directory);
        }
    }

    /// <summary>
    /// Anti-vacuity. #3716's load-context table nearly shipped a fixture that
    /// would have passed even if its "MLC twin" had silently been the host
    /// type; the analogous trap here is a fixture whose annotation states all
    /// carry the same metadata, which would make every row above assert the
    /// same thing. Read the emitted <c>[Nullable]</c> bytes back through the
    /// same reader the binder uses and prove the four states really differ.
    /// </summary>
    [Fact]
    public void Fixture_Really_Presents_Four_Distinct_AnnotationStates()
    {
        var directory = CreateOutputDirectory();
        try
        {
            var libraryPath = EmitCSharpLibrary(directory, LibraryAssemblyName, CSharpLibrarySource);
            using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
            Assert.True(resolver.TryResolveType("Issue3705.NullabilityLibrary.Surface", out var surface));
            Assert.True(resolver.TryResolveType("Issue3705.NullabilityLibrary.ObliviousAbsentSurface", out var absent));
            Assert.True(resolver.TryResolveType("Issue3705.NullabilityLibrary.ObliviousZeroSurface", out var zero));

            var nonNullField = surface!.GetField("NonNullField")!;
            var nullableField = surface.GetField("NullableField")!;
            var absentField = absent!.GetField("ObliviousAbsentField")!;
            var zeroField = zero!.GetField("ObliviousZeroField")!;

            // Annotated non-null is the only one of the four that is not
            // nullable — if this ever collapses, every non-`NonNull` row above
            // becomes vacuous.
            Assert.IsNotType<NullableTypeSymbol>(ClrNullability.GetFieldTypeSymbol(nonNullField));
            Assert.IsType<NullableTypeSymbol>(ClrNullability.GetFieldTypeSymbol(nullableField));
            Assert.IsType<NullableTypeSymbol>(ClrNullability.GetFieldTypeSymbol(absentField));
            Assert.IsType<NullableTypeSymbol>(ClrNullability.GetFieldTypeSymbol(zeroField));

            // …and the three nullable states must not be nullable for the SAME
            // reason. `ObliviousZero` in particular must be a NON-empty `[0]`:
            // if csc ever picked a different `[NullableContext]` for that type
            // it would collapse into `ObliviousAbsent` and silently stop
            // covering the second divergence mechanism.
            Assert.Equal(
                new byte[] { 1 },
                ClrNullability.ReadNullableFlags(nonNullField, surface).ToArray());
            Assert.Equal(
                new byte[] { 2 },
                ClrNullability.ReadNullableFlags(nullableField, surface).ToArray());
            Assert.Empty(ClrNullability.ReadNullableFlags(absentField, absent));
            Assert.Equal(
                new byte[] { 0 },
                ClrNullability.ReadNullableFlags(zeroField, zero).ToArray());

            // The constrained rows read off an INTERFACE, whose `[NullableContext]`
            // majority vote is computed separately from the surface class's. Pin
            // it too, or the constrained ObliviousZero rows could silently
            // degrade into ObliviousAbsent while the table stayed green.
            Assert.True(resolver.TryResolveType(
                "Issue3705.NullabilityLibrary.IObliviousZeroConstrained",
                out var zeroConstrained));
            Assert.Equal(
                new byte[] { 0 },
                ClrNullability.ReadNullableFlags(
                    zeroConstrained!.GetProperty("ObliviousZeroProperty")!,
                    zeroConstrained).ToArray());
        }
        finally
        {
            DeleteOutputDirectory(directory);
        }
    }

    private static string BuildSource(string kind, string state, bool nullableTarget)
    {
        var target = nullableTarget ? "string?" : "string";

        // The oblivious members live on their own types, so the receiver varies
        // with the state rather than with the kind.
        var isOblivious = state.StartsWith("Oblivious", StringComparison.Ordinal);
        var receiverType = isOblivious ? state + "Surface" : "Surface";
        var memberPrefix = state;
        var indexArgument = state == "Nullable" ? "1L" : "1";
        var constrainedInterface = isOblivious ? "I" + state + "Constrained" : "IConstrained";
        var constrainedImpl = isOblivious ? state + "Constrained" : "Constrained";
        var deconstructReceiver = state switch
        {
            "NonNull" => "Surface",
            "Nullable" => "NullableDeconstructSurface",
            _ => state + "Surface",
        };

        var body = kind switch
        {
            "Field" => $"    let receiver = {receiverType}()\n"
                + $"    let probe {target} = receiver.{memberPrefix}Field",
            "Property" => $"    let receiver = {receiverType}()\n"
                + $"    let probe {target} = receiver.{memberPrefix}Property",
            "MethodReturn" => $"    let receiver = {receiverType}()\n"
                + $"    let probe {target} = receiver.{memberPrefix}Method()",
            "IndexerElement" => $"    let receiver = {receiverType}()\n"
                + $"    let probe {target} = receiver[{indexArgument}]",

            // Reaches MemberLookup.GetClrMethodReturnTypeSymbol — the reflected
            // fallback slot whose three siblings already read nullability.
            "ConstrainedMethodReturn" => $"    let probe {target} = ViaConstraint({constrainedImpl}())",

            // The SAME receiver shape as the row above, one member kind over.
            // Reaches MemberLookup.GetClrPropertyTypeSymbol / the indexer path.
            "ConstrainedProperty" => $"    let probe {target} = ViaConstraint({constrainedImpl}())",
            "ConstrainedIndexer" => $"    let probe {target} = ViaConstraint({constrainedImpl}())",

            // Reaches MemberLookup.GetClrMethodParameterTypeSymbol and the
            // synthesised deconstruction local in StatementBinder.Narrowing.
            "DeconstructOut" => $"    let receiver = {deconstructReceiver}()\n"
                + "    let (first, second) = receiver\n"
                + $"    let probe {target} = first",
            _ => throw new ArgumentOutOfRangeException(nameof(kind)),
        };

        // Only the nullable-target arm can ask the `nil` question; on the
        // non-null arm the comparison would be rejected on its own merits.
        var report = nullableTarget
            ? """
                  if probe == nil {
                      Console.WriteLine("nil")
                  } else {
                      Console.WriteLine("value")
                  }
              """
            : "    Console.WriteLine(\"value\")";

        // The constrained rows all use the SAME generic helper shape and differ
        // only in which member kind they read off the constrained receiver `T`.
        var constrainedRead = kind switch
        {
            "ConstrainedMethodReturn" => $"value.{memberPrefix}Method()",
            "ConstrainedProperty" => $"value.{memberPrefix}Property",

            // The annotated interface distinguishes its two indexers by argument
            // type, exactly as `Surface` does; the oblivious interfaces declare
            // only `this[int]`.
            "ConstrainedIndexer" => $"value[{(state == "Nullable" ? "1L" : "1")}]",
            _ => null,
        };

        var helper = constrainedRead == null
            ? string.Empty
            : $$"""

                func ViaConstraint[T {{constrainedInterface}}](value T) {{target}} {
                    return {{constrainedRead}}
                }
                """;

        return $$"""
            package {{ConsumerAssemblyName}}
            import Issue3705.NullabilityLibrary

            func Main() {
            {{body}}
            {{report}}
            }
            {{helper}}
            """;
    }

    private static string Describe(CompileResult result)
        => string.Join(Environment.NewLine, result.Diagnostics.Select(d => d.Id + ": " + d.Message));

    private static CompileResult CompileGSharp(string source, params string[] references)
    {
        using var resolver = ReferenceResolver.WithReferences(references);
        resolver.CurrentAssemblyName = ConsumerAssemblyName;
        var compilation = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(source)))
        {
            AssemblyName = ConsumerAssemblyName,
        };

        using var output = new MemoryStream();
        var emit = compilation.Emit(
            output,
            pdbStream: null,
            refStream: null,
            assemblyName: ConsumerAssemblyName);
        return new CompileResult(
            emit.Success,
            emit.Diagnostics.Select(d => new DiagnosticInfo(d.Id, d.Message)).ToArray(),
            emit.Success ? output.ToArray() : Array.Empty<byte>());
    }

    /// <summary>
    /// Loads and runs the emitted assembly, capturing stdout. A nullability
    /// edit moves the types the emitter sees, so "it bound with no diagnostics"
    /// is not evidence the emitted IL is executable.
    /// </summary>
    private static string RunGSharp(CompileResult compiled, string libraryPath, string contextName)
    {
        var loadContext = new AssemblyLoadContext(
            nameof(Issue3705MemberKindNullabilityDifferentialTests) + "-" + contextName,
            isCollectible: true);
        loadContext.Resolving += (context, name) =>
            string.Equals(name.Name, LibraryAssemblyName, StringComparison.Ordinal)
                ? context.LoadFromAssemblyPath(libraryPath)
                : null;

        try
        {
            using var peStream = new MemoryStream(compiled.PeBytes);
            var assembly = loadContext.LoadFromStream(peStream);
            var entry = assembly.EntryPoint;
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                var arguments = entry.GetParameters().Length == 0
                    ? null
                    : new object[] { Array.Empty<string>() };
                entry.Invoke(null, arguments);
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static string EmitCSharpLibrary(string directory, string assemblyName, string source)
    {
        var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                ?.Split(Path.PathSeparator)
                ?? Array.Empty<string>())
            .Where(File.Exists)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var path = Path.Combine(directory, assemblyName + ".dll");
        using var output = File.Create(path);
        var emit = compilation.Emit(output);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        return path;
    }

    private static string CreateOutputDirectory()
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue3705MemberKindNullabilityDifferentialTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }

    private static void DeleteOutputDirectory(string directory)
    {
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    private readonly record struct CompileResult(
        bool Success,
        DiagnosticInfo[] Diagnostics,
        byte[] PeBytes);

    private readonly record struct DiagnosticInfo(string Id, string Message);
}
