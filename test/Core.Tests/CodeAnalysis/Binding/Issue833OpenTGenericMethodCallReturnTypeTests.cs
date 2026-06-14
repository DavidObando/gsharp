// <copyright file="Issue833OpenTGenericMethodCallReturnTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #833 (sibling to #794). When a generic method (top-level
/// <c>func</c>, generic shared method on a class, or generic extension
/// method) calls an imported CLR generic method whose type argument
/// is the in-scope method's own type parameter (e.g.
/// <c>Enumerable.Empty[T]()</c>, <c>[]T{}.ToArray()</c>,
/// <c>Array.Empty[T]()</c>), the call's bound return type must
/// preserve the symbolic <c>T</c> — not the CLR-erased <c>object</c>.
///
/// <list type="bullet">
///   <item><c>Enumerable.Empty[T]()</c> → <c>IEnumerable[T]</c> (was <c>IEnumerable[object]</c>)</item>
///   <item><c>Array.Empty[T]()</c> → <c>[]T</c> (was <c>[]object</c>)</item>
///   <item><c>[]T{}.ToArray()</c> → <c>[]T</c> (was <c>[]object</c>)</item>
///   <item><c>Enumerable.Repeat[T](v, n)</c> → <c>IEnumerable[T]</c></item>
/// </list>
///
/// Pre-fix the binder closed the static generic method against
/// <c>object</c> (because <c>T</c> has no reference-context CLR type),
/// so <see cref="System.Reflection.MethodInfo.ReturnType"/> surfaced as
/// the erased projection. That then failed conversion to the declared
/// <c>IEnumerable[T]</c> / <c>[]T</c>.
/// </summary>
public class Issue833OpenTGenericMethodCallReturnTypeTests
{
    [Fact]
    public void EnumerableEmpty_With_OpenT_Returns_SymbolicIEnumerableT()
    {
        const string source = @"
package Repro
import System
import System.Linq
import System.Collections.Generic

class Sequences {
    shared {
        func Empty[T]() IEnumerable[T] {
            return Enumerable.Empty[T]()
        }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ArrayEmpty_With_OpenT_Returns_SymbolicSliceT()
    {
        const string source = @"
package P
import System

class Sequences {
    shared {
        func Empty[T]() []T {
            return Array.Empty[T]()
        }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ToArray_On_OpenT_Slice_Returns_SymbolicSliceT()
    {
        const string source = @"
package P
import System
import System.Linq

class Sequences {
    shared {
        func MakeEmpty[T]() []T {
            return []T{}.ToArray()
        }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void EnumerableRepeat_With_OpenT_Returns_SymbolicIEnumerableT()
    {
        const string source = @"
package P
import System
import System.Linq
import System.Collections.Generic

class Sequences {
    shared {
        func Three[T](v T) IEnumerable[T] {
            return Enumerable.Repeat[T](v, 3)
        }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void Inside_TopLevel_Generic_Func_EnumerableEmpty_Threads_T()
    {
        const string source = @"
package P
import System
import System.Linq
import System.Collections.Generic

func Empty[T]() IEnumerable[T] {
    return Enumerable.Empty[T]()
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void Inside_Generic_Extension_Method_ToArray_Threads_T()
    {
        const string source = @"
package P
import System
import System.Linq
import System.Collections.Generic

func (self []T) MakeEmptyLike[T]() []T {
    return Array.Empty[T]()
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void EnumerableEmpty_Bound_Return_Type_Is_SymbolicIEnumerableT()
    {
        // Walk the bound tree to confirm the call's bound return type
        // is `IEnumerable[T]` over the function's type parameter — not
        // the erased `IEnumerable[object]`.
        const string source = @"
package P
import System
import System.Linq
import System.Collections.Generic

func Empty[T]() IEnumerable[T] {
    return Enumerable.Empty[T]()
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var fn = compilation.BoundProgram.Functions.Keys.Single(f => f.Name == "Empty");
        var body = compilation.BoundProgram.Functions[fn];
        var imps = new TypeCollector<ImportedTypeSymbol>();
        imps.Visit(body);
        Assert.Contains(imps.Collected, t =>
            !t.TypeArguments.IsDefaultOrEmpty
            && t.TypeArguments.Any(a => a is TypeParameterSymbol tp && tp.Name == "T"));
    }

    [Fact]
    public void ArrayEmpty_Bound_Return_Type_Is_SliceOfT()
    {
        const string source = @"
package P
import System

func Empty[T]() []T {
    return Array.Empty[T]()
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var fn = compilation.BoundProgram.Functions.Keys.Single(f => f.Name == "Empty");
        var body = compilation.BoundProgram.Functions[fn];
        var slices = new TypeCollector<SliceTypeSymbol>();
        slices.Visit(body);
        Assert.Contains(slices.Collected, s => s.ElementType is TypeParameterSymbol tp && tp.Name == "T");
    }

    [Fact]
    public void ToArray_On_SliceOfT_Bound_Return_Type_Is_SliceOfT()
    {
        const string source = @"
package P
import System
import System.Linq

func MakeEmpty[T]() []T {
    return []T{}.ToArray()
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var fn = compilation.BoundProgram.Functions.Keys.Single(f => f.Name == "MakeEmpty");
        var body = compilation.BoundProgram.Functions[fn];
        var slices = new TypeCollector<SliceTypeSymbol>();
        slices.Visit(body);
        Assert.Contains(slices.Collected, s => s.ElementType is TypeParameterSymbol tp && tp.Name == "T");
    }

    private static IReadOnlyList<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        return result.Diagnostics;
    }

    private static Compilation Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return new Compilation(tree) { IsLibrary = true };
    }

    private sealed class TypeCollector<T> : BoundTreeWalker
        where T : TypeSymbol
    {
        public List<T> Collected { get; } = new();

        public override void VisitExpression(BoundExpression node)
        {
            if (node?.Type is T match)
            {
                Collected.Add(match);
            }

            base.VisitExpression(node);
        }
    }
}
