// <copyright file="Issue1552NullableArgOverloadTests.cs" company="GSharp">
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
/// Issue #1552. When a nullable REFERENCE argument <c>S?</c> is passed to an
/// overload SET, overload resolution must do the null-safe thing rather than
/// report a spurious GS0266 ambiguity (which ignored the <c>?</c> wrapper):
///
/// <list type="bullet">
/// <item>If a null-tolerant overload exists (a parameter typed <c>object</c>/
/// <c>object?</c> or itself nullable), it is selected — a nullable reference is
/// a valid value there.</item>
/// <item>If EVERY surviving overload wants a non-nullable, non-<c>object</c>
/// reference parameter, the call reports the SAME GS0154 the single-candidate
/// path already emits, prompting the user to write <c>!!</c> (or narrow).</item>
/// </list>
///
/// Crucially this PRESERVES G#'s Kotlin-model null safety: <c>T? -&gt; T</c>
/// (reference) is NOT made implicit anywhere. The abandoned PR #1553 silenced
/// GS0154/GS0155 by making that conversion implicit language-wide; this fix does
/// not — the null-safety diagnostic is retained, only re-routed away from the
/// spurious ambiguity. Every user type below uses an <c>Issue1552</c>-unique
/// name because the in-process FunctionTypeSymbol cache is not cleared between
/// tests.
/// </summary>
public class Issue1552NullableArgOverloadTests
{
    [Fact]
    public void AOverload_NullableImportedType_SelectsObjectOverload_NoDiagnostics()
    {
        // Repro (a): imported base/derived (object / System.Type). A nullable
        // `Type?` argument must cleanly select F(object) — object is null-
        // tolerant — with NO GS0266 and no error.
        const string source = @"
package p
import System
func Issue1552AF(caller object) int32 -> 1
func Issue1552AF(caller Type) int32 -> 2
func Issue1552AUseNull(t Type?) int32 -> Issue1552AF(t)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "Issue1552AF");
        Assert.NotNull(selected);
        Assert.Equal(TypeSymbol.Object, selected.Parameters[0].Type);
    }

    [Fact]
    public void AOverload_NonNullableImportedType_StillSelectsDerivedOverload()
    {
        // Control: a NON-nullable `Type` argument still selects F(Type) — the
        // gate never fires for a non-nullable argument.
        const string source = @"
package p
import System
func Issue1552NnF(caller object) int32 -> 1
func Issue1552NnF(caller Type) int32 -> 2
func Issue1552NnUse(t Type) int32 -> Issue1552NnF(t)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "Issue1552NnF");
        Assert.NotNull(selected);
        Assert.NotEqual(TypeSymbol.Object, selected.Parameters[0].Type);
        Assert.Equal(typeof(System.Type), selected.Parameters[0].Type.ClrType);
    }

    [Fact]
    public void CUser_NullableUserDerived_ReportsGS0154_NotGS0266()
    {
        // Repro (c): only non-nullable-reference overloads (no object overload).
        // A nullable `Issue1552CDog?` argument must report GS0154 (the same
        // null-safety diagnostic the single-candidate path emits) — NOT GS0266,
        // NOT a generic no-applicable-overload.
        const string source = @"
package p
open class Issue1552CAnimal {}
class Issue1552CDog : Issue1552CAnimal {}
func Issue1552CG(a Issue1552CAnimal) int32 -> 1
func Issue1552CG(d Issue1552CDog) int32 -> 2
func Issue1552CUse(d Issue1552CDog?) int32 -> Issue1552CG(d)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        var gs0154 = Assert.Single(result.Diagnostics, d => d.Id == "GS0154");
        Assert.Contains("Issue1552CAnimal", gs0154.Message);
        Assert.Contains("Issue1552CDog?", gs0154.Message);
    }

    [Fact]
    public void CUser_SingleCandidate_AlsoReportsGS0154_Analog()
    {
        // The single-candidate analog of repro (c) already reports GS0154 today;
        // the overload case above must MATCH it (same diagnostic id).
        const string source = @"
package p
open class Issue1552SAnimal {}
class Issue1552SDog : Issue1552SAnimal {}
func Issue1552SSink(a Issue1552SAnimal) int32 -> 1
func Issue1552SUse(d Issue1552SDog?) int32 -> Issue1552SSink(d)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0154");
    }

    [Fact]
    public void CUser_BangEscape_Compiles_SelectsDerivedOverload()
    {
        // The `!!` escape hatch narrows `Dog?` to `Dog`, so the gate never fires
        // and the derived overload G(Dog) is selected.
        const string source = @"
package p
open class Issue1552BAnimal {}
class Issue1552BDog : Issue1552BAnimal {}
func Issue1552BG(a Issue1552BAnimal) int32 -> 1
func Issue1552BG(d Issue1552BDog) int32 -> 2
func Issue1552BUse(d Issue1552BDog?) int32 -> Issue1552BG(d!!)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "Issue1552BG");
        Assert.NotNull(selected);
        Assert.Equal("Issue1552BDog", selected.Parameters[0].Type.Name);
    }

    [Fact]
    public void NonNullableUserArg_StillSelectsDerivedOverload()
    {
        // Control: a non-nullable `Dog{}` argument still selects G(Dog).
        const string source = @"
package p
open class Issue1552NAnimal {}
class Issue1552NDog : Issue1552NAnimal {}
func Issue1552NG(a Issue1552NAnimal) int32 -> 1
func Issue1552NG(d Issue1552NDog) int32 -> 2
func Issue1552NUse() int32 -> Issue1552NG(Issue1552NDog{})
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "Issue1552NG");
        Assert.NotNull(selected);
        Assert.Equal("Issue1552NDog", selected.Parameters[0].Type.Name);
    }

    [Fact]
    public void NullableParameterOverload_StillApplies_ForNullableRefArg()
    {
        // A null-tolerant nullable-parameter overload accepts the nullable-ref
        // argument (S? -> S? / base-S?). No GS0154, no GS0266.
        const string source = @"
package p
open class Issue1552PAnimal {}
class Issue1552PDog : Issue1552PAnimal {}
func Issue1552PG(a Issue1552PAnimal?) int32 -> 1
func Issue1552PG(s string) int32 -> 2
func Issue1552PUse(d Issue1552PDog?) int32 -> Issue1552PG(d)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "Issue1552PG");
        Assert.NotNull(selected);
        Assert.IsType<NullableTypeSymbol>(selected.Parameters[0].Type);
    }

    [Fact]
    public void ValueTypeNullable_Unaffected_ByGate()
    {
        // The gate must NOT touch value-type nullables. `int32?` still lifts /
        // widens through the normal conversion lattice; here it selects the
        // lifted-widening `int64?` overload with no null-safety GS0154.
        const string source = @"
package p
func Issue1552VG(a int64?) int32 -> 1
func Issue1552VG(a string) int32 -> 2
func Issue1552VUse(n int32?) int32 -> Issue1552VG(n)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0154");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "Issue1552VG");
        Assert.NotNull(selected);
        Assert.IsType<NullableTypeSymbol>(selected.Parameters[0].Type);
    }

    [Fact]
    public void GenuineAmbiguity_StillReportsGS0266()
    {
        // Two unrelated interfaces both satisfied by the argument genuinely tie.
        // The nullable-reference gate does not fire (both params are null-
        // tolerant only via nullable form? no — they are non-nullable
        // interfaces, but the argument is non-nullable `Both`), so this remains
        // a real ambiguity => GS0266.
        const string source = @"
package p
interface Issue1552IA {}
interface Issue1552IB {}
class Issue1552Both : Issue1552IA, Issue1552IB {}
func Issue1552AmbTake(x Issue1552IA) int32 -> 1
func Issue1552AmbTake(x Issue1552IB) int32 -> 2
func Issue1552AmbUse(b Issue1552Both) int32 -> Issue1552AmbTake(b)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0266");
    }

    [Fact]
    public void DeeperChain_GrandbaseBaseDerived_NullableDerived_ReportsGS0154()
    {
        // Generality: any base/derived depth. A `Derived?` argument against
        // overloads on Grandbase and Base (no object overload) reports GS0154.
        const string source = @"
package p
open class Issue1552DGrand {}
open class Issue1552DBase : Issue1552DGrand {}
class Issue1552DDerived : Issue1552DBase {}
func Issue1552DG(a Issue1552DGrand) int32 -> 1
func Issue1552DG(b Issue1552DBase) int32 -> 2
func Issue1552DUse(d Issue1552DDerived?) int32 -> Issue1552DG(d)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        var gs0154 = Assert.Single(result.Diagnostics, d => d.Id == "GS0154");
        Assert.Contains("Issue1552DDerived?", gs0154.Message);
    }

    [Fact]
    public void DeeperChain_NullableDerived_ToObject_SelectsObject()
    {
        // Generality: with a null-tolerant object overload present, a deep-chain
        // nullable IMPORTED argument (ArgumentException : ... : Exception)
        // selects object cleanly (imported reference types have a live ClrType,
        // so S? -> object is a genuine implicit box/upcast). The non-object
        // Exception overload is dropped by the null-safety gate.
        const string source = @"
package p
import System
func Issue1552OG(a object) int32 -> 1
func Issue1552OG(b Exception) int32 -> 2
func Issue1552OUse(d ArgumentException?) int32 -> Issue1552OG(d)
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "Issue1552OG");
        Assert.NotNull(selected);
        Assert.Equal(TypeSymbol.Object, selected.Parameters[0].Type);
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

    private sealed class CallCollector : BoundTreeWalker
    {
        private readonly string callName;

        public CallCollector(string callName)
        {
            this.callName = callName;
        }

        public List<FunctionSymbol> Collected { get; } = new();

        public override void VisitExpression(BoundExpression node)
        {
            switch (node)
            {
                case BoundCallExpression call when call.Function.Name == callName:
                    Collected.Add(call.Function);
                    break;
                case BoundUserInstanceCallExpression instanceCall when instanceCall.Method.Name == callName:
                    Collected.Add(instanceCall.Method);
                    break;
            }

            base.VisitExpression(node);
        }
    }
}
