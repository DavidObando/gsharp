// <copyright file="Issue1422ChainedSelectGenericInterfaceElementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1422 (refs #914): a chained <c>.Select(...).Select(...)</c> failed on
/// the SECOND <c>Select</c> with <c>GS0159 (Cannot find function Select)</c> when
/// the first projection's element type was itself a <em>constructed generic
/// interface over an in-scope type parameter</em> (e.g. <c>IEnumerator[T]</c>),
/// even though each <c>Select</c> bound cleanly in isolation.
/// <para>
/// Root cause: when the first <c>Select</c>'s result type
/// (<c>IEnumerable[IEnumerator[T]]</c>) was projected to its type-erased closed
/// CLR shape, every top-level generic argument was flatly erased to
/// <c>System.Object</c> — collapsing the receiver to <c>IEnumerable&lt;object&gt;</c>
/// and discarding the nested <c>IEnumerator&lt;…&gt;</c> structure. The second
/// <c>Select</c>'s generic inference then bound <c>TSource = object</c>, which
/// no longer matched the explicitly-typed <c>(e IEnumerator[T])</c> selector, so
/// the candidate was dropped (GS0159). The fix erases each argument while
/// preserving its <em>nested</em> generic shape
/// (<c>IEnumerable&lt;IEnumerator&lt;object&gt;&gt;</c>), mirroring how the
/// selector's parameter type is erased, so inference recovers the right
/// <c>TSource</c>.
/// </para>
/// </summary>
public class Issue1422ChainedSelectGenericInterfaceElementTests
{
    [Fact]
    public void ChainedSelect_FirstProjectionGenericInterfaceElement_Binds()
    {
        // BUG: GS0159 on the SECOND Select — the first projection's element type
        // `IEnumerator[T]` collapsed to object on the chained receiver.
        const string source = @"
package p
import System
import System.Collections.Generic
import System.Linq
func C[T](xs []IEnumerable[T]) []int32 ->
    xs.Select((e IEnumerable[T]) -> e.GetEnumerator())
      .Select((e IEnumerator[T]) -> 1)
      .ToArray()
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ChainedSelect_ThreeDeep_GenericInterfaceElement_Binds()
    {
        // A three-deep chain keeps the nested `IEnumerator[T]` element identity
        // across every link.
        const string source = @"
package p
import System
import System.Collections.Generic
import System.Linq
func C[T](xs []IEnumerable[T]) []int32 ->
    xs.Select((e IEnumerable[T]) -> e.GetEnumerator())
      .Select((e IEnumerator[T]) -> e)
      .Select((e IEnumerator[T]) -> 1)
      .ToArray()
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ChainedSelect_ThenOrderBy_GenericInterfaceElement_Binds()
    {
        // A chain terminating in a different generic LINQ operator (OrderBy)
        // also recovers the nested element type.
        const string source = @"
package p
import System
import System.Collections.Generic
import System.Linq
func C[T](xs []IEnumerable[T]) []IEnumerator[T] ->
    xs.Select((e IEnumerable[T]) -> e.GetEnumerator())
      .OrderBy((e IEnumerator[T]) -> 1)
      .ToArray()
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void Controls_ConcreteElement_And_SingleSelect_Bind()
    {
        // Control 1: a fully-concrete element type (no in-scope type parameter)
        // was never affected and still binds.
        const string concreteElement = @"
package p
import System
import System.Collections.Generic
import System.Linq
func C(xs []IEnumerable[int32]) []int32 ->
    xs.Select((e IEnumerable[int32]) -> e.GetEnumerator())
      .Select((e IEnumerator[int32]) -> 1)
      .ToArray()
";

        // Control 2: each Select binds in isolation (the issue's premise).
        const string singleSelect = @"
package p
import System
import System.Collections.Generic
import System.Linq
func C[T](xs []IEnumerable[T]) []int32 ->
    xs.Select((e IEnumerable[T]) -> e.Count()).ToArray()
";
        Assert.Empty(GetDiagnostics(concreteElement));
        Assert.Empty(GetDiagnostics(singleSelect));
    }

    private static ImmutableArrayOfDiagnostic GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var parseDiagnostics = tree.Diagnostics;
        var bindDiagnostics = compilation.GlobalScope.Diagnostics;
        var programDiagnostics = compilation.BoundProgram.Diagnostics;
        var all = parseDiagnostics
            .Concat(bindDiagnostics)
            .Concat(programDiagnostics)
            .Where(d => d.IsError)
            .ToImmutableArray();
        return new ImmutableArrayOfDiagnostic(all);
    }

    /// <summary>
    /// Thin wrapper so the test cases can call <c>Assert.Empty</c> against a
    /// <see cref="ImmutableArray{T}"/> without exposing the GSharp diagnostic
    /// surface to xUnit's enumerable inference.
    /// </summary>
    private readonly struct ImmutableArrayOfDiagnostic : IReadOnlyCollection<Diagnostic>
    {
        private readonly ImmutableArray<Diagnostic> diagnostics;

        public ImmutableArrayOfDiagnostic(ImmutableArray<Diagnostic> diagnostics)
        {
            this.diagnostics = diagnostics;
        }

        public int Count => this.diagnostics.Length;

        public IEnumerator<Diagnostic> GetEnumerator()
        {
            foreach (var diagnostic in this.diagnostics)
            {
                yield return diagnostic;
            }
        }

        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator()
        {
            return GetEnumerator();
        }
    }
}
