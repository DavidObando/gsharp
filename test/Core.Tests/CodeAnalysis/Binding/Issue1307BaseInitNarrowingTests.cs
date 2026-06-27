// <copyright file="Issue1307BaseInitNarrowingTests.cs" company="GSharp">
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
/// Issue #1307 — a base-constructor initializer (<c>: base(&lt;literal&gt;)</c>)
/// must apply the same implicit constant-narrowing / integer-literal adaptation
/// (C# §10.2.11, issues #1281/#1306) that ordinary calls and direct
/// constructions already apply. The base-init argument-binding path previously
/// bypassed that pass, so <c>: base(5)</c> against a <c>uint8</c> constructor
/// failed overload resolution with GS0214 even though literal <c>5</c> adapts
/// to <c>uint8</c> everywhere else.
/// </summary>
public class Issue1307BaseInitNarrowingTests
{
    [Fact]
    public void BaseInitLiteralAdaptsToNarrowerExplicitCtor_BindsWithoutDiagnostics()
    {
        var source = @"
package p
open class B {
    init(t uint8) {}
}
class D : B {
    init() : base(5) {}
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void BaseInitLiteralAdaptsToNarrowerPrimaryCtor_BindsWithoutDiagnostics()
    {
        var source = @"
package p
open class B(t uint8) {}
class D : B {
    init() : base(5) {}
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void BaseInitWithNoNarrowingNeeded_StillBindsWithoutDiagnostics()
    {
        var source = @"
package p
open class C {
    init(t int32) {}
}
class E : C {
    init() : base(5) {}
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void BaseInitWithExplicitCast_StillBindsWithoutDiagnostics()
    {
        var source = @"
package p
open class B {
    init(t uint8) {}
}
class D2 : B {
    init() : base(uint8(5)) {}
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void BaseInitOutOfRangeLiteral_StillReportsDiagnostic()
    {
        var source = @"
package p
open class B {
    init(t uint8) {}
}
class D : B {
    init() : base(300) {}
}
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
