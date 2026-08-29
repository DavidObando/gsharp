// <copyright file="NamedTupleElementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0172 Phase A: named tuple elements. Types spell names Go-style —
/// <c>(line int32, column int32)</c> — literals label with a colon —
/// <c>(line: 1, column: 2)</c> — and access resolves the name positionally
/// while <c>ItemN</c>/<c>.N</c> stay valid. Names are metadata: same-shape
/// tuples differing only in names are identity-convertible (GS0541 warning on
/// a position-wise disagreement). Witness of discrimination: before ADR-0172
/// every named spelling below was a parse error (GS0113/GS0005 cascade) and
/// every name access was GS0158.
/// </summary>
public class NamedTupleElementTests
{
    [Fact]
    public void NamedTypeClause_AccessByName_ItemN_AndNumericSelector()
    {
        var result = EmittedOracle.Evaluate(@"
let pos (line int32, column int32) = (3, 5)
pos.line + pos.Item2 + pos.column
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(13, result.Value);
    }

    [Fact]
    public void LabeledLiteral_InfersNamedType_AccessByName()
    {
        var result = EmittedOracle.Evaluate(@"
let t = (line: 7, column: 9)
t.line * 10 + t.column
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(79, result.Value);
    }

    [Fact]
    public void PartialNaming_NamedAndUnnamedElementsCoexist()
    {
        var result = EmittedOracle.Evaluate(@"
let t (count int32, string) = (4, ""x"")
t.count
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(4, result.Value);
    }

    [Fact]
    public void NamedAndUnnamed_SameShape_AssignBothDirections()
    {
        var result = EmittedOracle.Evaluate(@"
let named (line int32, column int32) = (3, 5)
let unnamed (int32, int32) = named
let back (line int32, column int32) = unnamed
back.line + unnamed.Item2
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(8, result.Value);
    }

    [Fact]
    public void RenamedAssignment_WarnsGS0541_StillCompiles()
    {
        var result = EmittedOracle.Evaluate(@"
let pos (line int32, column int32) = (3, 5)
let renamed (row int32, col int32) = pos
renamed.row
");
        Assert.Equal(2, result.Diagnostics.Count(d => d.Id == "GS0541"));
        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void FunctionReturnType_NamedElements_AccessAtCallSite()
    {
        var result = EmittedOracle.Evaluate(@"
func divmod(a int32, b int32) (quotient int32, remainder int32) {
    return a / b, a % b
}
let r = divmod(10, 3)
r.quotient * 10 + r.remainder
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(31, result.Value);
    }

    [Fact]
    public void NestedNamedTuple_ElementNamesResolveAtEachLevel()
    {
        var result = EmittedOracle.Evaluate(@"
let t (inner (a int32, b int32), tag string) = ((a: 1, b: 2), ""x"")
t.inner.b
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void NamedVsUnnamed_TupleEquality_ComparesByShape()
    {
        // ADR-0171 coupling constraint: the equality desugar keys on shape,
        // never symbol identity — a named and an unnamed same-shape tuple
        // compare element-wise.
        var result = EmittedOracle.Evaluate(@"
let named (line int32, column int32) = (3, 5)
named == (3, 5)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void GenericSubstitution_PreservesElementNames()
    {
        var result = EmittedOracle.Evaluate(@"
func first[T](pair (val T, ok bool)) T {
    return pair.val
}
first((val: 42, ok: true))
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void CorrectPositionItemN_IsAllowed()
    {
        var result = EmittedOracle.Evaluate(@"
let t (Item1 int32, Item2 int32) = (1, 2)
t.Item1 + t.Item2
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void DeconstructionOfNamedTuple_StillPositional()
    {
        var result = EmittedOracle.Evaluate(@"
let pos (line int32, column int32) = (3, 5)
let (a, b) = pos
a * 10 + b
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(35, result.Value);
    }

    [Fact]
    public void DuplicateName_ReportsGS0540()
    {
        var diagnostic = Assert.Single(Errors(@"
let t (line int32, line int32) = (1, 2)
"), d => d.Id == "GS0540");
        Assert.Equal("line", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void DuplicateLabel_InLiteral_ReportsGS0540()
    {
        Assert.Contains(Errors(@"
let t = (line: 1, line: 2)
"), d => d.Id == "GS0540");
    }

    [Fact]
    public void WrongPositionItemN_ReportsGS0542()
    {
        Assert.Contains(Errors(@"
let t (Item2 int32, x int32) = (1, 2)
"), d => d.Id == "GS0542");
    }

    [Fact]
    public void RestName_ReportsGS0542()
    {
        Assert.Contains(Errors(@"
let t = (Rest: 1, x: 2)
"), d => d.Id == "GS0542");
    }

    [Fact]
    public void SingleLabeledElement_ReportsGS0543_RecoversAsGrouping()
    {
        var diagnostics = Errors(@"
let x = (line: 1)
let y = x + 1
");
        var diagnostic = Assert.Single(diagnostics, d => d.Id == "GS0543");
        Assert.Equal("line", diagnostic.Location.Text.ToString(diagnostic.Location.Span));

        // Recovery: `(line: 1)` binds as parenthesized `1`, so `x + 1` is valid
        // and GS0543 is the only error.
        Assert.Single(diagnostics);
    }

    [Fact]
    public void SingleNamedTypeElement_ReportsGS0543_RecoversAsGrouping()
    {
        var diagnostics = Errors(@"
let x (line int32) = 1
let y = x + 1
");
        Assert.Single(diagnostics, d => d.Id == "GS0543");
        Assert.Single(diagnostics);
    }

    [Fact]
    public void NamedTupleType_DisplayName_IsNameFirst()
    {
        var source = @"
let pos (line int32, column int32) = (1, 2)
let mismatch string = pos
";
        var diagnostic = Assert.Single(Errors(source));
        Assert.Contains("(line int32, column int32)", diagnostic.Message);
    }

    [Fact]
    public void UnnamedTupleGrammar_Unchanged()
    {
        var result = EmittedOracle.Evaluate(@"
import System.Collections.Generic
let t (int32, List[int32], []string, (int32) -> int32) = (1, List[int32](), []string{""a""}, (x int32) -> x)
t.Item1
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
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
