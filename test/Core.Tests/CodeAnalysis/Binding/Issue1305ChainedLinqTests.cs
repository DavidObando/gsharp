// <copyright file="Issue1305ChainedLinqTests.cs" company="GSharp">
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
/// Issue #1305: chaining an extension/LINQ method whose generic type parameter
/// is inferred from the <em>receiver</em> element type (e.g. <c>Where</c>'s
/// <c>TSource</c>, <c>OfType</c>/<c>Cast</c>'s result) over a same-compilation
/// user element produced a constructed result type whose backing
/// <c>ClrType</c> surfaced the <em>open</em> method type parameter
/// (<c>IEnumerable&lt;TSource&gt;</c>) instead of the type-erased
/// <c>IEnumerable&lt;object&gt;</c>. The root cause: the type-erased closed
/// shape was built with a live <c>typeof(object)</c>, which cannot close an
/// open definition loaded by the references' <c>MetadataLoadContext</c>; the
/// failed <c>MakeGenericType</c> fell back to the open return type. The next
/// extension lookup then matched against an unbound method type parameter and
/// reported GS0159 ("Cannot find function ...") on the SECOND call. These
/// binder-level tests assert the chained forms now bind with no diagnostics,
/// while the controls (primitive element, single call, lambda-inferred result)
/// keep working.
/// </summary>
public class Issue1305ChainedLinqTests
{
    [Fact]
    public void ChainedWhere_OverStructElement_NoDiagnostics()
    {
        // Repro (1): the SECOND .Where previously failed with GS0159.
        const string source = @"
package p
import System.Collections.Generic
import System.Linq
struct Ch { prop V bool { get; init; } }
func A(e IEnumerable[Ch]) IEnumerable[Ch] { return e.Where((c Ch)->c.V).Where((c Ch)->c.V) }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void WhereThenSelect_OverStructElement_NoDiagnostics()
    {
        // Repro (2): Select after a receiver-inferred Where failed with GS0159.
        const string source = @"
package p
import System.Collections.Generic
import System.Linq
struct Ch { prop V bool { get; init; } }
func B(e IEnumerable[Ch]) IEnumerable[bool] { return e.Where((c Ch)->c.V).Select((c Ch)->c.V) }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void OfTypeThenWhere_OverStructElement_NoDiagnostics()
    {
        // Repro (3): OfType[Ch]() result as a receiver failed the next Where.
        const string source = @"
package p
import System.Collections.Generic
import System.Linq
struct Ch { prop V bool { get; init; } }
func C(e IEnumerable[object]) IEnumerable[Ch] { return e.OfType[Ch]().Where((c Ch)->c.V) }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void CastThenWhere_OverStructElement_NoDiagnostics()
    {
        // Repro (4): Cast[Ch]() result as a receiver failed the next Where.
        const string source = @"
package p
import System.Collections.Generic
import System.Linq
struct Ch { prop V bool { get; init; } }
func D(e IEnumerable[object]) IEnumerable[Ch] { return e.Cast[Ch]().Where((c Ch)->c.V) }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ChainedWhere_OverClassElement_NoDiagnostics()
    {
        const string source = @"
package p
import System.Collections.Generic
import System.Linq
class Seg { public var X int32 = 0 }
func A(e IEnumerable[Seg]) IEnumerable[Seg] { return e.Where((s Seg)->s.X>0).Where((s Seg)->s.X>0) }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void TripleChainedWhere_OverStructElement_NoDiagnostics()
    {
        // Chaining beyond two calls must also resolve.
        const string source = @"
package p
import System.Collections.Generic
import System.Linq
struct Ch { prop V bool { get; init; } }
func E(e IEnumerable[Ch]) IEnumerable[Ch] { return e.Where((c Ch)->c.V).Where((c Ch)->c.V).Where((c Ch)->c.V) }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void OrderByThenWhere_OverStructElement_NoDiagnostics()
    {
        const string source = @"
package p
import System.Collections.Generic
import System.Linq
struct Ch { prop V int32 { get; init; } }
func O(e IEnumerable[Ch]) IEnumerable[Ch] { return e.OrderBy((c Ch)->c.V).Where((c Ch)->c.V>0) }
func O2(e IEnumerable[Ch]) IEnumerable[Ch] { return e.OrderByDescending((c Ch)->c.V).Where((c Ch)->c.V>0) }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void SingleWhere_OverStructElement_StillBinds()
    {
        // Control S: the single (first) call always bound; keep it green.
        const string source = @"
package p
import System.Collections.Generic
import System.Linq
struct Ch { prop V bool { get; init; } }
func S(e IEnumerable[Ch]) IEnumerable[Ch] { return e.Where((c Ch)->c.V) }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void LambdaInferredSelectThenWhere_StillBinds()
    {
        // Control T: when TResult is inferred from the lambda (not the
        // receiver), the constructed result already interned correctly.
        const string source = @"
package p
import System.Collections.Generic
import System.Linq
struct Ch { prop V bool { get; init; } }
func T(e IEnumerable[int32]) IEnumerable[Ch] { return e.Select((x int32)->Ch{V:true}).Where((c Ch)->c.V) }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ChainedWhere_OverPrimitiveElement_StillBinds()
    {
        // Control U: primitive element throughout was never affected.
        const string source = @"
package p
import System.Collections.Generic
import System.Linq
func U(e IEnumerable[int32]) IEnumerable[int32] { return e.Where((x int32)->x>0).Where((x int32)->x>0) }
";
        Assert.Empty(GetDiagnostics(source));
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
