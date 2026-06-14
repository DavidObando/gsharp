// <copyright file="VariadicTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
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
/// Phase 4.8 — variadic parameters (<c>func f(xs ...T)</c>). Inside the
/// body the parameter has type <c>[]T</c>; at call sites trailing
/// arguments are packed into a slice. Interpreter-only for now.
/// </summary>
public class VariadicTests
{
    [Fact]
    public void Variadic_PacksTrailingArgs_IntoSlice()
    {
        var result = Evaluate(@"
func sum(nums ...int32) int32 {
    var total = 0
    for var i = 0; i < len(nums); i++ {
        total = total + nums[i]
    }
    return total
}
sum(1, 2, 3, 4)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void Variadic_AcceptsZeroTrailingArgs_EmptySlice()
    {
        var result = Evaluate(@"
func count(xs ...int32) int32 { return len(xs) }
count()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void Variadic_WithFixedParametersBefore()
    {
        var result = Evaluate(@"
func joinWith(sep string, parts ...string) string {
    var s = """"
    for var i = 0; i < len(parts); i++ {
        if i > 0 { s = s + sep }
        s = s + parts[i]
    }
    return s
}
joinWith("", "", ""a"", ""b"", ""c"")
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("a, b, c", result.Value);
    }

    [Fact]
    public void Variadic_TooFewFixedArgs_ReportsDiagnostic()
    {
        var result = Evaluate(@"
func joinWith(sep string, parts ...string) string { return sep }
joinWith()
");
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Variadic_WrongElementType_ReportsDiagnostic()
    {
        var result = Evaluate(@"
func sum(nums ...int32) int32 { return 0 }
sum(1, ""x"", 3)
");
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Variadic_NotLastParameter_ReportsDiagnostic()
    {
        var result = Evaluate(@"
func bad(xs ...int32, n int32) int32 { return n }
bad(1, 2)
");
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Variadic_OnLambda_BodySeesSlice()
    {
        // ADR-0102 / issue #812: the binder accepts a variadic parameter on
        // a function-literal lambda; inside the body the name has type
        // <c>[]T</c>. Sanity test: bind a plain non-variadic baseline first,
        // then the variadic spelling, asserting both bind without
        // diagnostics. (Indirect call evaluation through the synthetic
        // FunctionTypeSymbol does not preserve IsVariadic by design — see
        // ADR-0102 §5 — so packing semantics are exercised in the emit
        // tests, not here.)
        var result = Evaluate(@"
let f = func(xs ...int32) int32 { return len(xs) }
");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Variadic_OnArrowLambda_BodySeesSlice()
    {
        // ADR-0102 §3 — arrow-lambda variant.
        var result = Evaluate(@"
let count = (xs ...int32) -> len(xs)
count([]int32{10, 20, 30})
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    // ADR-0102 / issue #812 — variadic on class instance methods.

    [Fact]
    public void Variadic_OnClassInstanceMethod_PacksTrailingArgs()
    {
        var result = Evaluate(@"
class Joiner {
    func Sum(nums ...int32) int32 {
        var total = 0
        for var i = 0; i < len(nums); i++ { total = total + nums[i] }
        return total
    }
}
var j = Joiner()
j.Sum(1, 2, 3, 4)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void Variadic_OnClassInstanceMethod_PassThroughSlice()
    {
        var result = Evaluate(@"
class Joiner {
    func Count(nums ...int32) int32 { return len(nums) }
}
var j = Joiner()
j.Count([]int32{1, 2, 3})
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void Variadic_OnClassInstanceMethod_EmptyCall_ProducesEmptySlice()
    {
        var result = Evaluate(@"
class Joiner {
    func Count(nums ...int32) int32 { return len(nums) }
}
var j = Joiner()
j.Count()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    // ADR-0102 / issue #812 — variadic on a class static (shared) method.

    [Fact]
    public void Variadic_OnSharedStaticMethod_PacksTrailingArgs()
    {
        var result = Evaluate(@"
class Sequences {
    shared {
        func Of[T](values ...T) []T { return values }
    }
}
let xs = Sequences.Of(1, 2, 3)
len(xs)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void Variadic_OnSharedStaticMethod_SingleArrayPassesThrough()
    {
        var result = Evaluate(@"
class Sequences {
    shared {
        func Of[T](values ...T) []T { return values }
    }
}
let arr = []int32{10, 20, 30}
let xs = Sequences.Of(arr)
xs[1]
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(20, result.Value);
    }

    [Fact]
    public void Variadic_OnSharedStaticMethod_EmptyCall_ProducesEmptySlice()
    {
        var result = Evaluate(@"
class Sequences {
    shared {
        func Of[T](values ...T) []T { return values }
    }
}
let xs = Sequences.Of[int32]()
len(xs)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    // ADR-0102 / issue #812 — variadic on an interface default-body method
    // (ADR-0085). The default body must see the parameter as <c>[]T</c>.

    [Fact]
    public void Variadic_OnInterfaceDefaultBody_PacksTrailingArgs()
    {
        var result = Evaluate(@"
interface IAdder {
    func Add(nums ...int32) int32 {
        var total = 0
        for var i = 0; i < len(nums); i++ { total = total + nums[i] }
        return total
    }
}
class Adder : IAdder {}
var a = Adder()
a.Add(1, 2, 3, 4)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void Variadic_OnInterfaceDefaultBody_EmptyCall()
    {
        var result = Evaluate(@"
interface IAdder {
    func Add(nums ...int32) int32 { return len(nums) }
}
class Adder : IAdder {}
var a = Adder()
a.Add()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    // ADR-0102 / issue #812 — variadic on a constructor (init block).

    [Fact]
    public void Variadic_OnConstructor_PacksTrailingArgs()
    {
        var result = Evaluate(@"
class Tags {
    var Values []string
    init(vs ...string) {
        Values = vs
    }
}
var t = Tags(""a"", ""b"", ""c"")
len(t.Values)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void Variadic_OnConstructor_PassThroughAndEmpty()
    {
        var result = Evaluate(@"
class Tags {
    var Values []string
    init(vs ...string) {
        Values = vs
    }
}
var t = Tags([]string{""x"", ""y""})
len(t.Values)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    // ADR-0102 / issue #812 — variadic on a named delegate type. Both the
    // direct-call form `d(args)` and the explicit `d.Invoke(args)` member
    // form must pack / pass-through trailing arguments. The interpreter
    // does not provide a runtime for named delegates (ADR-0059), so the
    // binder-only check asserts the declaration + call site bind without
    // diagnostics; the runtime semantics are covered by the emit tests
    // (VariadicEmitTests.Variadic_OnNamedDelegate_*).

    [Fact]
    public void Variadic_OnNamedDelegate_DirectCall_Binds()
    {
        var diagnostics = Bind(@"
package P
type Adder = delegate func(nums ...int32) int32
var d Adder = func(nums ...int32) int32 { return 0 }
let r = d(1, 2, 3, 4)
");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Variadic_OnNamedDelegate_InvokeForm_Binds()
    {
        var diagnostics = Bind(@"
package P
type Adder = delegate func(nums ...int32) int32
var d Adder = func(nums ...int32) int32 { return 0 }
let r = d.Invoke(1, 2, 3, 4)
");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Variadic_OnNamedDelegate_SingleArrayPassesThrough_Binds()
    {
        var diagnostics = Bind(@"
package P
type Counter = delegate func(nums ...int32) int32
var d Counter = func(nums ...int32) int32 { return 0 }
let r = d([]int32{1, 2, 3})
");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Variadic_OnNamedDelegate_EmptyCall_Binds()
    {
        var diagnostics = Bind(@"
package P
type Counter = delegate func(nums ...int32) int32
var d Counter = func(nums ...int32) int32 { return 0 }
let r = d()
");
        Assert.Empty(diagnostics);
    }

    // ADR-0101 / issue #799 — issue repro: `Sequences.Of`-shaped generic
    // variadic. Declared in source as `func Of[T](values ...T) []T` so the
    // test exercises every branch (multi-arg pack, single-array pass-through,
    // empty pack) without depending on the C#-authored helper.

    [Fact]
    public void Variadic_Generic_PacksTrailingArgs()
    {
        var result = Evaluate(@"
func Of[T](values ...T) []T { return values }
let xs = Of(1, 2, 3)
len(xs)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void Variadic_Generic_SingleArrayPassesThrough()
    {
        // Issue #799 §3 (call-site semantics): when the caller supplies a
        // single trailing argument already typed `[]T`, it must be passed
        // through as-is — no double-wrap.
        var result = Evaluate(@"
func Of[T](values ...T) []T { return values }
let arr = []int32{10, 20, 30}
let xs = Of(arr)
len(xs)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void Variadic_Generic_EmptyCall_ProducesEmptySlice()
    {
        var result = Evaluate(@"
func Of[T](values ...T) []T { return values }
let xs = Of[int32]()
len(xs)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void Variadic_Generic_PassThrough_PreservesIdentity()
    {
        // The pass-through path means the body sees the SAME array the
        // caller supplied — index 1 of the returned slice equals the
        // value the caller stored at index 1 of the input.
        var result = Evaluate(@"
func Of[T](values ...T) []T { return values }
let arr = []int32{100, 200, 300}
let xs = Of(arr)
xs[1]
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(200, result.Value);
    }

    [Fact]
    public void Variadic_MultipleVariadicParameters_Diagnostic()
    {
        // ADR-0101 / issue #799: at most one variadic param per signature.
        var result = Evaluate(@"
func bad(xs ...int32, ys ...int32) int32 { return 0 }
bad(1)
");
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0364");
    }

    [Fact]
    public void Variadic_ParamsKeyword_Rejected()
    {
        // ADR-0101 / issue #799: the C# `params` keyword is intentionally
        // not part of the G# grammar. The parser flags the spelling
        // and points the user at the canonical `...T` form.
        var result = Evaluate(@"
func bad(params values []int32) int32 { return 0 }
bad()
");
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0363");
    }

    private static EvaluationResult Evaluate(string source)
    {
        // ADR-0083 / issue #723: prepend the Go extensions import so the
        // `len(...)` calls inside variadic-helper test sources keep
        // binding rather than tripping the GS0317 gate. The unused import
        // is silent when a test happens not to call any gated built-in.
        var syntaxTree = SyntaxTree.Parse(SourceText.From("import Gsharp.Extensions.Go\n" + source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        // Bind-only helper for sites the interpreter does not run (e.g.
        // named delegates, which have no runtime in the AST evaluator).
        // Mirrors NamedDelegateBindingTests.Bind.
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any())
        {
            return tree.Diagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }
}
