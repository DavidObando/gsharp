// <copyright file="Issue1958InterfaceMemberGenericSubstitutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Regression tests for issue #1958: <c>InterfaceSymbol.SubstituteType</c> had
/// the same silent <c>MakeGenericType</c> erasure bug that PR #1956 fixed in
/// <c>Binder.SubstituteType</c> for issue #1926.
/// </summary>
/// <remarks>
/// Root cause: when a user-defined generic interface exposes a member type
/// that is a constructed generic CLR interface over the interface's OWN type
/// parameter (issue #974 shape, e.g. <c>func Iter() IEnumerator[T]</c> on
/// <c>interface ISeq[T]</c>), constructing a closed instance (<c>ISeq[int32]</c>)
/// substitutes <c>T</c> with <c>int32</c> in that member's return type by
/// calling <c>IEnumerator&lt;&gt;.MakeGenericType(typeof(int))</c>. Under a
/// <see cref="System.Reflection.MetadataLoadContext"/> reference set (as
/// cs2gs / the MSBuild task compile mode use), <c>IEnumerator&lt;&gt;</c> is
/// resolved through the MLC while <c>int32</c>'s <see cref="TypeSymbol.ClrType"/>
/// is always the host process's live <c>typeof(int)</c>; mixing them in
/// <c>MakeGenericType</c> throws <see cref="ArgumentException"/>, which was
/// silently swallowed, leaking the definition's unsubstituted
/// <c>IEnumerator[T]</c> into the constructed <c>ISeq[int32]</c> shape. The fix
/// projects each substituted CLR type argument into the interface's
/// constructing <c>mapClrType</c> reflection context before calling
/// <c>MakeGenericType</c>, mirroring <c>Binder.SubstituteType</c>.
/// </remarks>
public class Issue1958InterfaceMemberGenericSubstitutionTests
{
    /// <summary>
    /// Build a <see cref="ReferenceResolver"/> rooted at the BCL reference
    /// assemblies, forcing gsc into the <see cref="System.Reflection.MetadataLoadContext"/>
    /// resolution path — the same path cs2gs and the MSBuild task drive gsc
    /// through — reproducing the cross-reflection-context scenario inside the
    /// unit-test process.
    /// </summary>
    private static ReferenceResolver MetadataLoadContextResolver()
    {
        var paths = new[]
        {
            typeof(object).Assembly.Location,
            typeof(System.Collections.Generic.List<>).Assembly.Location,
            typeof(System.Console).Assembly.Location,
            typeof(System.Linq.Enumerable).Assembly.Location,
        }
        .Where(p => !string.IsNullOrEmpty(p))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

        return ReferenceResolver.WithReferences(paths);
    }

    private static BoundGlobalScope BindWithMlc(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree), MetadataLoadContextResolver());
    }

    private static BoundGlobalScope BindDefault(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }

    [Fact]
    public void GenericUserInterface_MemberOverOwnTypeParameter_SubstitutesUnderMetadataLoadContext()
    {
        // #974 shape: ISeq[T]'s `Iter()` member exposes the constructed CLR
        // generic `IEnumerator[T]` over the interface's own type parameter.
        // Constructing `ISeq[int32]` (via the `use` parameter below) must
        // substitute T -> int32 in that member so `use`'s declared
        // `IEnumerator[int32]` return type matches `s.Iter()`'s actual
        // (substituted) return type. Before the fix, MakeGenericType threw
        // under MLC and silently fell back to the erased `IEnumerator[T]`,
        // which does not convert to `IEnumerator[int32]` and failed binding.
        var source = """
            package P
            import System.Collections.Generic

            interface ISeq[T any] {
                func Iter() IEnumerator[T]
            }

            func use(s ISeq[int32]) IEnumerator[int32] {
                return s.Iter()
            }
            """;

        var globalScope = BindWithMlc(source);
        Assert.Empty(globalScope.Diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void GenericUserInterface_MemberOverOwnTypeParameter_ControlCase_DefaultResolver()
    {
        // Control case: the same shape must already bind (and keep binding)
        // under the default (non-MLC) reflection context, so the fix does not
        // regress the common single-context compile path.
        var source = """
            package P
            import System.Collections.Generic

            interface ISeq[T any] {
                func Iter() IEnumerator[T]
            }

            func use(s ISeq[int32]) IEnumerator[int32] {
                return s.Iter()
            }
            """;

        var globalScope = BindDefault(source);
        Assert.Empty(globalScope.Diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void InterfaceSymbol_SubstituteType_ProjectsClrArgsAcrossReflectionContexts()
    {
        // Direct symbol-layer check (issue #1958's minimum bar): constructing
        // ISeq[int32] under a mapClrType-bearing resolver must produce a
        // substituted `Iter()` return type whose ImportedTypeSymbol.TypeArguments
        // is the concrete int32 argument, NOT the still-open T type parameter
        // that a silently-swallowed ArgumentException would have leaked.
        var resolver = MetadataLoadContextResolver();
        var mapClrType = resolver.MapClrTypeToReferences;

        var enumeratorOpenDef = resolver.MapClrTypeToReferences(typeof(System.Collections.Generic.IEnumerator<>));
        var mlcObject = resolver.MapClrTypeToReferences(typeof(object));

        var tp = new TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None);
        var erasedMemberType = ImportedTypeSymbol.GetConstructed(
            enumeratorOpenDef.MakeGenericType(mlcObject),
            enumeratorOpenDef,
            ImmutableArray.Create<TypeSymbol>(tp));

        var definition = new InterfaceSymbol("ISeq", Accessibility.Public, declaration: null, packageName: "P");
        definition.SetTypeParameters(ImmutableArray.Create(tp));
        var iterMethod = new FunctionSymbol(
            "Iter",
            ImmutableArray<ParameterSymbol>.Empty,
            erasedMemberType,
            declaration: null,
            package: null,
            accessibility: Accessibility.Public);
        definition.SetMethods(ImmutableArray.Create(iterMethod));

        var constructed = InterfaceSymbol.Construct(definition, ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32), mapClrType);

        var substitutedReturn = Assert.IsType<ImportedTypeSymbol>(constructed.Methods[0].Type);
        Assert.Same(TypeSymbol.Int32, Assert.Single(substitutedReturn.TypeArguments));
    }
}
