// <copyright file="NullableFlowAnalysisTests.cs" company="GSharp">
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
/// Phase 6.6 — nullable flow-analysis hardening for pattern arms and imported
/// CLR <c>[NotNullWhen]</c> contracts.
/// </summary>
public class NullableFlowAnalysisTests
{
    [Fact]
    public void SwitchStatement_TypePattern_NarrowsDiscriminantInArmBody()
    {
        var result = Evaluate(@"
let s string? = ""hello""
switch s {
case x is string { var len = s.Length }
default { }
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void SwitchStatement_NonNilConstantPattern_NarrowsNullableValueInArmBody()
    {
        var result = Evaluate(@"
let n int? = 42
var y int = 0
switch n {
case 42 { y = n }
default { }
}
y
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void If_NegatedIsNullOrEmpty_NarrowsThenArm()
    {
        var result = Evaluate(@"
let s string? = ""world""
if !String.IsNullOrEmpty(s) {
    var len = s.Length
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_IsNullOrWhiteSpace_NarrowsElseArm()
    {
        var result = Evaluate(@"
let s string? = ""world""
if String.IsNullOrWhiteSpace(s) {
} else {
    var len = s.Length
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void SwitchStatement_DiscardAndDefaultArms_DoNotNarrow()
    {
        var discard = Evaluate(@"
let s string? = ""world""
switch s {
case _ { var len = s.Length }
}
");
        var defaultArm = Evaluate(@"
let s string? = ""world""
switch s {
default { var len = s.Length }
}
");

        Assert.Contains(discard.Diagnostics, d => d.Message.Contains("Cannot find member Length.", System.StringComparison.Ordinal));
        Assert.Contains(defaultArm.Diagnostics, d => d.Message.Contains("Cannot find member Length.", System.StringComparison.Ordinal));
    }

    [Fact]
    public void SwitchExpression_TypePattern_NarrowsDiscriminantInArmResult()
    {
        var result = Evaluate(@"
let s string? = ""hello""
let len = switch s { case x is string -> s.Length default -> 0 }
len
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void If_UserDefinedNotNullWhenTrue_NarrowsThenArm()
    {
        var result = Evaluate(@"
import System.Diagnostics.CodeAnalysis

func TryFetch(@NotNullWhen(true) s string?) bool {
    return s != nil
}

let v string? = ""hello""
if TryFetch(v) {
    var len = v.Length
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_NegatedUserDefinedNotNullWhenTrue_NarrowsElseArm()
    {
        var result = Evaluate(@"
import System.Diagnostics.CodeAnalysis

func TryFetch(@NotNullWhen(true) s string?) bool {
    return s != nil
}

let v string? = ""hello""
if !TryFetch(v) {
} else {
    var len = v.Length
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_UserDefinedNotNullWhenFalse_NarrowsElseArm()
    {
        var result = Evaluate(@"
import System.Diagnostics.CodeAnalysis

func IsMissing(@NotNullWhen(false) s string?) bool {
    return s == nil
}

let v string? = ""hello""
if IsMissing(v) {
} else {
    var len = v.Length
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_UserDefinedMaybeNullWhen_DoesNotNarrow()
    {
        // [MaybeNullWhen(false)] on a nullable string? arg cannot prove non-nullness
        // in the then-arm, so accessing .Length must still error there.
        var result = Evaluate(@"
import System.Diagnostics.CodeAnalysis

func Probe(@MaybeNullWhen(false) s string?) bool {
    return s != nil
}

let v string? = ""hello""
if Probe(v) {
    var len = v.Length
}
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Cannot find member Length.", System.StringComparison.Ordinal));
    }

    [Fact]
    public void If_UserDefinedMaybeNullWhenFalse_OnNonNullArg_WidensElseArm()
    {
        // [MaybeNullWhen(false)] on a non-nullable string arg must widen the
        // caller's variable to string? in the else arm (where the call returned false).
        var result = Evaluate(@"
import System.Diagnostics.CodeAnalysis

func TryGet(@MaybeNullWhen(false) s string) bool {
    return s.Length > 0
}

let v = ""hello""
if TryGet(v) {
} else {
    var len = v.Length
}
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Cannot find member Length.", System.StringComparison.Ordinal));
    }

    [Fact]
    public void If_UserDefinedMaybeNullWhenFalse_OnNonNullArg_DoesNotWidenThenArm()
    {
        // [MaybeNullWhen(false)] fires on false, so the then-arm (true return)
        // must leave the variable as non-nullable — .Length access must succeed.
        var result = Evaluate(@"
import System.Diagnostics.CodeAnalysis

func TryGet(@MaybeNullWhen(false) s string) bool {
    return s.Length > 0
}

let v = ""hello""
if TryGet(v) {
    var len = v.Length
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_UserDefinedMaybeNullWhenTrue_OnNonNullArg_WidensThenArm()
    {
        // [MaybeNullWhen(true)] fires on true, so the then-arm must see the
        // variable widened to string? — .Length access must fail.
        var result = Evaluate(@"
import System.Diagnostics.CodeAnalysis

func IsEmpty(@MaybeNullWhen(true) s string) bool {
    return false
}

let v = ""hello""
if IsEmpty(v) {
    var len = v.Length
}
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Cannot find member Length.", System.StringComparison.Ordinal));
    }

    [Fact]
    public void If_NegatedUserDefinedMaybeNullWhenFalse_OnNonNullArg_WidensThenArm()
    {
        // Negating the call flips the arm: !TryGet(v) is true exactly when
        // TryGet returned false, so the then-arm now sees the [MaybeNullWhen(false)]
        // widening and .Length must fail.
        var result = Evaluate(@"
import System.Diagnostics.CodeAnalysis

func TryGet(@MaybeNullWhen(false) s string) bool {
    return s.Length > 0
}

let v = ""hello""
if !TryGet(v) {
    var len = v.Length
}
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Cannot find member Length.", System.StringComparison.Ordinal));
    }

    // Issue #229 — BoundImportedInstanceCallExpression narrowing

    [Fact]
    public void If_DictionaryTryGetValue_SuccessArm_OutParamConfirmedNonNullable()
    {
        // dict.TryGetValue carries [NotNullWhen(true)] on the out parameter.
        // In the then-arm (true return), `value` must be narrowed to non-nullable
        // and .Length access must succeed.
        var result = Evaluate(@"
import System.Collections.Generic

var dict = Dictionary[string, string]()
dict[""key""] = ""hello""
var value = """"
if dict.TryGetValue(""key"", &value) {
    var len = value.Length
}
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void If_DictionaryTryGetValue_FailureArm_OutParamWidenedToNullable()
    {
        // dict.TryGetValue carries [MaybeNullWhen(false)] on the out parameter.
        // In the else-arm (false return), `value` must be widened to string?
        // and .Length access must be rejected.
        var result = Evaluate(@"
import System.Collections.Generic

var dict = Dictionary[string, string]()
var value = """"
if dict.TryGetValue(""key"", &value) {
} else {
    var len = value.Length
}
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Cannot find member Length.", System.StringComparison.Ordinal));
    }

    [Fact]
    public void If_NegatedDictionaryTryGetValue_SuccessArm_OutParamNotWidened()
    {
        // !dict.TryGetValue(...) is true when the call returned false, so the
        // then-arm is the failure arm: value must be widened to string? and
        // .Length access must be rejected.
        var result = Evaluate(@"
import System.Collections.Generic

var dict = Dictionary[string, string]()
var value = """"
if !dict.TryGetValue(""key"", &value) {
    var len = value.Length
}
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Cannot find member Length.", System.StringComparison.Ordinal));
    }

    [Fact]
    public void If_NegatedDictionaryTryGetValue_ElseArm_OutParamIsNonNullable()
    {
        // !dict.TryGetValue(...) else-arm is the success arm: value must be
        // narrowed to non-nullable and .Length access must succeed.
        var result = Evaluate(@"
import System.Collections.Generic

var dict = Dictionary[string, string]()
dict[""key""] = ""hello""
var value = """"
if !dict.TryGetValue(""key"", &value) {
} else {
    var len = value.Length
}
");

        Assert.Empty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
