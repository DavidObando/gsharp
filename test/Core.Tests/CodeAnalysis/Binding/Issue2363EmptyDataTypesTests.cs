// <copyright file="Issue2363EmptyDataTypesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2363 / ADR-0029 amendment: a zero-field <c>data class</c>/<c>data
/// struct</c> (needed for C# <c>record Name();</c> and empty positional
/// record structs) previously failed to bind at all — <c>GS0104</c> fired
/// unconditionally for any <c>IsData</c> declaration with zero bound fields,
/// and mis-reported the kind as "struct" even for a rejected <c>data
/// class</c>. These tests exercise the binder-level legality relaxation
/// (top-level/nested, class/struct, sealed/open, with/without an explicit
/// empty <c>()</c>) and interpreter-level structural-equality semantics for
/// the degenerate zero-field case, plus the exact Oahu
/// <c>CallbackChallenge</c>/<c>MfaChallenge</c>/<c>CvfChallenge</c>/
/// <c>ApprovalChallenge</c> shape (<c>Oahu.Cli.App/Auth/CallbackBroker.cs</c>).
/// </summary>
public class Issue2363EmptyDataTypesTests
{
    [Fact]
    public void DataStruct_ZeroFields_NoParens_BindsWithoutGs0104()
    {
        var result = Evaluate(@"
data struct Empty {
}
0
");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void DataStruct_ZeroFields_ExplicitEmptyParens_BindsWithoutGs0104()
    {
        var result = Evaluate(@"
data struct Empty() {
}
0
");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void DataClass_ZeroFields_NoParens_BindsWithoutGs0104()
    {
        var result = Evaluate(@"
data class Empty {
}
0
");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void DataClass_ZeroFields_ExplicitEmptyParens_BindsWithoutGs0104()
    {
        var result = Evaluate(@"
data class Empty() {
}
0
");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void DataClass_ZeroFields_Sealed_BindsWithoutGs0104()
    {
        var result = Evaluate(@"
open data class Base {
}
data class Derived() : Base {
}
0
");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void DataClass_ZeroFields_Open_BindsWithoutGs0104()
    {
        var result = Evaluate(@"
open data class Base {
}
open data class Derived() : Base {
}
0
");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void DataStruct_ZeroFields_TwoInstances_AreEqual()
    {
        var result = Evaluate(@"
data struct Empty {
}
var a = Empty{}
var b = Empty{}
a == b
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void DataClass_ZeroFields_TwoInstances_AreEqualByValue()
    {
        var result = Evaluate(@"
data class Empty() {
}
var a = Empty()
var b = Empty()
a == b
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void DataClass_ZeroFields_SiblingTypes_AreNotEqual()
    {
        // Sibling zero-field data classes derived from a common open base
        // are never equal to one another — matching C# record semantics
        // (Equals(Name) dispatches on the declared type of the typed
        // overload; a different sibling type never satisfies it). This is a
        // pre-existing, deliberate leaf-type-only limitation, not a
        // regression introduced by #2363's zero-field relaxation.
        var result = Evaluate(@"
open data class Base {
}
data class Mfa() : Base {
}
data class Cvf() : Base {
}
var a = Mfa()
var b Base = Cvf()
a.Equals(b)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(false, result.Value);
    }

    [Fact]
    public void DataClass_ZeroFields_Copy_ReturnsEqualInstance()
    {
        // Interpreter-level: verifies structural (value) equality of the
        // copy. True reference-distinctness for the emitted/compiled case
        // is verified in Compiler.Tests (Issue2363EmptyDataTypesEmitTests).
        var result = Evaluate(@"
data class Empty() {
}
var a = Empty()
var b = a.copy()
a == b
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void DataClass_ZeroFields_With_ReturnsEqualInstance()
    {
        // `with { }` (zero overrides — there is nothing to override on a
        // zero-field type) must still parse/bind and produce a value-equal
        // copy.
        var result = Evaluate(@"
data class Empty() {
}
var a = Empty()
var b = a with { }
a == b
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void DataStruct_ZeroFields_ToString_RendersNameWithEmptyParens()
    {
        var result = Evaluate(@"
data struct Empty {
}
var a = Empty{}
a.ToString()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Empty()", result.Value);
    }

    [Fact]
    public void DataStruct_ZeroFields_ExplicitDeconstruct_StillReportsGs0232()
    {
        // GS0104 no longer fires for the zero-field declaration itself, but
        // the "no hand-written synthesized members" rule is unaffected: a
        // user-declared Deconstruct on a zero-field data struct is still
        // rejected (GS0232), same as it would be for a nonempty one.
        var result = Evaluate(@"
data struct Empty {
    func Deconstruct() {
    }
}
0
");
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0232");
    }

    [Fact]
    public void DataClass_ZeroFields_PropertyOverride_MatchesOahuCallbackChallengeShape()
    {
        // Verbatim shape of Oahu.Cli.App/Auth/CallbackBroker.cs: an open
        // base record with only an abstract computed property (no
        // positional data of its own) plus zero-field derived sealed
        // records that each override that property. Confirms the
        // GetSynthesisFields backing-field-null-filter fix: a computed
        // override property with no backing field must not be treated as a
        // synthesis field (which previously crashed field-token
        // resolution).
        var result = Evaluate(@"
open data class CallbackChallenge {
    open prop Kind string {
        get -> ""base""
    }
}
data class MfaChallenge() : CallbackChallenge {
    override prop Kind string {
        get -> ""mfa""
    }
}
data class CvfChallenge() : CallbackChallenge {
    override prop Kind string {
        get -> ""cvf""
    }
}
data class ApprovalChallenge() : CallbackChallenge {
    override prop Kind string {
        get -> ""approval""
    }
}
var mfa = MfaChallenge()
var cvf = CvfChallenge()
var approval = ApprovalChallenge()
mfa.Kind + "" "" + cvf.Kind + "" "" + approval.Kind
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("mfa cvf approval", result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
