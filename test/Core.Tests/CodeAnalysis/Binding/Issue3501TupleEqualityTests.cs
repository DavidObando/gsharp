// <copyright file="Issue3501TupleEqualityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3501 / ADR-0171: tuple equality (<c>==</c> / <c>!=</c>) as a
/// bind-time element-wise desugar. Before the feature, both operators fell
/// through the whole binary-operator cascade to GS0129 ("Binary operator '=='
/// is not defined for types '(int32, int32)' and '(int32, int32)'") — the
/// witness of discrimination for every positive test here is that the same
/// source previously reported GS0129 and produced no value.
/// </summary>
public class Issue3501TupleEqualityTests
{
    [Fact]
    public void TupleEquality_EqualValues_IsTrue()
    {
        var result = EmittedOracle.Evaluate(@"
let a = (1, 2)
let b = (1, 2)
a == b
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void TupleEquality_DifferentValues_IsFalse()
    {
        var result = EmittedOracle.Evaluate(@"
let a = (1, 2)
let b = (1, 3)
a == b
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(false, result.Value);
    }

    [Fact]
    public void TupleInequality_DifferentValues_IsTrue()
    {
        var result = EmittedOracle.Evaluate(@"
let a = (1, 2)
let b = (1, 3)
a != b
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void TupleInequality_EqualValues_IsFalse()
    {
        var result = EmittedOracle.Evaluate(@"
let a = (1, 2)
let b = (1, 2)
a != b
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(false, result.Value);
    }

    [Fact]
    public void TupleEquality_LiteralOperands_Bind()
    {
        var result = EmittedOracle.Evaluate(@"
(1, ""x"") == (1, ""x"")
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void TupleInequality_Issue3501Shape_LiteralAgainstIndexedElement()
    {
        // The exact shape that walled the self-migration:
        // GSharpAnalyzerVerifier.cs:77 compares a fresh tuple literal against
        // an element of a tuple-typed list via `!=`.
        var parenResult = EmittedOracle.Evaluate(@"
let expected = [](int32, int32){(1, 2), (3, 4)}
let actualLine = 3
let actualColumn = 5
(actualLine, actualColumn) != expected[1]
");
        Assert.Empty(parenResult.Diagnostics);
        Assert.Equal(true, parenResult.Value);
    }

    [Fact]
    public void TupleEquality_Arity3_ComparesAllElements()
    {
        var result = EmittedOracle.Evaluate(@"
let a = (1, ""x"", true)
let b = (1, ""x"", true)
a == b
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void TupleEquality_LastElementDiffers_IsFalse()
    {
        // Discriminates against an implementation comparing only a prefix.
        var result = EmittedOracle.Evaluate(@"
let a = (1, ""x"", true)
let b = (1, ""x"", false)
a == b
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(false, result.Value);
    }

    [Fact]
    public void TupleEquality_NestedTuples_RecursesElementwise()
    {
        var result = EmittedOracle.Evaluate(@"
let a = ((1, 2), ""x"")
let b = ((1, 2), ""x"")
a == b
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void TupleEquality_NestedTupleElementDiffers_IsFalse()
    {
        var result = EmittedOracle.Evaluate(@"
let a = ((1, 2), ""x"")
let b = ((1, 9), ""x"")
a == b
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(false, result.Value);
    }

    [Fact]
    public void TupleEquality_NumericAdaptationAcrossElementTypes_Binds()
    {
        // int32 vs int64 elements — per-element numeric adaptation widens,
        // exactly as `1 == int64(1)` does outside a tuple.
        var result = EmittedOracle.Evaluate(@"
let a = (1, ""x"")
let b (int64, string) = (1, ""x"")
a == b
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void TupleEquality_UserDefinedElementOperator_IsHonored()
    {
        // Vector2 declares `==` comparing X+Y sums; (1,3) and (2,2) are
        // field-wise different but operator-equal. ValueTuple.Equals would
        // report false here — this test discriminates the desugar from the
        // rejected ValueTuple.Equals shortcut.
        var result = EmittedOracle.Evaluate(@"
struct Vector2 {
    var X int32
    var Y int32
}

func (a Vector2) operator ==(b Vector2) bool {
    return a.X + a.Y == b.X + b.Y
}

func (a Vector2) operator !=(b Vector2) bool {
    return a.X + a.Y != b.X + b.Y
}

let p = (Vector2{X: 1, Y: 3}, 7)
let q = (Vector2{X: 2, Y: 2}, 7)
p == q
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void TupleEquality_ArityMismatch_ReportsGS0539AtOperator()
    {
        var source = @"
let a = (1, 2)
let b = (1, 2, 3)
let r = a == b
";
        var diagnostic = Assert.Single(Errors(source), d => d.Id == "GS0539");
        Assert.Equal("==", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void TupleEquality_IncomparableElement_ReportsGS0129WithElementTypes()
    {
        // Element 2 pairs a bool with a string — incomparable. The report
        // must carry the ELEMENT types, not the tuple types.
        var source = @"
let a = (1, true)
let b = (1, ""x"")
let r = a == b
";
        var diagnostic = Assert.Single(Errors(source), d => d.Id == "GS0129");
        Assert.Contains("'bool'", diagnostic.Message);
        Assert.Contains("'string'", diagnostic.Message);
    }

    [Fact]
    public void TupleEquality_MultipleIncomparableElements_ReportsEach()
    {
        var source = @"
let a = (true, 1, true)
let b = (""x"", 1, ""y"")
let r = a == b
";
        Assert.Equal(2, Errors(source).Count(d => d.Id == "GS0129"));
    }

    [Fact]
    public void TupleAgainstNonTuple_StillReportsGS0129WithTupleType()
    {
        var source = @"
let a = (1, 2)
let r = a == 1
";
        var diagnostic = Assert.Single(Errors(source), d => d.Id == "GS0129");
        Assert.Contains("(int32, int32)", diagnostic.Message);
    }

    [Fact]
    public void TupleEquality_InExpressionTreeLambda_IsRejected()
    {
        // C# likewise disallows tuple `==` in expression trees (CS8382-adjacent).
        var source = @"
import System
import System.Linq.Expressions

func Predicate(a (int32, int32), b (int32, int32)) Expression[Func[bool]] {
    return () -> a == b
}
";
        Assert.Contains(Errors(source), d => d.Id == "GS0473");
    }

    private static IReadOnlyList<Diagnostic> Errors(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        return compilation.Emit(peStream).Diagnostics
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .ToList();
    }
}
