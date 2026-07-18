// <copyright file="Issue2442ClosureCallableNarrowingBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0069 amendment / issue #2442 — a nil-guard's smart-cast narrowing on a
/// <em>read-only, plain-variable</em> binding (a <c>let</c> local or a
/// by-value/<c>in</c> function parameter) now survives into a captured
/// lambda or local-function body, instead of being unconditionally cleared
/// the way every other narrowing (mutable <c>var</c> locals, <c>ref</c>/
/// <c>out</c> parameters, member-access paths) still is.
/// </summary>
/// <remarks>
/// The bug's original fingerprint (Oahu's <c>DownloadDecryptJob</c>) is a
/// nullable, <em>named</em> G# delegate type
/// (<c>type X = delegate func(...) ...</c>) invoked via direct call syntax
/// inside <c>Task.Run(() -&gt; ...)</c>. A bare native G# arrow function type
/// (<c>(...) -&gt; ...)?</c>) or an imported CLR generic delegate
/// (<c>System.Func&lt;...&gt;</c>/<c>Action&lt;...&gt;</c>) both erase to a
/// real CLR delegate <see cref="System.Type"/> at the
/// <c>NullableTypeSymbol</c>/<c>FunctionTypeSymbol</c> level, so
/// <c>OverloadResolver.CallBinding</c>'s "ClrType is a delegate type"
/// fallback binds the call successfully whether or not any narrowing is in
/// scope — a separate, pre-existing quirk this issue does not change. Only a
/// same-compilation <c>DelegateTypeSymbol</c> reaches the
/// narrowing-dependent branch and therefore reproduces the reported GS0131.
/// Both shapes are covered below: the named-delegate cases prove the fix,
/// the bare-function-type/CLR-delegate cases are regression coverage.
/// </remarks>
public class Issue2442ClosureCallableNarrowingBinderTests
{
    private const string NamedDelegate = "type ConvertFunc = delegate func(data []uint8) []uint8\n";

    // ---- Positive: the exact reported shape -------------------------------

