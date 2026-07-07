// <copyright file="Issue2232AsyncTupleTaskWrapTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2232: an <c>async func</c> whose declared (implicit-wrap) return type
/// is a tuple containing a still-in-flight user-defined element — e.g.
/// <c>(bool, UserClass)</c> or <c>(bool, IUserInterface)</c> — must observe its
/// call-site result as <c>Task[(bool, UserType)]</c>, so <c>await F()</c>
/// yields the bare tuple. <see cref="TupleTypeSymbol"/> reports a <c>null</c>
/// <see cref="TypeSymbol.ClrType"/> when any element lacks a CLR backing type,
/// which previously fell through <see cref="LambdaBinder.WrapAsTask"/>'s
/// symbolic branch (that only special-cased <c>struct</c>/<c>interface</c>/
/// <c>enum</c>/type-parameter elements), silently dropping the <c>Task</c>
/// wrapper. The bare tuple then failed <c>await</c> with GS0133 ("cannot be
/// awaited"), cascading GS0125 onto any deconstructed bindings. A tuple whose
/// elements are all BCL types (e.g. <c>(bool, string)</c>) was unaffected
/// because its <c>ValueTuple&lt;...&gt;</c> ClrType resolves.
/// </summary>
public class Issue2232AsyncTupleTaskWrapTests
{
    [Fact]
    public void AsyncFunc_ReturningTupleWithUserClassElement_Awaited_ObservedAsTaskOfTuple()
    {
        const string source = @"
package p
class Box { }
async func Producer() (bool, Box) {
    return (true, Box())
}
async func Consume() bool {
    let t = await Producer()
    return t.Item1
}
";
        var compilation = Compile(source);
        AssertNoAwaitOrScopeErrors(compilation);

        var call = FindCall(compilation, "Consume", "Producer");
        Assert.NotNull(call);
        AssertIsTaskOfTuple(call.Type);
    }

    [Fact]
    public void AsyncFunc_ReturningTupleWithUserClassElement_AwaitedAndDeconstructed_NoGS0125()
    {
        const string source = @"
package p
class Box { }
async func Producer() (bool, Box) {
    return (true, Box())
}
async func Consume() bool {
    let (ok, x) = await Producer()
    return ok
}
";
        var compilation = Compile(source);
        AssertNoAwaitOrScopeErrors(compilation);
    }

    [Fact]
    public void AsyncFunc_ReturningTupleWithUserInterfaceElement_Awaited_NoGS0133()
    {
        const string source = @"
package p
interface IProfile { func Name() string; }
async func Producer(p IProfile) (bool, IProfile) {
    return (true, p)
}
async func Consume(p IProfile) bool {
    let (ok, prof) = await Producer(p)
    return ok
}
";
        var compilation = Compile(source);
        AssertNoAwaitOrScopeErrors(compilation);

        var call = FindCall(compilation, "Consume", "Producer");
        Assert.NotNull(call);
        AssertIsTaskOfTuple(call.Type);
    }

    [Fact]
    public void AsyncFunc_ReturningTupleWithAllBclElements_StillWrapsAsTask_Regression()
    {
        // A tuple whose elements are all BCL types keeps a resolvable
        // ValueTuple ClrType and never depended on the fix; pin it stays green.
        const string source = @"
package p
async func Producer() (bool, string) {
    return (true, ""s"")
}
async func Consume() bool {
    let (ok, s) = await Producer()
    return ok
}
";
        var compilation = Compile(source);
        AssertNoAwaitOrScopeErrors(compilation);

        var call = FindCall(compilation, "Consume", "Producer");
        Assert.NotNull(call);
        Assert.True(call.Type is ImportedTypeSymbol imported
            && imported.ClrType.IsGenericType
            && imported.ClrType.GetGenericTypeDefinition() == typeof(System.Threading.Tasks.Task<>),
            $"Expected Task[...], got '{call.Type}'.");
    }

    private static void AssertNoAwaitOrScopeErrors(Compilation compilation)
    {
        Assert.DoesNotContain(compilation.BoundProgram.Diagnostics, d => d.Id == "GS0133");
        Assert.DoesNotContain(compilation.BoundProgram.Diagnostics, d => d.Id == "GS0125");
    }

    private static void AssertIsTaskOfTuple(TypeSymbol type)
    {
        Assert.True(type is ImportedTypeSymbol imported
            && imported.ClrType.IsGenericType
            && imported.ClrType.GetGenericTypeDefinition() == typeof(System.Threading.Tasks.Task<>)
            && imported.TypeArguments.Length == 1
            && imported.TypeArguments[0] is TupleTypeSymbol,
            $"Expected Task[(...)] over a tuple, got '{type}'.");
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

    private sealed class CallCollector : BoundTreeWalker
    {
        private readonly string callName;

        public CallCollector(string callName)
        {
            this.callName = callName;
        }

        public System.Collections.Generic.List<BoundCallExpression> Collected { get; } = new();

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
