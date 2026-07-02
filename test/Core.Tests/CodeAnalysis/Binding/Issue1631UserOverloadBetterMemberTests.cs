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
    public void VariadicElementIdentity_BeatsNormalFormWidening()
    {
        // B1' regression: per C# §7.5.3.2, "prefer non-expanded form" is a
        // LATE tie-break applied only when per-arg betterness is otherwise
        // tied — it must not override a genuine per-arg conversion-kind
        // difference. Here arg2 (int32) widens to int64 on the normal-form
        // overload but matches the params element type (int32) exactly on
        // the variadic overload, so per-arg betterness picks the variadic
        // form (matching Roslyn: F(1, 2) with F(int,long) and
        // F(int, params int[]) binds the params overload).
        const string source = @"
package p
func Issue1631VarWF(x int32, y int64) int32 -> 1
func Issue1631VarWF(x int32, rest ...int32) int32 -> 2
func Issue1631VarWUse() int32 -> Issue1631VarWF(1, 2)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "Issue1631VarWF");
        Assert.NotNull(selected);
        Assert.Equal(2, selected.Parameters.Length);
        Assert.True(selected.Parameters[1].IsVariadic);
    }

    [Fact]
    public void BothFormsIdenticalPerArg_PrefersNormalFormAsTieBreak()
    {
        // Locks in the true §7.5.3.2 tie-break: when every argument is
        // Identity on BOTH the normal-form and variadic candidates (no
        // widening anywhere to decide the arg comparisons), Phase 2c's
        // "prefer non-variadic" rule is what picks the normal form.
        const string source = @"
package p
func Issue1631VarTieF(x int32, y int32) int32 -> 1
func Issue1631VarTieF(x int32, rest ...int32) int32 -> 2
func Issue1631VarTieUse() int32 -> Issue1631VarTieF(1, 2)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "Issue1631VarTieF");
        Assert.NotNull(selected);
        Assert.Equal(2, selected.Parameters.Length);
        Assert.False(selected.Parameters[1].IsVariadic);
    }

    [Fact]
    public void Variadic_SelectedWhenSoleApplicable()
    {
        // A variadic overload must still win when it is the only candidate
        // whose arity accepts the call (a sibling with fewer fixed params
        // that cannot take 3 arguments is not applicable at all).
        const string source = @"
package p
func Issue1631VarSoleF(x int32, y int32) int32 -> 1
func Issue1631VarSoleF(x int32, rest ...int32) int32 -> 2
func Issue1631VarSoleUse() int32 -> Issue1631VarSoleF(1, 2, 3)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "Issue1631VarSoleF");
        Assert.NotNull(selected);
        Assert.True(selected.Parameters[selected.Parameters.Length - 1].IsVariadic);
    }

    [Fact]
    public void TwoVariadic_ElementTypeBettemessStillDecides()
    {
        // Between two variadic candidates (both expanded form), the params
        // element-type conversion kind must still decide genuine betterness.
        const string source = @"
package p
func Issue1631VarVsVarF(x int32, rest ...int32) int32 -> 1
func Issue1631VarVsVarF(x int32, rest ...int64) int32 -> 2
func Issue1631VarVsVarUse() int32 -> Issue1631VarVsVarF(1, 2)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "Issue1631VarVsVarF");
        Assert.NotNull(selected);
        var tail = selected.Parameters[selected.Parameters.Length - 1];
        Assert.True(tail.IsVariadic);
        Assert.Equal(TypeSymbol.Int32, ((SliceTypeSymbol)tail.Type).ElementType);
    }

    [Fact]
    public void NamedArgument_DominationUsesMappedSlot()
    {
        // S1: named arguments reorder the source-order -> parameter-slot
        // mapping (#1628). Domination must rank each argument against its
        // REAL slot, not its source position: here `b` (an int32 constant)
        // binds against an int32 parameter on overload 1 (identity) and an
        // int64 parameter on overload 2 (widening), while `a` ties on both —
        // overload 1 must win even though it is named second at the call site.
        const string source = @"
package p
func Issue1631NamedF(a int32, b int32) int32 -> 1
func Issue1631NamedF(a int32, b int64) int32 -> 2
func Issue1631NamedUse() int32 -> Issue1631NamedF(b: 2, a: 1)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "Issue1631NamedF");
        Assert.NotNull(selected);
        Assert.Equal(TypeSymbol.Int32, selected.Parameters[1].Type);
    }

    [Fact]
    public void PerArgumentPairwiseTie_ReportsAmbiguity()
    {
        // S2: each candidate is strictly better on a DIFFERENT argument, so
        // neither dominates the other under §7.5.3.2 pairwise comparison —
        // a genuine GS0266 must be reported.
        const string source = @"
package p
func Issue1631PairF(a int32, b int64) int32 -> 1
func Issue1631PairF(a int64, b int32) int32 -> 2
func Issue1631PairUse(x int32, y int32) int32 -> Issue1631PairF(x, y)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0266");
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
