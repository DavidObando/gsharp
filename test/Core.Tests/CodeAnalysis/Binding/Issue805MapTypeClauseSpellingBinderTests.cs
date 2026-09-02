// <copyright file="Issue805MapTypeClauseSpellingBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #805 / ADR-0104 — both the canonical <c>map[K,V]</c> spelling
/// and the parser-recovered legacy <c>map[K]V</c> shape must bind to
/// the same cached <see cref="MapTypeSymbol"/> instance, and the
/// symbol's display <c>Name</c> must render with the new comma form.
/// </summary>
public class Issue805MapTypeClauseSpellingBinderTests
{
    [Fact]
    public void CanonicalSpelling_BindsAsMapTypeSymbol_WithExpectedName()
    {
        var (diagnostics, compilation) = Compile("""
            var m map[string,int32] = map[string,int32]{"a": 1}
            """);

        Assert.Empty(diagnostics);

        var variable = LookupGlobalVariable(compilation, "m");
        Assert.NotNull(variable);
        var mapType = Assert.IsType<MapTypeSymbol>(variable.Type);
        Assert.Equal("map[string,int32]", mapType.Name);
        Assert.Equal(TypeSymbol.String, mapType.KeyType);
        Assert.Equal(TypeSymbol.Int32, mapType.ValueType);
    }

    [Fact]
    public void LegacyAndCanonical_ResolveToSameMapTypeSymbolInstance()
    {
        // The legacy shape still parses (with GS0366) and binds to the
        // exact same cached MapTypeSymbol instance — the comma is purely
        // a surface-syntax change.
        var (legacyDiagnostics, legacy) = Compile("""
            var m map[string]int32 = map[string,int32]{"a": 1}
            """);

        // GS0366 fires once per legacy occurrence; no cascade.
        Assert.Contains(legacyDiagnostics, d => d.Id == "GS0366");
        Assert.All(
            legacyDiagnostics,
            d => Assert.Equal("GS0366", d.Id));

        var (canonicalDiagnostics, canonical) = Compile("""
            var m map[string,int32] = map[string,int32]{"a": 1}
            """);
        Assert.Empty(canonicalDiagnostics);

        var legacyVar = LookupGlobalVariable(legacy, "m");
        var canonicalVar = LookupGlobalVariable(canonical, "m");
        Assert.NotNull(legacyVar);
        Assert.NotNull(canonicalVar);

        // MapTypeSymbol is cached per (K, V) pair across compilations, so
        // reference equality holds across the two compilation units.
        Assert.Same(legacyVar.Type, canonicalVar.Type);
        Assert.Equal("map[string,int32]", legacyVar.Type.Name);
    }

    [Fact]
    public void CanonicalSpelling_NullableMap_BindsAsNullableMapTypeSymbol()
    {
        var (diagnostics, compilation) = Compile("""
            var m map[string,int32]? = nil
            """);

        Assert.Empty(diagnostics);

        var variable = LookupGlobalVariable(compilation, "m");
        Assert.NotNull(variable);
        var nullable = Assert.IsType<NullableTypeSymbol>(variable.Type);
        var mapType = Assert.IsType<MapTypeSymbol>(nullable.UnderlyingType);
        Assert.Equal("map[string,int32]", mapType.Name);
    }

    [Fact]
    public void CanonicalSpelling_NestedInsideSequence_BindsAsSequenceOfMap()
    {
        // Use a function-parameter slot so we exercise the type clause
        // without having to invent a constructible expression of type
        // `sequence[map[K,V]]`.
        var (diagnostics, compilation) = Compile("""
            func receive(s sequence[map[string,int32]]) int32 {
                return 0
            }
            """);

        Assert.Empty(diagnostics);

        var function = compilation.GlobalScope.Functions.FirstOrDefault(f => f.Name == "receive");
        Assert.NotNull(function);
        var paramType = function.Parameters[0].Type;
        var seq = Assert.IsType<SequenceTypeSymbol>(paramType);
        var mapType = Assert.IsType<MapTypeSymbol>(seq.ElementType);
        Assert.Equal("map[string,int32]", mapType.Name);
    }

    private static VariableSymbol LookupGlobalVariable(Compilation compilation, string name)
        => compilation.GlobalScope.Variables.FirstOrDefault(v => v.Name == name);

    // Binder-inspection helper (issue #3176 Phase 3b.2): bind via
    // EmittedOracle.CompileDiagnostics and inspect this Compilation's bound
    // state; nothing needs to run.
    private static (System.Collections.Immutable.ImmutableArray<Diagnostic> Diagnostics, Compilation Compilation) Compile(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        var diagnostics = EmittedOracle.CompileDiagnostics(compilation);
        return (diagnostics, compilation);
    }
}
