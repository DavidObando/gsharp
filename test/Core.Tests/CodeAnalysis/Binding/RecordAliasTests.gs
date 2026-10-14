// <copyright file="RecordAliasTests.cs" company="GSharp">
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
import System.Linq
import Xunit

/// ADR-0078 / issue #718: the legacy `record` keyword and the
/// `type Name record { ... }` declaration head have been removed in
/// favor of the canonical `data class` / `data struct` forms.
/// These tests pin the migration shape and the new declaration semantics.
open class RecordAliasTests {
    @Fact
    func DataClass_ProducesClassSymbolShape() {
        let record = BuildStruct(`
data class Point {
    var X int32
    var Y int32
}
0
`)
        Assert.Equal("Point", record.Name)
        Assert.True(record.IsData)
        Assert.True(record.IsClass)
        Assert.Collection(
            record.Fields,
            (f FieldSymbol) -> Assert.Equal("X", f.Name),
            (f FieldSymbol) -> Assert.Equal("Y", f.Name)
        )
    }

    @Fact
    func DataStruct_ProducesStructSymbolShape() {
        let dataStruct = BuildStruct(`
data struct Point {
    var X int32
    var Y int32
}
0
`)
        Assert.Equal("Point", dataStruct.Name)
        Assert.True(dataStruct.IsData)
        Assert.False(dataStruct.IsClass)
    }

    @Fact
    func DataStruct_EqualValues_AreEqual() {
        let result = Evaluate(`
data struct Point {
    var X int32
    var Y int32
}
Point{X: 1, Y: 2} == Point{X: 1, Y: 2}
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func DataClass_GenericDataClass_Binds() {
        let result = Evaluate(`
data class Pair[A any, B any] {
    var First A
    var Second B
}
let p = Pair[int32, string]{First: 1, Second: "x"}
p.Second
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("x", result.Value)
    }

    @Fact
    func RecordKeyword_AsTypeKind_IsRejected() {
        // ADR-0078 removes the `record` keyword. The legacy
        // `type Name record { ... }` head is reported with GS0307 (and the
        // generic GS0306 legacy-head migration diagnostic).
        let result = Evaluate(`
type Foo record {
    var Value int32
}
0
`)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0307" || d.Id == "GS0306")
    }

    @Fact
    func RecordKeyword_AsIdentifier_StillBindsAsValueName() {
        let result = Evaluate(`
let record = 42
record
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func RecordKeyword_AsFieldName_StillBindsAsIdentifier() {
        let result = Evaluate(`
struct X {
    var record int32
}
let x = X{record: 5}
x.record
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func LegacyTypeHead_RejectedWithMigrationDiagnostic() {
        // ADR-0078: the entire `type Name <kind> ...` head is gone — the kind
        // keyword has to come first. The diagnostic should point at the new
        // grammar.
        let result = Evaluate(`
type Foo class {
    var Value int32
}
0
`)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0306")
    }

    shared {
        private func BuildStruct(source string) StructSymbol {
            // Binder-inspection helper (issue #3176 Phase 3b.2): bind via
            // EmittedOracle.CompileDiagnostics and inspect this Compilation's
            // bound state; nothing needs to run.
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
            return cast[StructSymbol](compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Point"))
        }

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
