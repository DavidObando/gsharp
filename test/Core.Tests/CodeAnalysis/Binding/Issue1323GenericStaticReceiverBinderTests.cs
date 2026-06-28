// <copyright file="Issue1323GenericStaticReceiverBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1323: binding a generic static member-access receiver
/// <c>Type[TypeArg].StaticMember(...)</c> where the single type argument is
/// nullable (<c>T?</c>), an array/slice (<c>[]T</c>), or a nested generic
/// (<c>List[T]</c>). The parser emits a <c>GenericNameExpression</c> receiver
/// for these (and for the multi-argument shape); the binder must resolve it to
/// the closed construction and bind the static call without diagnostics.
/// </summary>
public class Issue1323GenericStaticReceiverBinderTests
{
    [Fact]
    public void NullableTypeArg_StaticCall_BindsWithoutDiagnostics()
    {
        const string source = @"
package p
struct Box[T] { shared { func Make(x int32) int32 { return x } } }
class C { func F() int32 { return Box[int32?].Make(5) } }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ArrayTypeArg_StaticCall_BindsWithoutDiagnostics()
    {
        const string source = @"
package p
struct Box[T] { shared { func Make(x int32) int32 { return x } } }
class C { func F() int32 { return Box[[]int32].Make(5) } }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void NestedGenericTypeArg_StaticCall_BindsWithoutDiagnostics()
    {
        const string source = @"
package p
import System.Collections.Generic
struct Box[T] { shared { func Make(x int32) int32 { return x } } }
class C { func F() int32 { return Box[List[int32]].Make(5) } }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void MultiTypeArg_StaticCall_BindsWithoutDiagnostics()
    {
        const string source = @"
package p
struct Pair[T, U] { shared { func Make(x int32) int32 { return x } } }
class C { func F() int32 { return Pair[int32, string].Make(5) } }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void SimpleTypeArg_StaticCall_StillBindsWithoutDiagnostics()
    {
        const string source = @"
package p
struct Box[T] { shared { func Make(x int32) int32 { return x } } }
class C { func F() int32 { return Box[int32].Make(5) } }
";
        Assert.Empty(GetDiagnostics(source));
    }

    private static IReadOnlyList<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree) { IsLibrary = true };
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        return result.Diagnostics;
    }
}
