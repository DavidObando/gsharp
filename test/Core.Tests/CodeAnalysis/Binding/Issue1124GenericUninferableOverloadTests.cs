// <copyright file="Issue1124GenericUninferableOverloadTests.cs" company="GSharp">
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
/// Issue #1124. When a method group contains a generic overload whose method
/// type parameter cannot be inferred from the arguments (it appears only in the
/// return type / a constraint) alongside a non-generic overload with a matching
/// parameter list, a call without explicit type arguments must exclude the
/// generic candidate (C# §11.6.4.2: type inference failure makes the method
/// inapplicable) and bind the unique non-generic overload — not report GS0266
/// ambiguity. Explicit type arguments must still select the generic overload,
/// inferable generics must still participate, and genuinely ambiguous calls
/// must still report GS0266.
/// </summary>
public class Issue1124GenericUninferableOverloadTests
{
    [Fact]
    public void UninferableGeneric_PlusNonGeneric_ResolvesToNonGeneric_NoDiagnostics()
    {
        const string source = @"
package p
interface IBox {}
class Box : IBox {}
class Factory {
    shared {
        func Make[T Box](file int32, parent IBox?) T { return default(T) }
        func Make(file int32, parent IBox?) IBox { return Box() }
    }
}
class C {
    func G(b IBox) {
        let child = Factory.Make(5, b)
    }
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var make = FindCall(compilation, "G", "Make");
        Assert.NotNull(make);
        Assert.False(make.Function.IsGeneric);
    }

    [Fact]
    public void ExplicitTypeArguments_SelectGenericOverload()
    {
        const string source = @"
package p
interface IBox {}
class Box : IBox {}
class Factory {
    shared {
        func Make[T Box](file int32, parent IBox?) T { return default(T) }
        func Make(file int32, parent IBox?) IBox { return Box() }
    }
}
class C {
    func G(b IBox) {
        let child = Factory.Make[Box](5, b)
    }
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var make = FindCall(compilation, "G", "Make");
        Assert.NotNull(make);
        Assert.True(make.Function.IsGeneric);
    }

    [Fact]
    public void InferableGeneric_StillParticipates_NoDiagnostics()
    {
        // The generic overload's type parameter is inferable from the first
        // argument, and a non-generic overload of a different arity exists. The
        // two-argument call must bind the generic overload (T inferred from the
        // argument); the one-argument call must bind the non-generic overload.
        const string source = @"
package p
interface IBox {}
class Box : IBox {}
class Factory {
    shared {
        func Make[T Box](item T, file int32) T { return item }
        func Make(file int32) IBox { return Box() }
    }
}
class C {
    func G(box Box) {
        let a = Factory.Make(box, 5)
        let b = Factory.Make(7)
    }
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var calls = FindCalls(compilation, "G", "Make");
        Assert.Equal(2, calls.Count);
        Assert.Contains(calls, c => c.Function.IsGeneric);
        Assert.Contains(calls, c => !c.Function.IsGeneric);
    }

    [Fact]
    public void GenuineAmbiguity_BetweenNonGenericOverloads_StillReportsGS0266()
    {
        const string source = @"
package p
interface IA {}
interface IB {}
class Both : IA, IB {}
class Factory {
    shared {
        func Take(x IA) int32 { return 1 }
        func Take(x IB) int32 { return 2 }
    }
}
class C {
    func G(b Both) {
        let x = Factory.Take(b)
    }
}
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0266");
    }

    private static Compilation Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return new Compilation(tree) { IsLibrary = true };
    }

    private static BoundCallExpression FindCall(Compilation compilation, string functionName, string callName)
        => FindCalls(compilation, functionName, callName).FirstOrDefault();

    private static List<BoundCallExpression> FindCalls(Compilation compilation, string functionName, string callName)
    {
        var fn = compilation.BoundProgram.Functions.Keys.Single(f => f.Name == functionName);
        var body = compilation.BoundProgram.Functions[fn];
        var collector = new CallCollector(callName);
        collector.Visit(body);
        return collector.Collected;
    }

    private sealed class CallCollector : BoundTreeWalker
    {
        private readonly string callName;

        public CallCollector(string callName)
        {
            this.callName = callName;
        }

        public List<BoundCallExpression> Collected { get; } = new();

        public override void VisitExpression(BoundExpression node)
        {
            if (node is BoundCallExpression call && call.Function.Name == callName)
            {
                Collected.Add(call);
            }

            base.VisitExpression(node);
        }
    }
}
