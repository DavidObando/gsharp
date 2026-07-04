// <copyright file="Issue1988NarrowedStructFieldAssignmentBinderTests.cs" company="GSharp">
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
/// Issue #1988 (follow-up to #1917/#1982): confirms that a smart-cast-narrowed
/// struct local (ADR-0069 — an <c>object</c>-declared variable narrowed by an
/// <c>is</c> type-test) can never reach <c>EmitFieldAssignment</c>'s
/// struct-field-write path as a field-assignment TARGET. <c>BoundFieldAssignmentExpression.Receiver</c>
/// is a bare <see cref="VariableSymbol"/> with no narrowing information, and
/// <c>BindFieldAssignmentExpression</c> dispatches to the struct branch using
/// the receiver's raw declared type, not any narrowed type — so a narrowed
/// `object` local is rejected as "member not found" (GS0158) before emission
/// ever sees it. This proves the <c>TryLoadVariableAddress</c> call sites in
/// <c>EmitFieldAssignment</c> (unmigrated to <c>TryLoadStructVariableAddress</c>
/// per the #1988 audit) are unreachable for narrowed receivers and therefore
/// safe as-is.
/// </summary>
public class Issue1988NarrowedStructFieldAssignmentBinderTests
{
    [Fact]
    public void NarrowedStructLocal_FieldAssignmentTarget_ReportsGS0158()
    {
        var source = @"
struct Money {
    var Cents int32
}

var a = Money{ Cents: 100 }
var oa object = a
if oa is Money {
    oa.Cents = 200
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0158");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
