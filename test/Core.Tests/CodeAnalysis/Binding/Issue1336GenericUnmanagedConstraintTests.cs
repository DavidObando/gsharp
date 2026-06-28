// <copyright file="Issue1336GenericUnmanagedConstraintTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1336: unsafe generic SIMD code over an <c>unmanaged</c>-constrained
/// type parameter <c>T</c> must bind. Two capabilities are required:
/// <list type="number">
/// <item><c>sizeof(T)</c> where <c>T</c> is a generic type parameter
/// constrained <c>unmanaged</c> (previously GS0130/GS0125).</item>
/// <item><c>*T</c> (a pointer to a type parameter) where <c>T : unmanaged</c>
/// (previously GS0398).</item>
/// </list>
/// The <c>unmanaged</c> constraint is what makes both legal; a plain
/// (unconstrained) type parameter must still be rejected.
/// </summary>
public class Issue1336GenericUnmanagedConstraintTests
{
    [Fact]
    public void SizeOfTypeParameter_WithUnmanagedConstraint_NoDiagnostics()
    {
        const string source = @"
package p
class C {
    func Size[T unmanaged]() int32 {
        return sizeof(T)
    }
}
";
        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void SizeOfTypeParameter_WithoutUnmanagedConstraint_ReportsGS0415()
    {
        const string source = @"
package p
class C {
    func Size[T any]() int32 {
        return sizeof(T)
    }
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0415");
    }

    [Fact]
    public void SizeOfReferenceType_ReportsGS0415()
    {
        const string source = @"
package p
class C {
    func Size() int32 {
        return sizeof(string)
    }
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0415");
    }

    [Fact]
    public void SizeOfPrimitive_NoDiagnostics()
    {
        const string source = @"
package p
class C {
    func Size() int32 {
        return sizeof(int32)
    }
}
";
        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void PointerToTypeParameter_WithUnmanagedConstraint_NoGS0398()
    {
        const string source = @"
package p
class C {
    unsafe func First[T unmanaged](p *T) T {
        return *p
    }
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0398");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void PointerToTypeParameter_WithoutUnmanagedConstraint_ReportsGS0398()
    {
        const string source = @"
package p
class C {
    unsafe func First[T any](p *T) T {
        return *p
    }
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0398");
    }

    [Fact]
    public void UnmanagedConstraint_SatisfiedByPrimitive_NoDiagnostics()
    {
        const string source = @"
package p
class C {
    func Id[T unmanaged](x T) T { return x }
    func Use() int32 { return Id[int32](5) }
}
";
        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void UnmanagedConstraint_NotSatisfiedByReferenceType_ReportsGS0152()
    {
        const string source = @"
package p
class C {
    func Id[T unmanaged](x T) T { return x }
    func Use() string { return Id[string](""a"") }
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0152");
    }

    [Fact]
    public void CombinedInterfaceAndUnmanagedConstraint_PrimitiveOk_ReferenceRejected()
    {
        const string source = @"
package p
import System
class C {
    func Cmp[T IComparable[T] unmanaged](a T, b T) int32 {
        return a.CompareTo(b) + sizeof(T)
    }
    func Ok() int32 { return Cmp[int32](1, 2) }
}
";
        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void CombinedInterfaceAndUnmanagedConstraint_ReferenceType_Rejected()
    {
        const string source = @"
package p
import System
class C {
    func Cmp[T IComparable[T] unmanaged](a T, b T) int32 {
        return a.CompareTo(b) + sizeof(T)
    }
    func Bad() int32 { return Cmp[string](""a"", ""b"") }
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0152");
    }

    [Fact]
    public void UnmanagedCombinedWithStruct_ReportsGS0361()
    {
        // `unmanaged` already implies `struct`; spelling both is a
        // mutually-exclusive/redundant constraint conflict (ADR-0097 GS0361).
        const string source = @"
package p
class C {
    func F[T unmanaged struct](x T) T { return x }
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0361");
    }

    private static IReadOnlyList<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var program = Binder.BindProgram(compilation.GlobalScope, compilation.References);
        return tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(program.Diagnostics)
            .ToList();
    }
}
