// <copyright file="Issue3705MemberKindNullabilityDifferentialTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
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
/// type is nullable depends only on the DECLARATION's annotation state —
/// annotated non-null, annotated nullable, or unannotated/oblivious — and never
/// on the member kind through which the position was reached. The member kind
/// never appears on the right-hand side of the expectation; the table IS the
/// invariant.
/// </para>
/// <para>
/// The oblivious row is deliberately part of the contract rather than an
/// accident: issue #1354 fixed the import default so an unannotated imported
/// reference type reads as nullable. Every kind must apply that rule too, and a
/// swap that only fixed the explicitly-annotated positions would leave the
/// kinds disagreeing again.
/// </para>
/// <para>
/// Guard rails, and they are half the point: the <c>NonNull</c> rows are the
/// negative controls. They fail if a fix widens an annotated non-null position
/// to nullable — the #3704-shaped regression the family-2 triage warned about,
/// where a widened declaration reaches a position that consumes it as non-null.
/// <see cref="Fixture_Really_Presents_Three_Distinct_AnnotationStates"/> is the
/// anti-vacuity assertion: it reads the emitted metadata directly and proves
/// the three states carry genuinely different <c>[Nullable]</c> bytes, so the
/// table cannot go green because every row secretly tested the same thing.
/// </para>
/// </summary>
public sealed class Issue3705MemberKindNullabilityDifferentialTests
{
    private const string ConsumerAssemblyName = "Issue3705.NullabilityConsumer";
    private const string LibraryAssemblyName = "Issue3705.NullabilityLibrary";

