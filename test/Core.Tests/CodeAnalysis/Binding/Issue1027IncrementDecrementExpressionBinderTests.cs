// <copyright file="Issue1027IncrementDecrementExpressionBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1027 / ADR-0126: binder coverage for prefix/postfix
/// increment (<c>++</c>) and decrement (<c>--</c>) used as value-producing
/// <em>expressions</em>. Before this change the parser only recognised the
/// bare <c>identifier ++ / --</c> statement shape, so value positions
/// (<c>var j = i--</c>) and short-circuit conditions (<c>a &amp;&amp; i-- &gt; 1</c>)
/// failed to parse with GS0005.
/// </summary>
public class Issue1027IncrementDecrementExpressionBinderTests
{
    [Fact]
    public void PostfixDecrement_InInitializer_Binds_NoGS0005()
    {
        // Exact repro from the issue.
        const string source = @"
package p
func F(n int32) int32 {
  var i = n
  var j = i--
  return j
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0005");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void PostfixDecrement_InShortCircuitCondition_Binds()
    {
        const string source = @"
package p
func G(n int32) int32 {
  var i = n
  for i > 0 && i-- > 1 { }
  return i
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void PrefixIncrementAndDecrement_Bind()
    {
        const string source = @"
package p
func H(n int32) int32 {
  var i = n
  var j = --i
  var k = ++i
  return j + k
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void IncrementDecrement_OfArrayElement_Binds()
    {
        const string source = @"
package p
func F() int32 {
  var a = []int32{1, 2, 3}
  var x = a[0]++
  var y = --a[1]
  return x + y
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void IncrementDecrement_OfField_Binds()
    {
        const string source = @"
package p
struct S { var x int32 }
func F() int32 {
  var s = S{x: 5}
  var a = s.x++
  var b = --s.x
  return a + b
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void IncrementOfReadOnlyLet_ReportsSameDiagnosticAsAssignment()
    {
        const string source = @"
package p
func F() int32 {
  let i = 5
  var j = i++
  return j
}
";
        // A read-only `let` must be rejected with the same GS0127 the
        // assignment path reports for `i = i + 1`.
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Contains(diagnostics, d => d.Id == "GS0127");
    }

    [Fact]
    public void IncrementOfNonLvalue_ReportsGS0402()
    {
        const string source = @"
package p
func F() int32 {
  var j = 5++
  return j
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Contains(diagnostics, d => d.Id == "GS0402");
    }

    [Fact]
    public void StatementForm_StillBinds_NoRegression()
    {
        const string source = @"
package p
func F() int32 {
  var i = 3
  i++
  i--
  i++
  return i
}
";
        var diagnostics = GetDiagnostics(source).ToList();
        Assert.Empty(diagnostics);
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }
}
