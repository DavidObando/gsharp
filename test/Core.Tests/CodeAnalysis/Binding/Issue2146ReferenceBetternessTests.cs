// <copyright file="Issue2146ReferenceBetternessTests.cs" company="GSharp">
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
/// Issue #2146: overload resolution's "better function member" pass now applies
/// the C# §7.5.3.4 "better conversion target" rule for REFERENCE types, not just
/// numeric ones. When an argument's static type is a proper subtype of BOTH
/// candidate parameter types (so both argument→parameter conversions are
/// non-identity implicit reference conversions), the more-derived parameter type
/// wins instead of the call being reported ambiguous (GS0266). Genuinely
/// unrelated reference targets still tie and report GS0266.
/// </summary>
public class Issue2146ReferenceBetternessTests
{
    [Fact]
    public void ObjectVsUserBaseClass_DerivedArgument_PrefersBaseClassOverload()
    {
        // U(object) vs U(Animal) called with a Dog argument: Dog->object and
        // Dog->Animal are both non-identity implicit reference conversions, so
        // they tie on conversion kind. Animal is the better conversion target
        // (Animal->object is implicit, object->Animal is not), so U(Animal) must
        // win. Before the fix this reported a spurious GS0266.
        const string source = @"
package p
open class Issue2146Animal {}
class Issue2146Dog : Issue2146Animal {}
func Issue2146U(x object) int32 -> 1
func Issue2146U(x Issue2146Animal) int32 -> 2
func Issue2146Use(d Issue2146Dog) int32 -> Issue2146U(d)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "Issue2146U");
        Assert.NotNull(selected);
        Assert.Equal("Issue2146Animal", selected.Parameters[0].Type.Name);
    }

    [Fact]
    public void IdentityArgument_StillWinsOverObject()
    {
        // Control (already-working case): U(object) vs U(Animal) called with an
        // Animal argument. Animal->Animal is IDENTITY, which beats the
        // Animal->object reference conversion, so U(Animal) resolves without any
        // reference tie-break needing to run.
        const string source = @"
package p
open class Issue2146AnimalId {}
func Issue2146UId(x object) int32 -> 1
func Issue2146UId(x Issue2146AnimalId) int32 -> 2
func Issue2146UseId(a Issue2146AnimalId) int32 -> Issue2146UId(a)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "Issue2146UId");
        Assert.NotNull(selected);
        Assert.Equal("Issue2146AnimalId", selected.Parameters[0].Type.Name);
    }

    [Fact]
    public void ThreeLevelHierarchy_PrefersMostDerivedApplicableTarget()
    {
        // U(object) vs U(Animal) with a Dog argument where Dog : Animal : object.
        // The more-derived applicable target (Animal) must win over object.
        const string source = @"
package p
open class Issue2146Base {}
open class Issue2146Mid : Issue2146Base {}
class Issue2146Leaf : Issue2146Mid {}
func Issue2146H(x Issue2146Base) int32 -> 1
func Issue2146H(x Issue2146Mid) int32 -> 2
func Issue2146HUse(leaf Issue2146Leaf) int32 -> Issue2146H(leaf)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "Issue2146H");
        Assert.NotNull(selected);
        Assert.Equal("Issue2146Mid", selected.Parameters[0].Type.Name);
    }

    [Fact]
    public void ObjectVsImportedNullableType_TypeofArgument_PrefersTypeOverload()
    {
        // The real-world Oahu case: Log(object) vs Log(Type?) with a typeof(...)
        // argument. Type->object and Type->Type? are both non-identity implicit
        // reference/nullable conversions; Type? is the better (more-derived)
        // target, so Log(Type?) must win instead of GS0266.
        const string source = @"
package p
import System
class Issue2146LogC {}
func Issue2146L(caller object) int32 -> 1
func Issue2146L(caller Type?) int32 -> 2
func Issue2146LUse() int32 -> Issue2146L(typeof(Issue2146LogC))
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "Issue2146L");
        Assert.NotNull(selected);
        Assert.NotEqual("object", selected.Parameters[0].Type.Name);
    }

    [Fact]
    public void UnrelatedReferenceTargets_StillReportsAmbiguity()
    {
        // Guard against over-fixing: two UNRELATED interface parameter types,
        // both satisfied by the argument, with neither convertible to the other.
        // This is a genuine ambiguity and must still report GS0266.
        const string source = @"
package p
interface Issue2146IA {}
interface Issue2146IB {}
class Issue2146Both : Issue2146IA, Issue2146IB {}
func Issue2146A(x Issue2146IA) int32 -> 1
func Issue2146A(x Issue2146IB) int32 -> 2
func Issue2146AUse(b Issue2146Both) int32 -> Issue2146A(b)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0266");
    }

    [Fact]
    public void ObjectVsInterface_ImplementingArgument_PrefersInterfaceOverload()
    {
        // U(object) vs U(IShape) with an argument that implements IShape. Both
        // conversions are non-identity implicit reference conversions; IShape is
        // the more-derived (more specific) target versus object, so U(IShape)
        // must win rather than tie at GS0266.
        const string source = @"
package p
interface Issue2146IShape {}
class Issue2146Square : Issue2146IShape {}
func Issue2146S(x object) int32 -> 1
func Issue2146S(x Issue2146IShape) int32 -> 2
func Issue2146SUse(sq Issue2146Square) int32 -> Issue2146S(sq)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "Issue2146S");
        Assert.NotNull(selected);
        Assert.Equal("Issue2146IShape", selected.Parameters[0].Type.Name);
    }

    private static Compilation Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return new Compilation(tree) { IsLibrary = true };
    }

    private static FunctionSymbol FindCall(Compilation compilation, string callName)
    {
        var collector = new CallCollector(callName);
        foreach (var body in compilation.BoundProgram.Functions.Values)
        {
            collector.Visit(body);
        }

        return collector.Collected.FirstOrDefault();
    }

    private sealed class CallCollector : GSharp.Core.CodeAnalysis.Binding.BoundTreeWalker
    {
        private readonly string callName;

        public CallCollector(string callName)
        {
            this.callName = callName;
        }

        public List<FunctionSymbol> Collected { get; } = new();

        public override void VisitExpression(GSharp.Core.CodeAnalysis.Binding.BoundExpression node)
        {
            switch (node)
            {
                case GSharp.Core.CodeAnalysis.Binding.BoundCallExpression call when call.Function.Name == callName:
                    Collected.Add(call.Function);
                    break;
                case GSharp.Core.CodeAnalysis.Binding.BoundUserInstanceCallExpression instanceCall when instanceCall.Method.Name == callName:
                    Collected.Add(instanceCall.Method);
                    break;
            }

            base.VisitExpression(node);
        }
    }
}
