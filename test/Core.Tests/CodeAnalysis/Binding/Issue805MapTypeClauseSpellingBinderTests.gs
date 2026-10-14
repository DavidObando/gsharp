// <copyright file="Issue805MapTypeClauseSpellingBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #805 / ADR-0104 — both the canonical `map[K,V]` spelling
/// and the parser-recovered legacy `map[K]V` shape must bind to
/// the same cached (cref:MapTypeSymbol) instance, and the
/// symbol's display `Name` must render with the new comma form.
open class Issue805MapTypeClauseSpellingBinderTests {
    @Fact
    func CanonicalSpelling_BindsAsMapTypeSymbol_WithExpectedName() {
        let (diagnostics, compilation) = Compile("var m map[string,int32] = map[string,int32]{\"a\": 1}")
        Assert.Empty(diagnostics)
        let variable VariableSymbol? = LookupGlobalVariable(compilation, "m")
        Assert.NotNull(variable)
        let mapType = Assert.IsType[MapTypeSymbol](variable!!.Type)
        Assert.Equal("map[string,int32]", mapType.Name)
        Assert.Equal(TypeSymbol.String, mapType.KeyType)
        Assert.Equal(TypeSymbol.Int32, mapType.ValueType)
    }

    @Fact
    func LegacyAndCanonical_ResolveToSameMapTypeSymbolInstance() {
        // The legacy shape still parses (with GS0366) and binds to the
        // exact same cached MapTypeSymbol instance — the comma is purely
        // a surface-syntax change.
        let (legacyDiagnostics, legacy) = Compile("var m map[string]int32 = map[string,int32]{\"a\": 1}")
        // GS0366 fires once per legacy occurrence; no cascade.
        Assert.Contains(legacyDiagnostics, (d Diagnostic) -> d.Id == "GS0366")
        Assert.All(legacyDiagnostics, (d Diagnostic) -> Assert.Equal("GS0366", d.Id))
        let (canonicalDiagnostics, canonical) = Compile("var m map[string,int32] = map[string,int32]{\"a\": 1}")
        Assert.Empty(canonicalDiagnostics)
        let legacyVar VariableSymbol? = LookupGlobalVariable(legacy, "m")
        let canonicalVar VariableSymbol? = LookupGlobalVariable(canonical, "m")
        Assert.NotNull(legacyVar)
        Assert.NotNull(canonicalVar)
        // MapTypeSymbol is cached per (K, V) pair across compilations, so
        // reference equality holds across the two compilation units.
        Assert.Same(legacyVar!!.Type, canonicalVar!!.Type)
        Assert.Equal("map[string,int32]", legacyVar!!.Type.Name)
    }

    @Fact
    func CanonicalSpelling_NullableMap_BindsAsNullableMapTypeSymbol() {
        let (diagnostics, compilation) = Compile("var m map[string,int32]? = nil")
        Assert.Empty(diagnostics)
        let variable VariableSymbol? = LookupGlobalVariable(compilation, "m")
        Assert.NotNull(variable)
        let nullable = Assert.IsType[NullableTypeSymbol](variable!!.Type)
        let mapType = Assert.IsType[MapTypeSymbol](nullable.UnderlyingType)
        Assert.Equal("map[string,int32]", mapType.Name)
    }

    @Fact
    func CanonicalSpelling_NestedInsideSequence_BindsAsSequenceOfMap() {
        // Use a function-parameter slot so we exercise the type clause
        // without having to invent a constructible expression of type
        // `sequence[map[K,V]]`.
        let (diagnostics, compilation) = Compile(`func receive(s sequence[map[string,int32]]) int32 {
    return 0
}`)
        Assert.Empty(diagnostics)
        let function FunctionSymbol? = compilation
            .GlobalScope
            .Functions
            .FirstOrDefault((f FunctionSymbol) -> f.Name == "receive")
        Assert.NotNull(function)
        let paramType = function!!.Parameters[0].Type
        let seq = Assert.IsType[SequenceTypeSymbol](paramType)
        let mapType = Assert.IsType[MapTypeSymbol](seq.ElementType)
        Assert.Equal("map[string,int32]", mapType.Name)
    }

    shared {
        private func LookupGlobalVariable(compilation Compilation, name string) VariableSymbol? -> compilation
            .GlobalScope
            .Variables
            .FirstOrDefault((v VariableSymbol) -> v.Name == name)

        // Binder-inspection helper (issue #3176 Phase 3b.2): bind via
        // EmittedOracle.CompileDiagnostics and inspect this Compilation's bound
        // state; nothing needs to run.
        private func Compile(source string)(Diagnostics ImmutableArray[Diagnostic], Compilation Compilation) {
            let syntaxTree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(syntaxTree)
            let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
            return (diagnostics, compilation)
        }
    }
}
