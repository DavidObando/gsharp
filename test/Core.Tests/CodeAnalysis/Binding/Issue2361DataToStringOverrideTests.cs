// <copyright file="Issue2361DataToStringOverrideTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2361 / ADR-0029 follow-up: a data class/struct's hand-written
/// <c>ToString</c> is the one synthesized member (of the six ADR-0029 names)
/// that may be declared explicitly, PROVIDED its shape exactly matches
/// <c>public ToString() string</c> (no parameters, not static, not generic,
/// not async, not unsafe, returning <c>string</c>). A compatible declaration
/// suppresses/replaces the synthesized ToString instead of being rejected
/// with GS0232; an incompatible one is rejected with the more specific
/// GS0487. The other five synthesized names (Equals/GetHashCode/
/// op_Equality/op_Inequality/Deconstruct) remain unconditionally forbidden —
/// see <see cref="DataStructTests"/> for that pre-existing coverage, which
/// this file does not duplicate.
/// </summary>
public class Issue2361DataToStringOverrideTests
{
    [Fact]
    public void DataClass_CompatibleToStringOverride_InBody_NoDiagnostics()
    {
        var source = @"
open data class Point(X int32, Y int32) {
    func ToString() string {
        return ""custom""
    }
}
0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void DataClass_CompatibleToStringOverride_ExpressionBody_NoDiagnostics()
    {
        var source = @"
open data class Point(X int32, Y int32) {
    func ToString() string -> ""custom""
}
0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void DataStruct_CompatibleToStringOverride_InBody_NoDiagnostics()
    {
        var source = @"
data struct Point {
    var X int32
    var Y int32

    func ToString() string {
        return ""custom""
    }
}
0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void DataClass_CompatibleToStringOverride_ReceiverClause_NoBlockingDiagnostics()
    {
        // ADR-0079 (GS0314) warns when a receiver-clause method targets a
        // same-package ("owned") type — the canonical form is the in-body
        // declaration — but it is only a Warning, not a blocking error, so
        // the receiver-clause code path (DeclarationBinder's
        // `methodReceiverStruct != null` branch) is still reachable and must
        // still apply the #2361 ToString exception (not GS0232/GS0487).
        var source = @"
open data class Point(X int32, Y int32) {
}

func (p Point) ToString() string {
    return ""custom""
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0232" || d.Id == "GS0487");
    }

    [Fact]
    public void DataStruct_CompatibleToStringOverride_ReceiverClause_NoBlockingDiagnostics()
    {
        var source = @"
data struct Point {
    var X int32
    var Y int32
}

func (p Point) ToString() string {
    return ""custom""
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0232" || d.Id == "GS0487");
    }

    [Fact]
    public void DataStruct_ToStringWithParameter_ReceiverClause_ReportsGS0487()
    {
        var source = @"
data struct Point {
    var X int32
    var Y int32
}

func (p Point) ToString(format string) string {
    return format
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0487");
    }

    [Fact]
    public void DataClass_SealedNonOpen_CompatibleToStringOverride_NoDiagnostics()
    {
        // Not `open` — the sealed/final-slot policy must still let a
        // compatible ToString through.
        var source = @"
data class Point(X int32, Y int32) {
    func ToString() string -> ""custom""
}
0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void DataClass_DerivedOverridesToStringAgain_NoDiagnostics()
    {
        var source = @"
open data class Base2361(Name string) {
    func ToString() string -> ""base:"" + Name
}
open data class Derived2361(Name string, Extra string) : Base2361(Name) {
    func ToString() string -> base.ToString() + "":"" + Extra
}
0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void DataClass_ToStringWithParameter_ReportsGS0487()
    {
        var source = @"
open data class Point(X int32, Y int32) {
    func ToString(format string) string {
        return format
    }
}
0
";
        var result = Evaluate(source);
        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0487");
        Assert.Contains("Point", diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void DataClass_ToStringWrongReturnType_ReportsGS0487()
    {
        var source = @"
open data class Point(X int32, Y int32) {
    func ToString() int32 {
        return 0
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0487");
    }

    [Fact]
    public void DataClass_AsyncToString_ReportsGS0487()
    {
        var source = @"
open data class Point(X int32, Y int32) {
    async func ToString() string {
        return ""x""
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0487");
    }

    [Fact]
    public void DataClass_GenericToString_ReportsGS0487()
    {
        var source = @"
open data class Point(X int32, Y int32) {
    func ToString[T]() string {
        return ""x""
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0487");
    }

    [Fact]
    public void DataClass_PrivateToString_ReportsGS0487()
    {
        var source = @"
open data class Point(X int32, Y int32) {
    private func ToString() string {
        return ""x""
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0487");
    }

    [Fact]
    public void DataClass_ExplicitToString_SharedBlock_StillReportsGS0232()
    {
        // A shared/static-block method named ToString can never be an
        // Object.ToString override — the ToString exception only applies to
        // instance methods. Statics stay unconditionally forbidden for ALL
        // six synthesized names.
        var source = @"
open data class Point(X int32, Y int32) {
    shared {
        func ToString() string {
            return ""x""
        }
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0232");
    }

    [Fact]
    public void DataClass_ExplicitEqualsObject_StillReportsGS0232_RegressionControl()
    {
        // Regression control: the ToString exception must not widen to the
        // other five synthesized names.
        var source = @"
open data class Point(X int32, Y int32) {
    func Equals(other any) bool {
        return false
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0232");
    }

    [Fact]
    public void DataStruct_ExplicitOpEquality_StillReportsGS0232_RegressionControl()
    {
        var source = @"
data struct Point {
    var X int32
    var Y int32
}

func (a Point) operator ==(b Point) bool {
    return true
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0232");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
