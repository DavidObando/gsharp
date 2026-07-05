// <copyright file="Issue2140GenericArraySupertypesBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections;
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
/// Issue #2140: a slice <c>[]T</c> whose element <c>T</c> is a generic type
/// parameter (or same-compilation user type) has a null backing
/// <c>ClrType</c> during binding. It must still convert to the element-
/// INDEPENDENT array supertypes that EVERY one-dimensional array carries: the
/// base class <see cref="System.Array"/> and the non-generic collection
/// interfaces (<see cref="IEnumerable"/>, <see cref="ICollection"/>,
/// <see cref="IList"/>), plus <see cref="System.ICloneable"/>,
/// <see cref="IStructuralComparable"/>, <see cref="IStructuralEquatable"/>.
/// These conversions carry no element type argument, so slice invariance for
/// the generic element interfaces (<c>IEnumerable[T]</c> etc.) is unaffected.
/// </summary>
public class Issue2140GenericArraySupertypesBinderTests
{
    [Fact]
    public void GenericParamElementArray_ToSystemArray_NoDiagnostics()
    {
        const string source = @"
package P
class G[T] {
    func ToArr(arr []T) System.Array { return arr }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void GenericParamElementArray_ToNonGenericIEnumerable_NoDiagnostics()
    {
        const string source = @"
package P
class G[T] {
    func ToEnum(arr []T) System.Collections.IEnumerable { return arr }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void GenericParamElementArray_ToNonGenericICollection_NoDiagnostics()
    {
        const string source = @"
package P
class G[T] {
    func ToColl(arr []T) System.Collections.ICollection { return arr }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void GenericParamElementArray_ToNonGenericIList_NoDiagnostics()
    {
        const string source = @"
package P
class G[T] {
    func ToList(arr []T) System.Collections.IList { return arr }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void GenericParamElementArray_ToICloneable_NoDiagnostics()
    {
        const string source = @"
package P
class G[T] {
    func ToClone(arr []T) System.ICloneable { return arr }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void GenericParamElementArray_ToAllElementIndependentSupertypes_NoDiagnostics()
    {
        const string source = @"
package P
class G[T] {
    func ToArr(arr []T) System.Array { return arr }
    func ToEnum(arr []T) System.Collections.IEnumerable { return arr }
    func ToColl(arr []T) System.Collections.ICollection { return arr }
    func ToList(arr []T) System.Collections.IList { return arr }
    func ToClone(arr []T) System.ICloneable { return arr }
    func ToStructComp(arr []T) System.Collections.IStructuralComparable { return arr }
    func ToStructEq(arr []T) System.Collections.IStructuralEquatable { return arr }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void UserTypeElementArray_ToSystemArray_NoDiagnostics()
    {
        const string source = @"
package P
struct Segment { let X uint32 }
func ToArr(arr []Segment) System.Array { return arr }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ConcreteElementArray_ToSystemArray_StillNoDiagnostics()
    {
        // Control: the concrete-element path (backing ClrType non-null) must
        // remain unaffected.
        const string source = @"
package P
func ToArr(arr []string) System.Array { return arr }
func ToColl(arr []string) System.Collections.ICollection { return arr }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void GenericParamElementArray_ToMismatchedGenericIEnumerable_StillRejected()
    {
        // Slice invariance for the generic element interfaces must be
        // preserved: []T does NOT convert to IEnumerable[U] for a different U.
        const string source = @"
package P
import System.Collections.Generic
class G[T, U] {
    func Bad(arr []T) IEnumerable[U] { return arr }
}
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

        IEnumerator IEnumerable.GetEnumerator() => this.GetEnumerator();
    }
}
