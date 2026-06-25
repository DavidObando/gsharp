// <copyright file="Issue1162UserElementArrayBinderTests.cs" company="GSharp">
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
/// Issue #1162: a slice <c>[]T</c> whose element <c>T</c> is a
/// same-compilation user type (struct / class / enum) has a null backing
/// <c>ClrType</c> during binding. These binder-level tests assert that the
/// three affected paths now report no diagnostics: the <see cref="System.Array"/>
/// member surface (<c>.Length</c>), the <c>[]T → IEnumerable[T]</c> /
/// <c>IReadOnlyList[T]</c> conversion, and <c>IEnumerable&lt;T&gt;</c>
/// extension (LINQ) resolution — while primitive-element controls keep working
/// and genuinely incompatible element types are still rejected.
/// </summary>
public class Issue1162UserElementArrayBinderTests
{
    [Fact]
    public void StructElementArray_Length_NoDiagnostics()
    {
        const string source = @"
package P
struct Segment { let X uint32 }
func Len(xs []Segment) int32 { return xs.Length }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ClassElementArray_Length_NoDiagnostics()
    {
        const string source = @"
package P
class Seg { public let X int32 = 0 }
func Len(xs []Seg) int32 { return xs.Length }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void EnumElementArray_Length_NoDiagnostics()
    {
        const string source = @"
package P
enum Color { Red, Green, Blue }
func Len(xs []Color) int32 { return xs.Length }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void StructElementArray_ToIEnumerable_NoDiagnostics()
    {
        const string source = @"
package P
import System.Collections.Generic
struct Segment { let X uint32 }
func Take(e IEnumerable[Segment]) int32 { return 0 }
func F(xs []Segment) int32 { return Take(xs) }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void StructElementArray_ToIReadOnlyList_NoDiagnostics()
    {
        const string source = @"
package P
import System.Collections.Generic
struct Segment { let X uint32 }
func Take(e IReadOnlyList[Segment]) int32 { return 0 }
func F(xs []Segment) int32 { return Take(xs) }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void StructElementArray_LinqSum_NoDiagnostics()
    {
        const string source = @"
package P
import System.Linq
struct Segment { let ReferenceSize uint32 }
func F(segs []Segment) int64 { return segs.Sum((s Segment) -> int64(s.ReferenceSize)) }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ClassElementArray_LinqWhereCount_NoDiagnostics()
    {
        const string source = @"
package P
import System.Linq
class Seg { public let X int32 = 0 }
func F(xs []Seg) int32 { return xs.Where((s Seg) -> s.X > 0).Count() }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void PrimitiveElementArray_LengthAndLinq_StillBind()
    {
        const string source = @"
package P
import System.Linq
func F(xs []int32) int32 { return xs.Sum() }
func G(xs []int32) int32 { return xs.Where((x int32) -> x > 0).Count() }
func F2(xs []int32) int32 { return xs.Length }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void Negative_StructElementArray_ToMismatchedIEnumerable_Rejected()
    {
        // Slice invariance must hold for user types too: a []SegA does NOT
        // convert to IEnumerable[SegB].
        const string source = @"
package P
import System.Collections.Generic
struct SegA { let X uint32 }
struct SegB { let Y uint32 }
func Take(e IEnumerable[SegB]) int32 { return 0 }
func F(xs []SegA) int32 { return Take(xs) }
";
        var diags = GetDiagnostics(source);
        Assert.NotEmpty(diags);
        Assert.Contains(diags, d => d.Id == "GS0154" || d.Id == "GS0155");
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
