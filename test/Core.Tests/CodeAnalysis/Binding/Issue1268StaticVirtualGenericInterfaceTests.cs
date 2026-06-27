// <copyright file="Issue1268StaticVirtualGenericInterfaceTests.cs" company="GSharp">
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
/// ADR-0089 / issue #1268 — static-virtual interface members accessed through a
/// type parameter (<c>T.Member</c>) whose constraint is a *constructed generic*
/// interface (<c>T : IData[int32]</c> or the self-referential
/// <c>T : IData[T]</c>). Prior issues (#755/#865/#1019/#1030/#1031) implemented
/// the feature for non-generic interface constraints; the generic-constraint
/// case reported GS0333 for properties (the constructed-interface property slot
/// was never searched). These tests pin that the binder now resolves both
/// static-virtual properties and methods through a generic interface
/// constraint.
/// </summary>
public class Issue1268StaticVirtualGenericInterfaceTests
{
    [Fact]
    public void StaticVirtualProperty_ThroughGenericConstraint_Binds()
    {
        var source = @"
package p
interface IData[X] {
  shared {
    prop SizeInBytes int32 { get; }
  }
}
func Use[T IData[int32]]() int32 { return T.SizeInBytes }
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void StaticVirtualProperty_ThroughSelfReferentialConstraint_Binds()
    {
        var source = @"
package p
interface IData[TData IData[TData]] {
  shared {
    prop SizeInBytes int32 { get; }
  }
}
func Use[T IData[T]]() int32 { return T.SizeInBytes }
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void GetSetStaticVirtualProperty_ThroughSelfReferentialConstraint_Binds()
    {
        var source = @"
package p
interface IData[TData IData[TData]] {
  shared {
    prop Tag int32 { get; set }
  }
}
func Use[T IData[T]]() int32 { return T.Tag }
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void StaticVirtualMethod_ThroughGenericConstraint_Binds()
    {
        var source = @"
package p
interface IData[X] {
  shared {
    func Size() int32;
  }
}
func Use[T IData[int32]]() int32 { return T.Size() }
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void StaticVirtualMethod_ThroughSelfReferentialConstraint_Binds()
    {
        var source = @"
package p
interface IData[TData IData[TData]] {
  shared {
    func Size() int32;
  }
}
func Use[T IData[T]]() int32 { return T.Size() }
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void UnknownStaticVirtualMember_ThroughGenericConstraint_StillReportsGS0333()
    {
        var source = @"
package p
interface IData[X] {
  shared {
    prop SizeInBytes int32 { get; }
  }
}
func Use[T IData[int32]]() int32 { return T.Missing }
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0333");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
