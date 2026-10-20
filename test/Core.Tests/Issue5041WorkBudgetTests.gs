package GSharp.Core.Tests

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Threading
import Xunit

class Issue5041WorkBudgetTests {
    @Theory
    @InlineData(`func Same($this int32) bool -> $this == $this`, false)
    @InlineData("func Same(x int32) int32 -> x", false)
    @InlineData("shared { func Same(x int32) int32 -> x }", true)
    func ImplicitReceiverScopesRemainCoordinatorOwned(member string, eligible bool) {
        let compilation = Compilation(SyntaxTree.Parse("package Receivers\nclass Holder {\n" + member + "\n}"))
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let holder = Assert.Single(compilation.GlobalScope.Structs)
        let methods = if holder.Methods.IsEmpty {
            holder.StaticMethods
        } else {
            holder.Methods
        }
        let method = Assert.Single(methods)
        Assert.Equal(eligible, IndependentBodyClassifier.CanBind(method))
        if member.Contains(`$this`, StringComparison.Ordinal) {
            Assert.Empty(compilation.BoundProgram.Diagnostics)
            let returned = Assert.IsType[BoundReturnStatement](
                Assert.Single(compilation.BoundProgram.Functions[method].Statements)
            )
            let comparison = Assert.IsType[BoundBinaryExpression](returned.Expression)
            Assert.Same(holder, comparison.Left.Type)
            Assert.Same(holder, comparison.Right.Type)
        }
    }

    @Theory
    @InlineData("return _ == _")
    @InlineData("_ = 0\nreturn true")
    func DiscardReferencesCannotProveAnEnclosingMemberPrimitive(body string) {
        let compilation = Compilation(
            SyntaxTree.Parse(
                "package Discards\nclass Marker { }\nclass Holder {\nvar _ Marker = Marker()\nfunc Same() bool {\nlet _ = 0\n" +
                    body +
                    "\n}\n}"
            )
        )
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let holder = Assert.Single(compilation.GlobalScope.Structs, (type StructSymbol) -> type.Name == "Holder")
        Assert.False(IndependentBodyClassifier.CanBind(Assert.Single(holder.Methods)))
    }

    @Theory
    @InlineData(1, 1024)
    @InlineData(8, 256)
    @InlineData(8, 1024)
    func LastSequentialOperationCancellationIsObserved(workers int32, memoryMiB int32) {
        using let cts = CancellationTokenSource()
        let budget = CompilationWorkBudget(workers, memoryMiB, cts.Token)
        Assert.Throws[OperationCanceledException](() -> budget.Run(1, (_ int32) -> cts.Cancel()))
    }

    @Fact
    func IndependentWorkOverlapsWithinOneBudgetAndJoinsOnCancellation() {
        let budget = CompilationWorkBudget(2, 1024)
        let expected = Math.Min(2, Environment.ProcessorCount)
        using let ready = CountdownEvent(expected)
        var completed int32 = 0
        budget.Run(
            expected,
            (_ int32) -> {
                ready.Signal()
                Assert.True(ready.Wait(TimeSpan.FromSeconds(15)), "Independent work did not overlap.")
                Interlocked.Increment(&completed)
            }
        )
        Assert.Equal(expected, completed)
        Assert.Equal(expected, budget.MaxObservedWorkers)
        using let cts = CancellationTokenSource()
        let cancelled = CompilationWorkBudget(2, 1024, cts.Token)
        var started int32 = 0
        completed = 0
        Assert.Throws[OperationCanceledException](
            () -> cancelled.Run(
                100,
                (_ int32) -> {
                    Interlocked.Increment(&started)
                    try {
                        cts.Cancel()
                    } finally {
                        Interlocked.Increment(&completed)
                    }
                }
            )
        )
        Assert.InRange(started, 1, cancelled.MaxWorkers)
        Assert.Equal(started, completed)
    }

    @Fact
    func WorkspaceMemoryLimitsConcurrencyAndFailuresRemainInputOrdered() {
        let budget = CompilationWorkBudget(8, 1024)
        var active int32 = 0
        var completed int32 = 0
        budget.Run(
            8,
            (_ int32) -> {
                Assert.Equal(1, Interlocked.Increment(&active))
                Interlocked.Increment(&completed)
                Interlocked.Decrement(&active)
            },
            workspaceBytes: 536870912
        )
        Assert.Equal(8, completed)
        Assert.Equal(1, budget.MaxObservedWorkers)
        let failure = Assert.Throws[InvalidOperationException](
            () -> budget.Run(
                8,
                (index int32) -> {
                    throw InvalidOperationException("source-$index")
                }
            )
        )
        Assert.Equal("source-0", failure.Message)
        budget.Run(
            1,
            (_ int32) -> {
                Interlocked.Increment(&completed)
            }
        )
        Assert.Equal(9, completed)
    }

    @Fact
    func WorkerBoundaryRejectsEveryCoordinatorSynthesisRegistry() {
        let workerScope = BoundScope(nil).CreateIndependentBodyScope()
        Assert.Throws[InvalidOperationException](
            () -> {
                workerScope.GetAnonymousTypeCache()
            }
        )
        Assert.Throws[InvalidOperationException](
            () -> {
                workerScope.GetSynthesizedRefDelegateCache()
            }
        )
        Assert.Throws[InvalidOperationException](
            () -> {
                workerScope.GetRichAnonymousClassMap()
            }
        )
        Assert.Throws[InvalidOperationException](
            () -> {
                workerScope.GetRichAnonymousObjectPlans()
            }
        )
        Assert.Throws[InvalidOperationException](
            () -> {
                workerScope.GetLatestRichAnonymousObjectPlans()
            }
        )
        Assert.Throws[InvalidOperationException](
            () -> {
                workerScope.GetStructuralAdapterRegistry()
            }
        )
        Assert.Throws[InvalidOperationException](
            () -> {
                workerScope.GetPendingUserGenericConstraintChecks()
            }
        )
    }

    @Theory
    @InlineData("func Value(x int32) int32 { let y = x + 2\nif y > 3 { return y }\nreturn 4 }", true)
    @InlineData("func Value(x int32) int32 { return Value(x) }", false)
    @InlineData("func Value(x int32) int32 { let a = object { let Value = x }\nreturn a.Value }", false)
    @InlineData("func Value(x int32) int32 { let f = func() int32 { return x }\nreturn f() }", false)
    @InlineData("func Value[T](x int32) int32 { return x }", false)
    @InlineData("func Value(x int32) int32 { return missing }", false)
    func OnlyProvenBodyLocalPrimitiveOperationsEnterWorkers(source string, eligible bool) {
        let compilation = Compilation(SyntaxTree.Parse("package Eligibility\n" + source))
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let function = Assert.Single(compilation.GlobalScope.Functions)
        Assert.Equal(eligible, IndependentBodyClassifier.CanBind(function))
    }
}
