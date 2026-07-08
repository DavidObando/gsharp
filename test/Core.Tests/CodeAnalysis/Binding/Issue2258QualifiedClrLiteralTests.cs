// <copyright file="Issue2258QualifiedClrLiteralTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2258: cs2gs fully-qualifies every CLR (referenced-assembly) type
/// reference, the same way it qualifies source types (#2256/#2257). gsc
/// already peels a qualified prefix off a CLR *constructor* call
/// (<c>TryBindQualifiedClrConstructorCall</c>) and, as of the #2256/#2257
/// follow-up, off CLR *enum-member* and *static-member* access
/// (<c>TryBindFullyQualifiedClrStaticAccess</c>). The remaining gap was the
/// CLR *struct/class object-initializer literal* position
/// (<c>Type{ Member: value }</c>): a fully-qualified reference to such a
/// literal failed GS0157, and — for an imported VALUE-TYPE struct — even a
/// simple name with an explicit import failed, because
/// <c>BindStructLiteralExpression</c> only knew how to construct an imported
/// reference type (via its public parameterless constructor); it had no path
/// for a plain imported value type, which virtually never has one.
/// <para>
/// These tests pin: (1) a fully-qualified CLR struct literal with a deep,
/// non-<c>System</c> namespace prefix and no explicit import at all binds and
/// evaluates correctly; (2) an imported CLR value-type literal referenced by
/// its simple name (via an explicit import) binds and evaluates; and, for
/// completeness alongside the sibling positions, (3) a fully-qualified CLR
/// enum-member access and (4) a fully-qualified CLR static-member access, both
/// under a multi-segment, non-<c>System</c>-only namespace, still bind
/// without diagnostics.
/// </para>
/// </summary>
public class Issue2258QualifiedClrLiteralTests
{
    [Fact]
    public void QualifiedClrStructLiteral_NoImport_BindsAndEvaluates()
    {
        // The exact shape reported in issue #2258:
        // `System.Text.Json.JsonWriterOptions{ Indented: true }`. No import at
        // all is declared, so the literal must resolve purely from the
        // fully-qualified dotted name. Force-load the assembly so the
        // default host-assembly reference set (issue #2256 test convention)
        // includes it.
        _ = typeof(System.Text.Json.JsonWriterOptions).Assembly;

        var source = @"
let opts = System.Text.Json.JsonWriterOptions{Indented: true}
opts.Indented
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void QualifiedClrStructLiteral_DeepNamespace_ValueType_BindsAndEvaluates()
    {
        // A qualified CLR VALUE-TYPE literal (no explicit parameterless
        // constructor on System.Numerics.Vector2 — the instance must be seeded
        // with its default/zero value) whose members are public mutable
        // fields (not properties), exercising the field-assignment path of the
        // shared object-initializer lowering.
        var source = @"
let v = System.Numerics.Vector2{X: 1.5f, Y: 2.5f}
v.X
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1.5f, result.Value);
    }

    [Fact]
    public void ImportedClrValueTypeLiteral_SimpleName_BindsAndEvaluates()
    {
        // Root-cause regression: prior to the fix, a plain imported CLR VALUE
        // TYPE failed the composite-literal even by simple name with an
        // explicit import, because only imported reference types (and gsc's
        // own cross-assembly "semantic aggregate" structs) were supported.
        var source = @"
import System.Numerics

let v = Vector2{X: 3.5f, Y: 4.5f}
v.Y
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(4.5f, result.Value);
    }

    [Fact]
    public void QualifiedClrEnumMember_DeepNamespace_Binds()
    {
        // A multi-segment (non-`System`-only) namespace enum-member access:
        // `System.Text.Json.JsonCommentHandling.Skip`. Proves the walk
        // correctly peels every intermediate namespace segment, not just the
        // implicitly-imported root.
        _ = typeof(System.Text.Json.JsonCommentHandling).Assembly;

        var source = @"
import System.Text.Json

let c = System.Text.Json.JsonCommentHandling.Skip
c
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void QualifiedClrStaticMember_DeepNamespace_Binds()
    {
        // A multi-segment (non-`System`-only) namespace static-property
        // access: `System.Text.Json.JsonSerializerOptions.Default`.
        _ = typeof(System.Text.Json.JsonSerializerOptions).Assembly;

        var source = @"
import System.Text.Json

let o = System.Text.Json.JsonSerializerOptions.Default
o
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
