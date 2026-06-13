// <copyright file="Issue794GenericInstanceCallReturnTypeTests.cs" company="GSharp">
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
/// Issue #794 / ADR-0084 §L5 follow-up. When a generic method (top-level
/// <c>func</c>, generic shared method on a class, or generic extension
/// method) instantiates an imported CLR generic over its own in-scope
/// type parameter (e.g. <c>List[T]()</c>), every subsequent instance
/// call or property access on that receiver must thread the symbolic
/// type argument back through the member's return / parameter signature:
///
/// <list type="bullet">
///   <item><c>List[T]().ToArray()</c> → <c>[]T</c> (was <c>object[]</c>)</item>
///   <item><c>List[T]().Add(v)</c> binds when <c>v</c> is typed <c>T</c></item>
///   <item><c>List[T]().Count</c> → <c>int32</c></item>
///   <item><c>Dictionary[K, V]().Keys</c> → <c>ICollection[K]</c></item>
/// </list>
///
/// Pre-fix the binder used <see cref="System.Type"/>-driven reflection
/// on the receiver's type-erased closed CLR shape
/// (<c>List&lt;object&gt;</c>) and surfaced the return / property type
/// as the erased projection, which then failed conversion to the
/// declared <c>[]T</c> / <c>K</c> / <c>ICollection[K]</c>.
/// </summary>
public class Issue794GenericInstanceCallReturnTypeTests
{
    [Fact]
    public void Repro_From_Issue_ListT_ToArray_Inside_Generic_Shared_Returns_SliceOfT()
    {
        // Verbatim issue repro (sans the `default` literal, tracked
        // separately). Pre-fix: `GS0155: Cannot convert type
        // 'System.Object[]' to '[]T'.`
        const string source = @"
package Repro
import System
import System.Collections.Generic

class Sequences {
    shared {
        func MakeList[T any]() []T {
            var list = List[T]()
            return list.ToArray()
        }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ListT_Count_Returns_Int32_Inside_Generic_Shared()
    {
        const string source = @"
package P
import System
import System.Collections.Generic

class Sequences {
    shared {
        func Make[T any]() int32 {
            var list = List[T]()
            return list.Count
        }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ListT_Add_Accepts_TypeParameter_Argument_Inside_Generic_Shared()
    {
        const string source = @"
package P
import System
import System.Collections.Generic

class Sequences {
    shared {
        func Make[T any](v T) int32 {
            var list = List[T]()
            list.Add(v)
            return list.Count
        }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void DictionaryKV_Keys_Returns_GenericKeyCollection_Inside_Generic_Shared()
    {
        // The for-in iteration variable `k` must surface as the
        // receiver's symbolic `K` (not the erased `object`) so the
        // return-as-`K` unifies. The fix substitutes the `Keys`
        // property type (`ICollection<TKey>`) through the receiver's
        // TypeArguments.
        const string source = @"
package P
import System
import System.Collections.Generic

class Sequences {
    shared {
        func FirstKey[K any, V any](fb K) K {
            var dict = Dictionary[K, V]()
            for k in dict.Keys {
                return k
            }
            return fb
        }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void Inside_TopLevel_Generic_Func_ToArray_Threads_T()
    {
        // Identical shape to the issue repro but inside a top-level
        // generic `func` rather than a shared method on a class.
        const string source = @"
package P
import System
import System.Collections.Generic

func MakeList[T any]() []T {
    var list = List[T]()
    return list.ToArray()
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void Inside_Generic_Extension_Method_ToArray_Threads_T()
    {
        // Cross-check with the #773 receiver-clause fix: an extension
        // method with a generic receiver must also thread its own type
        // parameter through subsequent instance calls on a CLR generic.
        const string source = @"
package P
import System
import System.Collections.Generic

func (self []T) DuplicateInto[T]() []T {
    var list = List[T]()
    for v in self {
        list.Add(v)
        list.Add(v)
    }
    return list.ToArray()
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ListT_ToArray_Bound_Return_Type_Is_SliceOfT()
    {
        // Walk the bound tree to confirm the call's bound return type
        // is `[]T` over the function's type parameter — not the erased
        // `[]object`.
        const string source = @"
package P
import System
import System.Collections.Generic

func MakeList[T any]() []T {
    var list = List[T]()
    return list.ToArray()
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var fn = compilation.BoundProgram.Functions.Keys.Single(f => f.Name == "MakeList");
        var body = compilation.BoundProgram.Functions[fn];
        var slices = new TypeCollector<SliceTypeSymbol>();
        slices.Visit(body);
        Assert.Contains(slices.Collected, s => s.ElementType is TypeParameterSymbol tp && tp.Name == "T");
    }

    [Fact]
    public void DictionaryKV_Keys_Bound_Type_Carries_Symbolic_K()
    {
        const string source = @"
package P
import System
import System.Collections.Generic

func MakeKeys[K any, V any]() {
    var dict = Dictionary[K, V]()
    var keys = dict.Keys
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var fn = compilation.BoundProgram.Functions.Keys.Single(f => f.Name == "MakeKeys");
        var body = compilation.BoundProgram.Functions[fn];
        var imps = new TypeCollector<ImportedTypeSymbol>();
        imps.Visit(body);
        Assert.Contains(imps.Collected, t =>
            !t.TypeArguments.IsDefaultOrEmpty
            && t.TypeArguments.Any(a => a is TypeParameterSymbol tp && tp.Name == "K"));
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
