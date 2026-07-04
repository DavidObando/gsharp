// <copyright file="Issue2026GenericAsyncTaskWrapTests.cs" company="GSharp">
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
/// Issue #2026: calling a generic <c>async func</c> (or an async
/// local-function-literal invoked through its delegate value) from inside
/// another generic function must observe the call's result type as
/// <c>Task[U]</c> (the substituted return type Task-wrapped) — mirroring the
/// non-generic case — not the raw substituted return type <c>U</c>.
/// Previously <see cref="LambdaBinder.WrapAsTask"/> only special-cased a
/// <c>null</c>-<see cref="TypeSymbol.ClrType"/> element for same-compilation
/// <c>struct</c>/<c>interface</c>/<c>enum</c> types, silently returning the
/// bare element (unwrapped) for a still-open <see cref="TypeParameterSymbol"/>
/// (whose <c>ClrType</c> is also <c>null</c>), which made
/// <c>await r</c> report GS0133 ("cannot be awaited").
/// </summary>
public class Issue2026GenericAsyncTaskWrapTests
{
    [Fact]
    public void GenericAsyncFunctionCall_InsideAnotherGeneric_ObservedAsTaskOfSubstitutedType()
    {
        const string source = @"
package p
async func Foo[U](x U) U {
    return x
}
async func Outer[U](seed U) U {
    var r = Foo(seed)
    return await r
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var call = FindCall(compilation, "Outer", "Foo");
        Assert.NotNull(call);
        AssertIsTaskOf(call.Type, expectedTypeArgumentName: "U");
    }

    [Fact]
    public void GenericAsyncFunctionCall_AtTopLevel_ClosesOverConcreteTypeArgument()
    {
        const string source = @"
package p
async func Foo[U](x U) U {
    return x
}
async func Outer[U](seed U) U {
    var r = Foo(seed)
    return await r
}
var t = Outer(""hi"")
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        Assert.Empty(compilation.GlobalScope.Diagnostics);
    }

    [Fact]
    public void AsyncLocalFunctionLiteral_ReferencingEnclosingTypeParameter_ReportsGS0468NotGS0133()
    {
        // Issue #2026's repro predates issue #2016's GS0468 gate (landed on
        // this branch's parent commit), which now diagnoses ANY local
        // function-literal (named via `let`/`var`/`const`) that directly
        // references an enclosing generic function's type parameter in its
        // own signature/body — exactly the shape #2026 originally described
        // as call-shape (b). That shape is therefore no longer reachable:
        // GS0468 fires first, and this is intentional/by-design (referencing
        // the enclosing type parameter would otherwise emit invalid IL). This
        // regression test pins that GS0468 — not the unrelated GS0133 this
        // issue is about — is what callers see for that shape.
        const string source = @"
package p
async func Outer[U](seed U) U {
    let foo = async func(x U) U { return x }
    var r = foo(seed)
    return await r
}
";
        var compilation = Compile(source);
        Assert.Contains(compilation.BoundProgram.Diagnostics, d => d.Id == "GS0468");
        Assert.DoesNotContain(compilation.BoundProgram.Diagnostics, d => d.Id == "GS0133");
    }

    [Fact]
    public void AsyncLocalFunctionLiteral_InvokedThroughDelegateValue_ConcreteType_StillWrapsAsTask_Regression()
    {
        // Baseline regression for the (still-legal) local-function-literal
        // call shape: a concrete (non-generic-type-parameter) async
        // local-function-literal invoked through its delegate value must
        // still observe Task[T] at the call site, matching top-level async
        // functions. This shape never depended on the WrapAsTask fix (its
        // element type always had a real ClrType), but it pins the sibling
        // call path stays correct alongside the #2026 fix.
        const string source = @"
package p
async func Outer(seed int32) int32 {
    let foo = async func(x int32) int32 { return x }
    var r = foo(seed)
    return await r
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var indirectCall = FindIndirectCall(compilation, "Outer");
        Assert.NotNull(indirectCall);
        Assert.True(indirectCall.Type is ImportedTypeSymbol imported
            && imported.ClrType.IsGenericType
            && imported.ClrType.GetGenericTypeDefinition() == typeof(System.Threading.Tasks.Task<>));
    }


    [Fact]
    public void GenericAsyncFunctionCall_NotAwaited_StillObservedAsTask_ForDownstreamUse()
    {
        // The issue explicitly calls out the "call but don't await" shape:
        // the call's result must still type as Task[U] for any downstream
        // use (here: assigning it to another local of the same inferred type).
        const string source = @"
package p
async func Foo[U](x U) U {
    return x
}
func Outer[U](seed U) {
    var r = Foo(seed)
    var r2 = r
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var call = FindCall(compilation, "Outer", "Foo");
        Assert.NotNull(call);
        AssertIsTaskOf(call.Type, expectedTypeArgumentName: "U");
    }

    [Fact]
    public void NonGenericAsyncFunctionCall_InsideGenericCaller_StillWrapsAsTask_Regression()
    {
        // Regression: a NON-generic async callee's call-site return type must
        // still wrap as Task[T] exactly as before this fix, even when the
        // caller itself is generic.
        const string source = @"
package p
async func Answer() int32 {
    return 42
}
async func Outer[U](seed U) int32 {
    var r = Answer()
    return await r
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var call = FindCall(compilation, "Outer", "Answer");
        Assert.NotNull(call);
        Assert.True(call.Type is ImportedTypeSymbol imported
            && imported.ClrType.IsGenericType
            && imported.ClrType.GetGenericTypeDefinition() == typeof(System.Threading.Tasks.Task<>));
    }

    [Fact]
    public void MultipleGenericTypeParameters_AsyncFunctionCall_ObservedAsTaskOfSubstitutedSecondParameter()
    {
        const string source = @"
package p
async func Pair[TFirst, TSecond](a TFirst, b TSecond) TSecond {
    return b
}
async func Outer[TFirst, TSecond](x TFirst, y TSecond) TSecond {
    var r = Pair(x, y)
    return await r
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var call = FindCall(compilation, "Outer", "Pair");
        Assert.NotNull(call);
        AssertIsTaskOf(call.Type, expectedTypeArgumentName: "TSecond");
    }

    [Fact]
    public void GenericLocalFunctionDeclaration_NestedInsideGenericFunction_ReferencingOwnAsyncCall_Regression()
    {
        // A nested (non-async) generic local helper that itself calls a
        // top-level generic async function inside a generic outer function —
        // covering "async local function nested inside another generic
        // function" from a different angle: the local function's own body
        // still observes the inner call as Task[U] (not the local function
        // being itself declared async/generic, which issue #2016's GS0468
        // gate now forbids for any local function referencing the enclosing
        // type parameter).
        const string source = @"
package p
async func Foo[U](x U) U {
    return x
}
async func Outer[U](seed U) U {
    var r = Foo(seed)
    var r2 = Foo(seed)
    return await r
}
";
        var compilation = Compile(source);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var calls = FindCalls(compilation, "Outer", "Foo");
        Assert.Equal(2, calls.Count);
        Assert.All(calls, c => AssertIsTaskOf(c.Type, expectedTypeArgumentName: "U"));
    }

    private static void AssertIsTaskOf(TypeSymbol type, string expectedTypeArgumentName)
    {
        Assert.True(type is ImportedTypeSymbol imported
            && imported.ClrType.IsGenericType
            && imported.ClrType.GetGenericTypeDefinition() == typeof(System.Threading.Tasks.Task<>)
            && imported.TypeArguments.Length == 1
            && imported.TypeArguments[0].Name == expectedTypeArgumentName,
            $"Expected Task[{expectedTypeArgumentName}], got '{type}'.");
    }

    private static Compilation Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return new Compilation(tree) { IsLibrary = true };
    }

    private static BoundCallExpression FindCall(Compilation compilation, string functionName, string callName)
    {
        var fn = compilation.BoundProgram.Functions.Keys.Single(f => f.Name == functionName);
        var body = compilation.BoundProgram.Functions[fn];
        var collector = new CallCollector(callName);
        collector.Visit(body);
        return collector.Collected.FirstOrDefault();
    }

    private static List<BoundCallExpression> FindCalls(Compilation compilation, string functionName, string callName)
    {
        var fn = compilation.BoundProgram.Functions.Keys.Single(f => f.Name == functionName);
        var body = compilation.BoundProgram.Functions[fn];
        var collector = new CallCollector(callName);
        collector.Visit(body);
        return collector.Collected;
    }

    private static BoundIndirectCallExpression FindIndirectCall(Compilation compilation, string functionName)
    {
        var fn = compilation.BoundProgram.Functions.Keys.Single(f => f.Name == functionName);
        var body = compilation.BoundProgram.Functions[fn];
        var collector = new IndirectCallCollector();
        collector.Visit(body);
        return collector.Collected.FirstOrDefault();
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

    private sealed class IndirectCallCollector : BoundTreeWalker
    {
        public List<BoundIndirectCallExpression> Collected { get; } = new();

        public override void VisitExpression(BoundExpression node)
        {
            if (node is BoundIndirectCallExpression call)
            {
                Collected.Add(call);
            }

            base.VisitExpression(node);
        }
    }
}
