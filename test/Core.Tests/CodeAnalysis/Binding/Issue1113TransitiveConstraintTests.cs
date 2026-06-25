// <copyright file="Issue1113TransitiveConstraintTests.cs" company="GSharp">
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
/// Issue #1113: a generic interface constraint (<c>[T IFace]</c>) is satisfied
/// when the type argument implements the interface ANYWHERE in its hierarchy —
/// directly, through a base class, or via a transitively-inherited base
/// interface (mirrors C#'s <c>where T : IFace</c>). The former check only
/// considered interfaces directly declared on the type argument, wrongly
/// reporting GS0152 for a class inheriting the interface through its base class.
/// A genuinely non-implementing type argument must still report GS0152.
/// </summary>
public class Issue1113TransitiveConstraintTests
{
    [Fact]
    public void InterfaceInheritedFromBaseClass_SatisfiesConstraint_NoGS0152()
    {
        var source = @"
interface IBox {
    func F() int32;
}

open class Box : IBox {
    func F() int32 { return 1 }
}

class FreeBox : Box {
}

func Use[T IBox](x T) int32 { return x.F() }
Use(FreeBox())
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0152");
    }

    [Fact]
    public void InterfaceInheritedFromGrandparent_SatisfiesConstraint_NoGS0152()
    {
        var source = @"
interface IBox {
    func F() int32;
}

open class Box : IBox {
    func F() int32 { return 1 }
}

open class MidBox : Box {
}

class LeafBox : MidBox {
}

func Use[T IBox](x T) int32 { return x.F() }
Use(LeafBox())
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0152");
    }

    [Fact]
    public void NonImplementingTypeArgument_StillReportsGS0152()
    {
        // Negative control: a class that does not implement the interface
        // anywhere in its hierarchy must still be rejected.
        var source = @"
interface IBox {
    func F() int32;
}

class NotABox {
}

func Use[T IBox](x T) int32 { return 0 }
Use[NotABox](NotABox())
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0152");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
