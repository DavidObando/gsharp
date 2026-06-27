// <copyright file="Issue1240ParameterShadowsFieldTests.cs" company="GSharp">
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
/// Issue #1240: a method/constructor parameter whose name collides with an
/// instance field (or property) must shadow that member for unqualified (bare)
/// references inside the body — matching C# semantics and the
/// <c>parameter &gt; instance member &gt; static member</c> precedence already
/// enforced for static members. The member remains reachable via <c>this.</c>.
///
/// Before the fix, the field's pseudo-variable was seeded into the method scope
/// first and <c>TryDeclareVariable</c> silently dropped the later parameter, so
/// the parameter was wrongly ignored — a latent correctness bug that also
/// surfaced as a spurious GS0129 when field and parameter types differed (e.g.
/// non-nullable field vs nullable parameter).
/// </summary>
public class Issue1240ParameterShadowsFieldTests
{
    [Fact]
    public void Constructor_NullableParam_ShadowsNonNullableField_NoDiagnostics()
    {
        // Faithful repro from the issue: the field is non-nullable []uint8 while
        // the parameter is nullable []uint8?. Bare `iv` must bind to the
        // PARAMETER, so `iv == nil` typechecks; binding to the field would emit
        // GS0129 ('==' not defined for '[]uint8' and 'nil').
        var source = @"
package p
class C {
    private let iv []uint8
    init(iv []uint8?) {
        if iv == nil { throw System.ArgumentException(""x"") }
        this.iv = iv!!
    }
    func M(iv []uint8?) bool {
        return iv == nil
    }
}
";
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void Method_Param_ShadowsField_ParameterValueUsed()
    {
        // Same-type field and parameter so the body compiles either way; the
        // returned value proves the PARAMETER (7), not the field (100), is read.
        var source = @"
class C {
    var iv int32
    init() {
        iv = 100
    }
    func M(iv int32) int32 {
        return iv
    }
}

var c = C()
var r = c.M(7)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void Method_QualifiedThisField_StillResolvesToField()
    {
        // `this.iv` is unaffected by parameter shadowing: it reads the field
        // (100) while bare `iv` reads the parameter (7) → 107.
        var source = @"
class C {
    var iv int32
    init() {
        iv = 100
    }
    func M(iv int32) int32 {
        return this.iv + iv
    }
}

var c = C()
var r = c.M(7)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(107, result.Value);
    }

    [Fact]
    public void Constructor_Param_ShadowsField_AssignsFieldFromParameter()
    {
        // `this.iv = iv` writes the field from the parameter; a later read of
        // `this.iv` returns the stored field value (the parameter that was
        // passed in), proving the bare `iv` on the right-hand side was the
        // PARAMETER, not the (default-zero) field.
        var source = @"
class C {
    var iv int32
    init(iv int32) {
        this.iv = iv
    }
    func Get() int32 {
        return this.iv
    }
}

var c = C(5)
var r = c.Get()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void Method_Param_ShadowsProperty_ParameterValueUsed()
    {
        // Parameters must shadow instance properties too (not just fields).
        var source = @"
class C {
    var _v int32
    prop Value int32 {
        get { return _v }
        set(x) { _v = x }
    }
    init() {
        _v = 100
    }
    func M(Value int32) int32 {
        return Value
    }
}

var c = C()
var r = c.M(42)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    private static System.Collections.Immutable.ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>()).Diagnostics;
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
