// <copyright file="Issue1304MemberErasureTests.cs" company="GSharp">
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
/// Issue #1304: accessing a property/member on a constructed BCL/generic type
/// instantiated over a same-compilation user type erased the member type to
/// <c>object</c> instead of substituting the user element. Canonical case:
/// <c>IEnumerator[Ch].Current</c> typed <c>object</c> (GS0155) and
/// <c>e.Current.V</c> failing member lookup (GS0158) when <c>Ch</c> is a
/// user-defined struct whose backing <c>ClrType</c> is null during binding.
/// These binder-level tests assert no diagnostics on the substituted member
/// type (so <c>e.Current</c> is typed <c>Ch</c> and <c>e.Current.V</c>
/// resolves) while the primitive-element control keeps working.
/// </summary>
public class Issue1304MemberErasureTests
{
    [Fact]
    public void StructElementEnumerator_CurrentTypedAsElement_NoDiagnostics()
    {
        const string source = @"
package P
import System.Collections.Generic
struct Ch { prop V int32 { get; init; } }
func F(e IEnumerator[Ch]) Ch { return e.Current }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void StructElementEnumerator_CurrentMemberAccess_Resolves()
    {
        const string source = @"
package P
import System.Collections.Generic
struct Ch { prop V int32 { get; init; } }
func G(e IEnumerator[Ch]) int32 { return e.Current.V }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ClassElementEnumerator_CurrentMemberAccess_Resolves()
    {
        const string source = @"
package P
import System.Collections.Generic
class Seg { public var X int32 = 0 }
func G(e IEnumerator[Seg]) int32 { return e.Current.X }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void PrimitiveElementEnumerator_CurrentTypedAsElement_StillBinds()
    {
        // Regression control: the primitive (IEnumerator[int32]) path is
        // unchanged and Current keeps its int32 type.
        const string source = @"
package P
import System.Collections.Generic
func H(e IEnumerator[int32]) int32 { return e.Current }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void StructElementEnumerator_CurrentWrongConversion_Rejected()
    {
        // The substituted element type must be Ch (a struct), not object: a
        // member that does not exist on Ch is still rejected.
        const string source = @"
package P
import System.Collections.Generic
struct Ch { prop V int32 { get; init; } }
func G(e IEnumerator[Ch]) int32 { return e.Current.DoesNotExist }
";
        var diags = GetDiagnostics(source);
        Assert.NotEmpty(diags);
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
