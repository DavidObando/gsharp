// <copyright file="Issue1379GenericStaticReturnSubstitutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1379: a <c>shared</c> (static) method on a user-defined generic type
/// whose return type (and/or parameter types) reference the type's own type
/// parameter must have the receiver's type argument substituted at the call
/// site. <c>Box[int32].Make()</c> returning <c>Box[T]</c> must be typed
/// <c>Box[int32]</c> — not the raw/open <c>Box</c>, which fails the conversion
/// to the closed construction (GS0155). This is the user-defined counterpart of
/// the imported-generic fix in issue #1216 and exercises the binding receiver
/// added in issue #1323 (whose tests only used a non-generic static return type,
/// so the return-type substitution path was never covered).
/// </summary>
public class Issue1379GenericStaticReturnSubstitutionTests
{
    [Fact]
    public void StaticReturnReferencingT_BindsToClosedConstruction()
    {
        const string source = @"
package p
struct Box[T] { shared { func Make() Box[T] -> Box[T]{} } }
class C { func F() Box[int32] { return Box[int32].Make() } }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void StaticReturnAndParamReferencingT_BindsWithoutDiagnostics()
    {
        const string source = @"
package p
struct Box[T] { var V T shared { func Make(v T) Box[T] -> Box[T]{ V: v } } }
class C { func F() Box[int32] { return Box[int32].Make(5) } }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void StaticReturnReferencingT_WithNullableTypeArg_BindsWithoutDiagnostics()
    {
        const string source = @"
package p
struct Info { var X int32 }
struct Box[T] { var V T shared { func Make(v T) Box[T] -> Box[T]{ V: v } } }
class C { func F(i Info?) Box[Info?] { return Box[Info?].Make(i) } }
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void StaticReturnNotReferencingT_StillBindsWithoutDiagnostics()
    {
        // Control: a static method whose return type does NOT reference T keeps
        // working unchanged.
        const string source = @"
package p
struct Box[T] { shared { func Make() int32 -> 5 } }
class C { func F() int32 { return Box[int32].Make() } }
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
