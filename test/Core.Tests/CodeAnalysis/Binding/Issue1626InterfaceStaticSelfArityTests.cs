// <copyright file="Issue1626InterfaceStaticSelfArityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1626: an unqualified (bare-name) call inside a static-virtual /
/// private-static interface helper body to a sibling static method with a
/// SINGLE overload skipped arity/named-argument validation entirely —
/// <see cref="OverloadResolver.SelectInstanceOverloadOrReport"/> returns a
/// lone candidate unchecked, and the interface static-self dispatch path then
/// indexed the callee's parameter list positionally. Too many arguments threw
/// an unhandled <see cref="System.IndexOutOfRangeException"/> (compiler
/// crash); too few silently built an invalid, under-sized
/// <see cref="BoundCallExpression"/>. Both must now report the standard
/// "wrong number of arguments" diagnostic instead.
/// </summary>
public class Issue1626InterfaceStaticSelfArityTests
{
    [Fact]
    public void StaticSelfCall_TooManyArguments_ReportsDiagnostic_NoCrash()
    {
        var source = @"
package p
interface ICalc {
    shared {
        func Caller() int32 { return Helper(1, 2) }
        private func Helper(x int32) int32 { return x }
    }
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.IsError);
    }

    [Fact]
    public void StaticSelfCall_TooFewArguments_ReportsDiagnostic_NoCrash()
    {
        var source = @"
package p
interface ICalc {
    shared {
        func Caller() int32 { return Helper() }
        private func Helper(x int32) int32 { return x }
    }
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.IsError);
    }

    [Fact]
    public void StaticSelfCall_NamedArgumentsOutOfOrder_BindsCorrectly()
    {
        var source = @"
package p
interface ICalc {
    shared {
        func Caller() int32 { return Helper(b: 2, a: 1) }
        private func Helper(a int32, b int32) int32 { return a - b }
    }
}
";
        var diagnostics = Bind(source);
        Assert.Empty(diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void StaticSelfCall_CorrectArity_StillResolves()
    {
        var source = @"
package p
interface ICalc {
    shared {
        func Caller() int32 { return Helper(1) }
        private func Helper(x int32) int32 { return x }
    }
}
";
        var diagnostics = Bind(source);
        Assert.Empty(diagnostics.Where(d => d.IsError));
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(
            previous: null,
            ImmutableArray.Create(tree),
            ReferenceResolver.Default());
        var program = Binder.BindProgram(globalScope, ReferenceResolver.Default());
        return globalScope.Diagnostics.AddRange(program.Diagnostics);
    }
}