    /// <summary>
    /// One reference-typed signature position of every kind, in each of the
    /// three annotation states. <c>#nullable disable</c> is what makes the
    /// <c>Oblivious</c> members carry no <c>[Nullable]</c> metadata at all.
    /// </summary>
    private const string CSharpLibrarySource = """
        #nullable enable
        using System;
        using System.Collections.Generic;

        namespace Issue3705.NullabilityLibrary;

        public class Surface
        {
            public string NonNullField = string.Empty;
            public string? NullableField = null;

            public string NonNullProperty { get; set; } = string.Empty;
            public string? NullableProperty { get; set; }

            public string NonNullMethod() => string.Empty;
            public string? NullableMethod() => null;

            public string this[int index] => string.Empty;
            public string? this[long index] => null;

            public void Deconstruct(out string first, out int second)
            {
                first = string.Empty;
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
        }

        public class Constrained : IConstrained
        {
            public string NonNullMethod() => string.Empty;

            public string? NullableMethod() => null;
        }

        #nullable disable

        public class ObliviousSurface
        {
            public string ObliviousField;

            public string ObliviousProperty { get; set; }

            public string ObliviousMethod() => string.Empty;

            public string this[int index] => string.Empty;

            public void Deconstruct(out string first, out int second)
            {
                first = string.Empty;
                second = 0;
            }
        }

        public interface IObliviousConstrained
        {
            string ObliviousMethod();
        }

        public class ObliviousConstrained : IObliviousConstrained
        {
            public string ObliviousMethod() => string.Empty;
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
        "DeconstructOut",
    };

    /// <summary>
    /// Gets the differential matrix: signature-position kind × ANNOTATED
    /// state. The expectation ("does this bind as non-null?") is computed
    /// from the annotation state ALONE — the kind never appears on the
    /// right-hand side.
    /// </summary>
    /// <returns>The theory rows.</returns>
    public static IEnumerable<object[]> AnnotatedMatrix()
    {
        foreach (var kind in Kinds)
        {
            foreach (var state in new[] { "NonNull", "Nullable" })
            {
                yield return new object[] { kind, state, state == "NonNull" };
            }
        }
    }

    /// <summary>
    /// Gets the UNANNOTATED (oblivious) half of the matrix, with each kind's
    /// answer as the compiler gives it today. Issue #1354 says every row here
    /// should be nullable; three are not. See
    /// <see cref="ObliviousPositions_Diverge_Where_Receiver_Substitution_Runs"/>
    /// for why this half is pinned rather than asserted.
    /// </summary>
    /// <returns>The theory rows.</returns>
    public static IEnumerable<object[]> ObliviousMatrix()
    {
        // The three that diverge are exactly the readers whose symbolic
        // (receiver-substituted) branch routes through
        // NullableFlagsBuilder.MergeDeclarationNullability, which returns the
        // projected type unchanged when the declaration carries no flags at
        // all. The three that agree take the plain ClrNullability readers,
        // which apply the #1354 default.
        var divergent = new HashSet<string>
        {
            "Field",
            "ConstrainedMethodReturn",
            "DeconstructOut",
        };

        foreach (var kind in Kinds)
        {
            yield return new object[] { kind, divergent.Contains(kind) };
        }
    }

    [Theory]
    [MemberData(nameof(AnnotatedMatrix))]
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
        }
        finally
        {
            DeleteOutputDirectory(directory);
        }
    }

    /// <summary>
    /// The deferred half, pinned rather than asserted.
    /// <para>
    /// Issue #1354 made an unannotated imported reference type read as
    /// nullable, and the plain <c>ClrNullability</c> readers implement it. The
    /// receiver-substituting readers do not: <c>MergeDeclarationNullability</c>
    /// short-circuits on <c>declarationFlags.IsDefaultOrEmpty</c> and returns
    /// the projected (non-null) type, so a member reached through a symbolic
    /// receiver keeps the pre-#1354 answer.
    /// </para>
    /// <para>
    /// Closing that hole is a semantic change, not a probe fix: it would flip
    /// every unannotated imported field / constrained call / deconstruction in
    /// the corpus to nullable at once, which is the #3704 shape the family-2
    /// triage flagged. So this fixture pins the divergence — three kinds
    /// disagree with the other three, and the set is named explicitly. When
    /// the rule is settled and the hole closed, this test fails and forces the
    /// review; until then it stops the set drifting.
    /// </para>
    /// </summary>
    /// <param name="kind">The signature-position kind.</param>
    /// <param name="bindsNonNullToday">The answer the compiler gives today.</param>
    [Theory]
    [MemberData(nameof(ObliviousMatrix))]
    public void ObliviousPositions_Diverge_Where_Receiver_Substitution_Runs(
        string kind,
        bool bindsNonNullToday)
    {
        var directory = CreateOutputDirectory();
        try
        {
            var libraryPath = EmitCSharpLibrary(directory, LibraryAssemblyName, CSharpLibrarySource);
            var strict = CompileGSharp(BuildSource(kind, "Oblivious", nullableTarget: false), libraryPath);
            var lenient = CompileGSharp(BuildSource(kind, "Oblivious", nullableTarget: true), libraryPath);

            Assert.True(
                lenient.Success,
                $"{kind}/Oblivious: the position must bind at all: {Describe(lenient)}");
            Assert.Equal(bindsNonNullToday, strict.Success);
        }
        finally
        {
            DeleteOutputDirectory(directory);
        }
    }

    /// <summary>
    /// Anti-vacuity. #3716's load-context table nearly shipped a fixture that
    /// would have passed even if its "MLC twin" had silently been the host
    /// type; the analogous trap here is a fixture whose three annotation states
    /// all carry the same metadata, which would make every row above assert the
    /// same thing. Read the emitted <c>[Nullable]</c> bytes back through the
    /// same reader the binder uses and prove the states really differ.
    /// </summary>
    [Fact]
    public void Fixture_Really_Presents_Three_Distinct_AnnotationStates()
    {
        var directory = CreateOutputDirectory();
        try
        {
            var libraryPath = EmitCSharpLibrary(directory, LibraryAssemblyName, CSharpLibrarySource);
            using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
            Assert.True(resolver.TryResolveType("Issue3705.NullabilityLibrary.Surface", out var surface));
            Assert.True(resolver.TryResolveType("Issue3705.NullabilityLibrary.ObliviousSurface", out var oblivious));

            var nonNull = ClrNullability.GetFieldTypeSymbol(surface!.GetField("NonNullField")!);
            var nullable = ClrNullability.GetFieldTypeSymbol(surface.GetField("NullableField")!);
            var unannotated = ClrNullability.GetFieldTypeSymbol(oblivious!.GetField("ObliviousField")!);

            // Annotated non-null is the only one of the three that is not
            // nullable — if this ever collapses, every "Nullable"/"Oblivious"
            // row above becomes vacuous.
            Assert.IsNotType<NullableTypeSymbol>(nonNull);
            Assert.IsType<NullableTypeSymbol>(nullable);
            Assert.IsType<NullableTypeSymbol>(unannotated);

            // …and the two nullable states must not be nullable for the SAME
            // reason: the annotated one carries an explicit `[Nullable(2)]`,
            // the oblivious one carries no nullability metadata at all.
            Assert.Equal(
                new byte[] { 1 },
                ClrNullability.ReadNullableFlags(surface.GetField("NonNullField")!, surface).ToArray());
            Assert.Equal(
                new byte[] { 2 },
                ClrNullability.ReadNullableFlags(surface.GetField("NullableField")!, surface).ToArray());
            Assert.Empty(
                ClrNullability.ReadNullableFlags(oblivious.GetField("ObliviousField")!, oblivious));
        }
        finally
        {
            DeleteOutputDirectory(directory);
        }
    }

    private static string BuildSource(string kind, string state, bool nullableTarget)
    {
        var target = nullableTarget ? "string?" : "string";

        // `Oblivious` members live on a separate `#nullable disable` type, so
        // the receiver varies with the state rather than with the kind.
        var isOblivious = state == "Oblivious";
        var receiverType = isOblivious ? "ObliviousSurface" : "Surface";
        var memberPrefix = isOblivious ? "Oblivious" : state;
        var indexArgument = state == "Nullable" ? "1L" : "1";
        var constrainedInterface = isOblivious ? "IObliviousConstrained" : "IConstrained";
        var constrainedImpl = isOblivious ? "ObliviousConstrained" : "Constrained";
        var deconstructReceiver = state switch
        {
            "NonNull" => "Surface",
            "Nullable" => "NullableDeconstructSurface",
            _ => "ObliviousSurface",
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

            // Reaches MemberLookup.GetClrMethodParameterTypeSymbol and the
            // synthesised deconstruction local in StatementBinder.Narrowing.
            "DeconstructOut" => $"    let receiver = {deconstructReceiver}()\n"
                + "    let (first, second) = receiver\n"
                + $"    let probe {target} = first",
            _ => throw new ArgumentOutOfRangeException(nameof(kind)),
        };

        var helper = kind == "ConstrainedMethodReturn"
            ? $$"""

                func ViaConstraint[T {{constrainedInterface}}](value T) {{target}} {
                    return value.{{memberPrefix}}Method()
                }
                """
            : string.Empty;

        return $$"""
            package {{ConsumerAssemblyName}}
            import Issue3705.NullabilityLibrary

            func Run() {
            {{body}}
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
            emit.Diagnostics.Select(d => new DiagnosticInfo(d.Id, d.Message)).ToArray());
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

    private readonly record struct CompileResult(bool Success, DiagnosticInfo[] Diagnostics);

    private readonly record struct DiagnosticInfo(string Id, string Message);
}
