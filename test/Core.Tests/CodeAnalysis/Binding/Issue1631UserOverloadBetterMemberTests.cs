// <copyright file="Issue1631UserOverloadBetterMemberTests.cs" company="GSharp">
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
/// Issue #1631: user-declared (non-imported) overload resolution now follows
/// the C#-faithful "better function member" pairwise domination rules
/// (§7.5.3.2), reusing the same <c>ImplicitConversionKind</c> ranking and
/// numeric "better conversion target" tie-break the CLR-reflection resolver
/// (<c>OverloadResolution</c>) applies to imported-method overloads — instead
/// of the previous ad-hoc linear score under which two candidates that both
/// needed an implicit conversion tied at score 0 regardless of which
/// conversion C# actually prefers.
/// </summary>
public class Issue1631UserOverloadBetterMemberTests
{
    [Fact]
    public void NumericWidening_PrefersLongOverFloat_FromIntArgument()
    {
        // Repro from the issue: F(int64) / F(float64) called with an int32
        // constant. int32 -> int64 and int32 -> float64 are both implicit
        // widenings, but int64 is the "smaller"/closer numeric target
        // (int64 -> float64 is implicit, float64 -> int64 is not), so C#
        // picks F(int64). The previous ad-hoc score tied both at 0 and
        // reported a spurious GS0266.
        const string source = @"
package p
func Issue1631NwF(x int64) int32 -> 1
func Issue1631NwF(x float64) int32 -> 2
func Issue1631NwUse() int32 -> Issue1631NwF(5)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "Issue1631NwF");
        Assert.NotNull(selected);
        Assert.Equal(TypeSymbol.Int64, selected.Parameters[0].Type);
    }

    [Fact]
    public void NumericWidening_PrefersIntOverDouble_WideningChain()
    {
        // From an int16 argument: int16 -> int32 and int32 -> float64 are
        // both implicit, so int32 is the better ("closer") target than
        // float64.
        const string source = @"
package p
func Issue1631ChF(x int32) int32 -> 1
func Issue1631ChF(x float64) int32 -> 2
func Issue1631ChUse(n int16) int32 -> Issue1631ChF(n)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "Issue1631ChF");
        Assert.NotNull(selected);
        Assert.Equal(TypeSymbol.Int32, selected.Parameters[0].Type);
    }

    [Fact]
    public void GenuineAmbiguity_NeitherNumericTargetDominates_ReportsGS0266()
    {
        // From an int32 argument, neither float32 -> decimal nor
        // decimal -> float32 is implicit, and neither appears in the signed-
        // vs-unsigned table, so the two widenings genuinely tie and a real
        // GS0266 must still be reported (not silently resolved).
        const string source = @"
package p
func Issue1631AmbF(x float32) int32 -> 1
func Issue1631AmbF(x decimal) int32 -> 2
func Issue1631AmbUse(n int32) int32 -> Issue1631AmbF(n)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0266");
    }

    [Fact]
    public void NonGenericOverGeneric_TieBreak()
    {
        // A non-generic overload beats a generic one when both apply
        // identically (C# §7.5.3.2: "If MP is a non-generic method and MQ is
        // a generic method, then MP is better than MQ.").
        const string source = @"
package p
func Issue1631GenF[T](x T) int32 -> 1
func Issue1631GenF(x string) int32 -> 2
func Issue1631GenUse(s string) int32 -> Issue1631GenF(s)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "Issue1631GenF");
        Assert.NotNull(selected);
        Assert.False(selected.IsGeneric);
    }

    [Fact]
    public void ParamsExpanded_PrefersNormalFormOverVariadic()
    {
        // A non-variadic (normal-form) overload beats a variadic (expanded
        // params) overload when both apply to the same call, matching C#'s
        // preference for the normal form over the expanded form.
        const string source = @"
package p
func Issue1631VarF(x int32, y int32) int32 -> 1
func Issue1631VarF(x int32, rest ...int32) int32 -> 2
func Issue1631VarUse() int32 -> Issue1631VarF(1, 2)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "Issue1631VarF");
        Assert.NotNull(selected);
        Assert.Equal(2, selected.Parameters.Length);
        Assert.False(selected.Parameters[selected.Parameters.Length - 1].IsVariadic);
    }

    [Fact]
    public void IdentityStillBeatsWidening()
    {
        // Control: an exact-type match still wins over any widening
        // candidate, exactly as before this fix.
        const string source = @"
package p
func Issue1631IdF(x int32) int32 -> 1
func Issue1631IdF(x int64) int32 -> 2
func Issue1631IdUse(n int32) int32 -> Issue1631IdF(n)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "Issue1631IdF");
        Assert.NotNull(selected);
        Assert.Equal(TypeSymbol.Int32, selected.Parameters[0].Type);
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