    [Fact]
    public void DownloadDecryptJobShape_NamedDelegateField_NarrowsInsideTaskRunClosure()
    {
        var result = Evaluate(@"
import System
import System.Collections.Generic
import System.Threading.Tasks
" + NamedDelegate + @"
class DownloadDecryptJob {
    var runningTasks List[Task] = List[Task]()

    func Convert(data []uint8, convertAction ConvertFunc?) {
        if convertAction != nil {
            runningTasks.Add(Task.Run(() -> {
                let result = convertAction(data)
            }))
        }
    }
}
");

        AssertClean(result);
    }

    [Fact]
    public void LetParameter_NamedDelegate_DirectInvokeInsideArrowLambda()
    {
        var result = Evaluate(NamedDelegate + @"
func Run(convertAction ConvertFunc?, data []uint8) {
    if convertAction != nil {
        let f = () -> { convertAction(data) }
        f()
    }
}
Run(nil, []uint8{})
");

        AssertClean(result);
    }

    [Fact]
    public void ByValueParameter_NarrowsInsideLocalFunction()
    {
        // A local function is a `let Name = func() { ... }` function-literal
        // declaration — its captured-variable analysis goes through the same
        // BindFunctionLiteralExpression entry point as an ordinary lambda.
        var result = Evaluate(NamedDelegate + @"
func Run(convertAction ConvertFunc?, data []uint8) {
    if convertAction != nil {
        let Inner = func() {
            convertAction(data)
        }
        Inner()
    }
}
Run(nil, []uint8{})
");

        AssertClean(result);
    }

    [Fact]
    public void LetLocal_CopiedFromParameter_NarrowsInsideClosure()
    {
        var result = Evaluate(NamedDelegate + @"
func Run(convertActionIn ConvertFunc?, data []uint8) {
    let convertAction = convertActionIn
    if convertAction != nil {
        let f = () -> { convertAction(data) }
        f()
    }
}
Run(nil, []uint8{})
");

        AssertClean(result);
    }

    // ---- Positive: closure execution/lifetime shapes ----------------------

    [Fact]
    public void NestedLambdas_InnerClosureStillSeesNarrowing()
    {
        var result = Evaluate(NamedDelegate + @"
func Run(convertAction ConvertFunc?, data []uint8) {
    if convertAction != nil {
        let outer = () -> {
            let inner = () -> { convertAction(data) }
            inner()
        }
        outer()
    }
}
Run(nil, []uint8{})
");

        AssertClean(result);
    }

    [Fact]
    public void MultipleClosures_CapturingSameReadOnlyBinding_BothNarrow()
    {
        var result = Evaluate(NamedDelegate + @"
func Run(convertAction ConvertFunc?, data []uint8) {
    if convertAction != nil {
        let f1 = () -> { convertAction(data) }
        let f2 = () -> { convertAction(data) }
        f1()
        f2()
    }
}
Run(nil, []uint8{})
");

        AssertClean(result);
    }

    [Fact]
    public void EscapingClosure_ReturnedFromDeclaringFunction_StillNarrows()
    {
        // The closure runs strictly after the declaring function has
        // returned — the read-only rule must hold across that boundary too,
        // since a `let`/by-value parameter cannot be reassigned regardless
        // of when or how many times the escaping delegate is later invoked.
        var result = Evaluate(NamedDelegate + @"
func Make(convertAction ConvertFunc?, data []uint8) (() -> void)? {
    if convertAction != nil {
        return () -> { convertAction(data) }
    }
    return nil
}
let f = Make(nil, []uint8{})
");

        AssertClean(result);
    }

    [Fact]
    public void AsyncLambda_NarrowsAcrossAwaitSuspension()
    {
        var result = Evaluate(@"
import System.Threading.Tasks
" + NamedDelegate + @"
func Run(convertAction ConvertFunc?, data []uint8) {
    if convertAction != nil {
        let task = Task.Run(async () -> {
            await Task.Delay(1)
            convertAction(data)
        })
    }
}
Run(nil, []uint8{})
");

        AssertClean(result);
    }

    [Fact]
    public void ConditionalInvocation_InsideClosureBody_StillNarrows()
    {
        var result = Evaluate(NamedDelegate + @"
func Run(convertAction ConvertFunc?, data []uint8, flag bool) {
    if convertAction != nil {
        let f = () -> {
            if flag {
                convertAction(data)
            }
        }
        f()
    }
}
Run(nil, []uint8{}, true)
");

        AssertClean(result);
    }

    [Fact]
    public void NestedBranch_NarrowingEstablishedInInnerIf_SurvivesClosure()
    {
        var result = Evaluate(NamedDelegate + @"
func Run(convertAction ConvertFunc?, data []uint8, flag bool) {
    if flag {
        if convertAction != nil {
            let f = () -> { convertAction(data) }
            f()
        }
    }
}
Run(nil, []uint8{}, true)
");

        AssertClean(result);
    }

    [Fact]
    public void GenericNamedDelegate_NarrowsInsideClosure()
    {
        var result = Evaluate(@"
type Transform[T any] = delegate func(v T) T
func Run[T](a Transform[T]?, v T) T {
    if a != nil {
        let f = () -> { return a(v) }
        return f()
    }
    return v
}
Run[int32](nil, 1)
");

        AssertClean(result);
    }

    // ---- Positive: coverage for bare function types and CLR delegates -----
    //
    // These shapes never reproduced GS0131 (see the class remarks) because
    // OverloadResolver.CallBinding's ClrType-delegate fallback already binds
    // the call regardless of narrowing. They are kept as permanent
    // regression coverage: the closure-narrowing rule must not regress
    // these either, even though they were never the differentiating case.

    [Fact]
    public void BareNullableFunctionType_NarrowsInsideClosure()
    {
        var result = Evaluate(@"
func Run(convertAction (([]uint8) -> []uint8)?, data []uint8) {
    if convertAction != nil {
        let f = () -> { convertAction(data) }
        f()
    }
}
Run(nil, []uint8{})
");

        AssertClean(result);
    }

    [Fact]
    public void ClrGenericDelegate_NarrowsInsideClosure()
    {
        var result = Evaluate(@"
import System
func Run(convertAction Func[[]uint8, []uint8]?, data []uint8) {
    if convertAction != nil {
        let f = () -> { convertAction(data) }
        f()
    }
}
Run(nil, []uint8{})
");

        AssertClean(result);
    }

    // ---- Negative: mutation, aliasing, and member-path cases must still
    //      drop the narrowing (unsound to preserve) --------------------------

    [Fact]
    public void MutableVarLocal_ReassignedBeforeClosureCreation_DoesNotNarrow()
    {
        var result = Evaluate(NamedDelegate + @"
func Run(convertActionIn ConvertFunc?, data []uint8) {
    var convertAction = convertActionIn
    if convertAction != nil {
        convertAction = nil
        let f = () -> { convertAction(data) }
        f()
    }
}
Run(nil, []uint8{})
");

        AssertContainsError(result, "GS0131");
    }

    [Fact]
    public void MutableVarLocal_ReassignedAfterClosureCreation_DoesNotNarrow()
    {
        // The closure is created while `convertAction` is still narrowed,
        // but the enclosing scope reassigns it before the closure actually
        // runs — exactly the hazard ADR-0069 exists to prevent for mutable
        // bindings. `var` is not `IsReadOnly`, so the fix's filter still
        // drops this narrowing, unchanged from pre-#2442 behavior.
        var result = Evaluate(NamedDelegate + @"
func Run(convertActionIn ConvertFunc?, data []uint8) {
    var convertAction = convertActionIn
    if convertAction != nil {
        let f = () -> { convertAction(data) }
        convertAction = nil
        f()
    }
}
Run(nil, []uint8{})
");

        AssertContainsError(result, "GS0131");
    }

    [Fact]
    public void MutableVarLocal_ReassignedAcrossLoopIterations_DoesNotNarrow()
    {
        var result = Evaluate(NamedDelegate + @"
func Run(convertActionIn ConvertFunc?, data []uint8) {
    var convertAction = convertActionIn
    for i in 0...3 {
        if convertAction != nil {
            let f = () -> { convertAction(data) }
            f()
        }
        convertAction = nil
    }
}
Run(nil, []uint8{})
");

        AssertContainsError(result, "GS0131");
    }

    [Fact]
    public void RefParameter_DoesNotNarrow()
    {
        // A `ref` parameter aliases external, possibly-shared storage; it is
        // not `IsReadOnly` (RefKind != None/In), so it is excluded by the
        // same filter that already excludes `var` locals.
        var result = Evaluate(NamedDelegate + @"
func Run(ref convertAction ConvertFunc?, data []uint8) {
    if convertAction != nil {
        let f = () -> { convertAction(data) }
        f()
    }
}
");

        Assert.Contains(result.Diagnostics, d => d.IsError);
    }

    [Fact]
    public void MemberAccessPath_ClassFieldNarrowing_DoesNotSurviveClosure()
    {
        // Member paths are always dropped across a closure boundary, even
        // when the receiver and field are both otherwise stable/read-only —
        // this mirrors the ADR-1180 member-path addendum: a member read
        // could be mutated through an alias the narrowing analysis never
        // observes, so widening the "read-only survives" rule to member
        // paths would be unsound.
        var result = Evaluate(NamedDelegate + @"
class Box {
    let convertAction ConvertFunc?
}
func Run(box Box, data []uint8) {
    if box.convertAction != nil {
        let f = () -> { box.convertAction(data) }
        f()
    }
}
Run(Box{convertAction: nil}, []uint8{})
");

        Assert.Contains(result.Diagnostics, d => d.IsError);
    }

    private static void AssertClean(EvaluationResult result)
    {
        Assert.Empty(result.Diagnostics);
    }

    private static void AssertContainsError(EvaluationResult result, string diagnosticId)
    {
        Assert.Contains(result.Diagnostics, d => d.IsError && d.Id == diagnosticId);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
