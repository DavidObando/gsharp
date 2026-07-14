// <copyright file="Issue2323GenericSliceInterfaceBinderTests.cs" company="GSharp">
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
/// Issue #2323: pins the binder-side acceptance (already implemented by
/// <c>Conversion.SliceImplementsInterfaceSymbolically</c>) of a slice
/// <c>[]T</c> converting to each of the five supported one-argument generic
/// collection interfaces — <c>IEnumerable[T]</c>, <c>ICollection[T]</c>,
/// <c>IList[T]</c>, <c>IReadOnlyList[T]</c>, <c>IReadOnlyCollection[T]</c> —
/// when <c>T</c> is a generic type parameter whose backing
/// <see cref="GSharp.Core.CodeAnalysis.Symbols.TypeSymbol.ClrType"/> is
/// <see langword="null"/> during binding. No prior issue (#1162, #2140) had a
/// binder test explicitly covering the generic-type-parameter element case for
/// these five interfaces, only the element-INDEPENDENT non-generic
/// supertypes (#2140) and the same-compilation user-type element case
/// (#1162). The corresponding <c>Issue2323GenericSliceInterfaceEmitTests</c>
/// proves the paired emitter fix end-to-end.
/// </summary>
public class Issue2323GenericSliceInterfaceBinderTests
{
    [Fact]
    public void GenericParamElementArray_ToIEnumerable_NoDiagnostics()
    {
        const string source = @"
package P
import System.Collections.Generic
class G[T] {
    func ToEnum(arr []T) IEnumerable[T] { return arr }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void GenericParamElementArray_ToICollection_NoDiagnostics()
    {
        const string source = @"
package P
import System.Collections.Generic
class G[T] {
    func ToColl(arr []T) ICollection[T] { return arr }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void GenericParamElementArray_ToIList_NoDiagnostics()
    {
        const string source = @"
package P
import System.Collections.Generic
class G[T] {
    func ToList(arr []T) IList[T] { return arr }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void GenericParamElementArray_ToIReadOnlyList_NoDiagnostics()
    {
        const string source = @"
package P
import System.Collections.Generic
class G[T] {
    func ToRoList(arr []T) IReadOnlyList[T] { return arr }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void GenericParamElementArray_ToIReadOnlyCollection_NoDiagnostics()
    {
        const string source = @"
package P
import System.Collections.Generic
class G[T] {
    func ToRoColl(arr []T) IReadOnlyCollection[T] { return arr }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void GenericParamElementArray_ToAllFiveInterfaces_NoDiagnostics()
    {
        const string source = @"
package P
import System.Collections.Generic
class G[T] {
    func ToEnum(arr []T) IEnumerable[T] { return arr }
    func ToColl(arr []T) ICollection[T] { return arr }
    func ToList(arr []T) IList[T] { return arr }
    func ToRoList(arr []T) IReadOnlyList[T] { return arr }
    func ToRoColl(arr []T) IReadOnlyCollection[T] { return arr }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void GenericParamElementArray_ToMismatchedIList_StillRejected()
    {
        // Slice invariance must hold: []T does NOT convert to IList[U] for a
        // different generic parameter U.
        const string source = @"
package P
import System.Collections.Generic
class G[T, U] {
    func Bad(arr []T) IList[U] { return arr }
}
";
        var diags = GetDiagnostics(source);
        Assert.NotEmpty(diags);
        Assert.Contains(diags, d => d.Id == "GS0154" || d.Id == "GS0155");
    }

    [Fact]
    public void GenericParamElementArray_ToUnsupportedGenericInterface_StillRejected()
    {
        // ISet[T] is not one of the five supported array supertype
        // interfaces; a []T slice must not convert to it.
        const string source = @"
package P
import System.Collections.Generic
class G[T] {
    func Bad(arr []T) ISet[T] { return arr }
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
