// <copyright file="Issue1060BaseInitChainingBinderTests.cs" company="GSharp">
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
/// Issue #1060 — binder-level tests confirming that a derived class's
/// constructor initializer (<c>init(...) : base(args)</c>) resolves against the
/// base class's explicit <c>init(...)</c> member constructors (and a primary
/// constructor when present), not only the primary constructor. The previously
/// failing repros must now bind with zero diagnostics; a genuinely-missing base
/// constructor must still report GS0214.
/// </summary>
public class Issue1060BaseInitChainingBinderTests
{
    [Fact]
    public void ChainToSingleExplicitBaseInit_BindsWithoutDiagnostics()
    {
        var source = @"
package p
open class A {
    var X int32
    init(x int32) { X = x }
}
class B : A {
    init(x int32) : base(x) { }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void SelectsAmongMultipleExplicitBaseInits_BindsWithoutDiagnostics()
    {
        var source = @"
package p
open class A {
    init(x int32) {}
    init(x int32, y int32) {}
}
class B : A {
    init() : base(1, 2) { }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ChainToBasePrimaryConstructor_StillBindsWithoutDiagnostics()
    {
        var source = @"
package p
open class A(X int32) {}
class B : A {
    init(x int32) : base(x) {}
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NoMatchingBaseConstructor_ReportsGs0214()
    {
        var source = @"
package p
open class A {
    init(x int32) {}
}
class B : A {
    init() : base(""nope"") {}
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0214");
    }

    [Fact]
    public void WrongArgumentCountForExplicitBaseInit_ReportsGs0214()
    {
        var source = @"
package p
open class A {
    init(x int32) {}
}
class B : A {
    init() : base(1, 2) {}
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0214");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
