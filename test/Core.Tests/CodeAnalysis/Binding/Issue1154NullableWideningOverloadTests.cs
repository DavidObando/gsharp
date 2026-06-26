// <copyright file="Issue1154NullableWideningOverloadTests.cs" company="GSharp">
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
/// Issue #1154. Overload resolution must not report a spurious GS0266
/// ambiguity when an argument needs an implicit nullable-widening conversion
/// (T → T?) to match the ONLY applicable candidate while a second, wholly
/// non-applicable overload (e.g. F(string) for a []uint8 argument) also exists.
/// Phase-1 arity/name applicability is convertibility-unaware, so the
/// non-applicable overload used to tie with — and thus be reported ambiguous
/// against — the unique applicable nullable-widening overload. A
/// convertibility-aware filter now excludes non-convertible candidates so the
/// unique applicable overload binds without a diagnostic, while genuine
/// ambiguity and genuine no-applicable-overload cases still report.
/// </summary>
public class Issue1154NullableWideningOverloadTests
{
    [Fact]
    public void Repro_NullableWidening_UniqueApplicable_BindsWithoutGS0266()
    {
        // REPRO: F(string), F(([]uint8)?); arg is non-nullable []uint8.
        // Only F(([]uint8)?) is applicable ([]uint8 -> ([]uint8)? implicit widening).
        const string source = @"
package p
class C {
    shared { func Make() []uint8 { var r []uint8 return r } }
    func F(a string) { F(C.Make()) }
    func F(a ([]uint8)?) { var n = 1 }
}
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "F", "F");
        Assert.NotNull(selected);
        var param = selected.Parameters.Last();
        Assert.IsType<NullableTypeSymbol>(param.Type);
    }

    [Fact]
    public void VariantA_ExactMatch_StillBinds()
    {
        // F(string), F([]uint8); arg []uint8 -> exact match to F([]uint8).
        const string source = @"
package p
class C {
    shared { func Make() []uint8 { var r []uint8 return r } }
    func F(a string) { F(C.Make()) }
    func F(a []uint8) { var n = 1 }
}
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "F", "F");
        Assert.NotNull(selected);
        var param = selected.Parameters.Last();
        Assert.IsNotType<NullableTypeSymbol>(param.Type);
    }

    [Fact]
    public void VariantB_NullableWideningOnly_StillBinds()
    {
        // F(([]uint8)?) only; arg []uint8 -> nullable widening applicable.
        const string source = @"
package p
class C {
    shared { func Make() []uint8 { var r []uint8 return r } }
    func F(a ([]uint8)?) { F(C.Make()) }
}
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "F", "F");
        Assert.NotNull(selected);
        var param = selected.Parameters.Last();
        Assert.IsType<NullableTypeSymbol>(param.Type);
    }

    [Fact]
    public void VariantC_ExactNullableMatch_StillBinds()
    {
        // F(string), F(([]uint8)?); arg is ([]uint8)? -> exact match to T?.
        const string source = @"
package p
class C {
    shared { func Make() ([]uint8)? { var r ([]uint8)? return r } }
    func F(a string) { F(C.Make()) }
    func F(a ([]uint8)?) { var n = 1 }
}
";
        var compilation = Compile(source);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);

        var selected = FindCall(compilation, "F", "F");
        Assert.NotNull(selected);
        var param = selected.Parameters.Last();
        Assert.IsType<NullableTypeSymbol>(param.Type);
    }

    [Fact]
    public void GenuineAmbiguity_StillReportsGS0266()
    {
        // Argument `Both` converts (implicitly) to both IA and IB equally; the
        // two non-generic overloads genuinely tie. Must still report GS0266.
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

    [Fact]
    public void NoApplicableOverload_StillReports_NotGS0266()
    {
        // F(string) only; arg []uint8 -> no applicable overload. Must report a
        // diagnostic (not GS0266, not a crash).
        const string source = @"
package p
class C {
    shared { func Make() []uint8 { var r []uint8 return r } }
    func F(a string) { F(C.Make()) }
}
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree) { IsLibrary = true };
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.NotEmpty(result.Diagnostics);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0266");
    }

    private static Compilation Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return new Compilation(tree) { IsLibrary = true };
    }

    private static FunctionSymbol FindCall(Compilation compilation, string functionName, string callName)
        => FindCalls(compilation, functionName, callName).FirstOrDefault();

    private static List<FunctionSymbol> FindCalls(Compilation compilation, string functionName, string callName)
    {
        var collector = new CallCollector(callName);
        foreach (var body in compilation.BoundProgram.Functions.Values)
        {
            collector.Visit(body);
        }

        return collector.Collected;
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
