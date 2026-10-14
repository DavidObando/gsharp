// <copyright file="Issue2258QualifiedClrLiteralTests.cs" company="GSharp">
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
import System.Text.Json
import Xunit

/// Issue #2258: cs2gs fully-qualifies every CLR (referenced-assembly) type
/// reference, the same way it qualifies source types (#2256/#2257). gsc
/// already peels a qualified prefix off a CLR *constructor* call
/// (`TryBindQualifiedClrConstructorCall`) and, as of the #2256/#2257
/// follow-up, off CLR *enum-member* and *static-member* access
/// (`TryBindFullyQualifiedClrStaticAccess`). The remaining gap was the
/// CLR *struct/class object-initializer literal* position
/// (`Type{ Member: value }`): a fully-qualified reference to such a
/// literal failed GS0157, and — for an imported VALUE-TYPE struct — even a
/// simple name with an explicit import failed, because
/// `BindStructLiteralExpression` only knew how to construct an imported
/// reference type (via its public parameterless constructor); it had no path
/// for a plain imported value type, which virtually never has one.
///
/// These tests pin: (1) a fully-qualified CLR struct literal with a deep,
/// non-`System` namespace prefix and no explicit import at all binds and
/// evaluates correctly; (2) an imported CLR value-type literal referenced by
/// its simple name (via an explicit import) binds and evaluates; and, for
/// completeness alongside the sibling positions, (3) a fully-qualified CLR
/// enum-member access and (4) a fully-qualified CLR static-member access, both
/// under a multi-segment, non-`System`-only namespace, still bind
/// without diagnostics.
open class Issue2258QualifiedClrLiteralTests {
    @Fact
    func QualifiedClrStructLiteral_NoImport_BindsAndEvaluates() {
        // The exact shape reported in issue #2258:
        // `System.Text.Json.JsonWriterOptions{ Indented: true }`. No import at
        // all is declared, so the literal must resolve purely from the
        // fully-qualified dotted name. Force-load the assembly so the
        // default host-assembly reference set (issue #2256 test convention)
        // includes it.
        let _ = typeof(JsonWriterOptions).Assembly
        let source = `
let opts = System.Text.Json.JsonWriterOptions{Indented: true}
opts.Indented
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func QualifiedClrStructLiteral_DeepNamespace_ValueType_BindsAndEvaluates() {
        // A qualified CLR VALUE-TYPE literal (no explicit parameterless
        // constructor on System.Numerics.Vector2 — the instance must be seeded
        // with its default/zero value) whose members are public mutable
        // fields (not properties), exercising the field-assignment path of the
        // shared object-initializer lowering.
        let source = `
let v = System.Numerics.Vector2{X: 1.5f, Y: 2.5f}
v.X
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1.5f, result.Value)
    }

    @Fact
    func ImportedClrValueTypeLiteral_SimpleName_BindsAndEvaluates() {
        // Root-cause regression: prior to the fix, a plain imported CLR VALUE
        // TYPE failed the composite-literal even by simple name with an
        // explicit import, because only imported reference types (and gsc's
        // own cross-assembly "semantic aggregate" structs) were supported.
        let source = `
import System.Numerics

let v = Vector2{X: 3.5f, Y: 4.5f}
v.Y
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(4.5f, result.Value)
    }

    @Fact
    func QualifiedClrEnumMember_DeepNamespace_Binds() {
        // A multi-segment (non-`System`-only) namespace enum-member access:
        // `System.Text.Json.JsonCommentHandling.Skip`. Proves the walk
        // correctly peels every intermediate namespace segment, not just the
        // implicitly-imported root.
        let _ = typeof(JsonCommentHandling).Assembly
        let source = `
import System.Text.Json

let c = System.Text.Json.JsonCommentHandling.Skip
c
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func QualifiedClrStaticMember_DeepNamespace_Binds() {
        // A multi-segment (non-`System`-only) namespace static-property
        // access: `System.Text.Json.JsonSerializerOptions.Default`.
        let _ = typeof(JsonSerializerOptions).Assembly
        let source = `
import System.Text.Json

let o = System.Text.Json.JsonSerializerOptions.Default
o
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
