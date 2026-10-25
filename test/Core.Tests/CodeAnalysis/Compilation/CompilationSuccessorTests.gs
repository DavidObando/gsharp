// <copyright file="CompilationSuccessorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Compilation

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Threading
import System.Threading.Tasks
import Xunit

/// ADR-0212 S1 — the successor factories, the opt-in body cache, `GetTypeByMetadataName` and the
/// single-flight lazy builds of (cref:Compilation).
open class CompilationSuccessorTests {
    @Fact
    func ReplaceSyntaxTree_BodyOnlyEdit_ReusesTheGlobalScopeAndRepointsTheEditedSymbols() {
        let (a, b) = TwoFiles()
        let previous = Compilation(a, b){IncrementalBodyReuse = true}
        let scope_ = previous.GlobalScope
        let editedA = Parse("A.gs", AText.Replace("return 1", "return 100"))
        let successor = previous.ReplaceSyntaxTree(a, editedA)
        Assert.NotSame(previous, successor)
        Assert.Same(scope_, successor.GlobalScope)
        Assert.Equal([]SyntaxTree{editedA, b}, successor.SyntaxTrees.ToArray())
        let function = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "A")
        Assert.Same(editedA, function.Declaration!!.SyntaxTree)
        Assert.Empty(successor.BoundProgram.Diagnostics)
    }

    @Fact
    func WithReplacedSyntaxTree_NeverRetargetsOrSharesTheBodyCache() {
        let (a, b) = TwoFiles()
        let previous = Compilation(a, b){IncrementalBodyReuse = true}
        let scope_ = previous.GlobalScope
        let editedA = Parse("A.gs", AText.Replace("return 1", "return 100"))
        let snapshot = previous.WithReplacedSyntaxTree(a, editedA)
        Assert.NotSame(scope_, snapshot.GlobalScope)
        Assert.Null(snapshot.BodyCache)
        Assert.False(snapshot.IncrementalBodyReuse)
        Assert.NotNull(previous.BodyCache)
        let function = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "A")
        Assert.Same(a, function.Declaration!!.SyntaxTree)
    }

    @Fact
    func ReplaceSyntaxTree_SignatureEdit_BindsFromScratchAndStillSharesTheCache() {
        let (a, b) = TwoFiles()
        let previous = Compilation(a, b){IncrementalBodyReuse = true}
        let scope_ = previous.GlobalScope
        let editedA = Parse("A.gs", AText.Replace("func A() int32", "func A() int64"))
        let successor = previous.ReplaceSyntaxTree(a, editedA)
        Assert.NotSame(scope_, successor.GlobalScope)
        Assert.Same(previous.BodyCache, successor.BodyCache)
        let function = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "A")
        Assert.Same(a, function.Declaration!!.SyntaxTree)
    }

    @Fact
    func ReplaceSyntaxTree_OnARetiredCompilation_BindsFromScratch() {
        let (a, b) = TwoFiles()
        let previous = Compilation(a, b)
        let scope_ = previous.GlobalScope
        let first = previous.ReplaceSyntaxTree(a, Parse("A.gs", AText.Replace("return 1", "return 2")))
        Assert.Same(scope_, first.GlobalScope)
        let second = previous.ReplaceSyntaxTree(a, Parse("A.gs", AText.Replace("return 1", "return 3")))
        Assert.NotSame(scope_, second.GlobalScope)
    }

    @Fact
    func ReplaceSyntaxTree_OnAnUnnamedTreeWithADeclarationDiagnostic_BindsFromScratch() {
        let source = "package P\nfunc A() int32 {\n    return 1\n}\nfunc B() Undefined {\n    return nil\n}\n"
        let tree = SyntaxTree.Parse(source)
        Assert.True(string.IsNullOrEmpty(tree.Text.FileName))
        let previous = Compilation(tree)
        Assert.NotEmpty(previous.GlobalScope.Diagnostics)
        let edited = SyntaxTree.Parse(source.Replace("return 1", "let x int32 = 1\n    return x"))
        let successor = previous.ReplaceSyntaxTree(tree, edited)
        // The diagnostic's span moved with the edit, so the old scope cannot be kept.
        Assert.NotSame(previous.GlobalScope, successor.GlobalScope)
        let fresh = Compilation(edited).GlobalScope.Diagnostics
        Assert.Equal(
            fresh.Select((d Diagnostic) -> (d.Id, d.Location.Span.Start)).ToArray(),
            successor.GlobalScope.Diagnostics.Select((d Diagnostic) -> (d.Id, d.Location.Span.Start)).ToArray()
        )
    }

    @Fact
    func SuccessorFactories_CopyEveryOptionExceptTheWorkBudget() {
        let (a, b) = TwoFiles()
        let budget = CompilationWorkBudget()
        let debug = DebugInformationOptions()
        debug.EmbedAllSources = true
        let previous = Compilation(a){
            IsLibrary = true,
            Optimize = false,
            PlatformNilChecks = false,
            ImplicitSystemImport = false,
            WarnOnMissingDocumentation = true,
            AssemblyName = "Chain",
            DebugInformation = debug,
            WorkBudget = budget
        }
        let successors = []Compilation{
            previous.AddSyntaxTrees(b),
            previous.ReplaceSyntaxTree(a, Parse("A.gs", AText)),
            previous.WithReplacedSyntaxTree(a, Parse("A.gs", AText))
        }
        for successor in successors {
            Assert.True(successor.IsLibrary)
            Assert.False(successor.Optimize)
            Assert.False(successor.PlatformNilChecks)
            Assert.False(successor.ImplicitSystemImport)
            Assert.True(successor.WarnOnMissingDocumentation)
            Assert.Equal("Chain", successor.AssemblyName)
            Assert.True(successor.DebugInformation!!.EmbedAllSources)
            Assert.NotSame(budget, successor.WorkBudget)
        }
    }

    @Fact
    func AddAndRemoveSyntaxTrees_BindFromScratchAndShareTheCache() {
        let (a, b) = TwoFiles()
        let previous = Compilation(a){IncrementalBodyReuse = true}
        let added = previous.AddSyntaxTrees(b)
        Assert.Equal([]SyntaxTree{a, b}, added.SyntaxTrees.ToArray())
        Assert.Same(previous.BodyCache, added.BodyCache)
        let removed = added.RemoveSyntaxTrees(a)
        Assert.Equal([]SyntaxTree{b}, removed.SyntaxTrees.ToArray())
        Assert.Same(previous.BodyCache, removed.BodyCache)
        Assert.Equal(1, previous.SyntaxTrees.Length)
        Assert.Throws[ArgumentException](
            () -> {
                let _ = previous.AddSyntaxTrees(a)
            }
        )
        Assert.Throws[ArgumentException](
            () -> {
                let _ = previous.RemoveSyntaxTrees(b)
            }
        )
        Assert.Throws[ArgumentException](
            () -> {
                let _ = previous.ReplaceSyntaxTree(b, a)
            }
        )
    }

    @Fact
    func BodyCache_ExistsOnlyWhenIncrementalBodyReuseIsSet() {
        let (a, b) = TwoFiles()
        Assert.Null(Compilation(a, b).BodyCache)
        Assert.Null(Compilation(a, b).AddSyntaxTrees(Parse("C.gs", "package P\nfunc C() int32 -> 3")).BodyCache)
        let chain = Compilation(a, b){IncrementalBodyReuse = true}
        Assert.NotNull(chain.BodyCache)
        Assert.True(chain.ReplaceSyntaxTree(a, Parse("A.gs", AText)).IncrementalBodyReuse)
    }

    @Fact
    func SnapshotCompilation_DoesNotEvictTheLiveChainsCacheEntries() {
        using let measurements = CompilationMeasurements.Start("snapshot")
        let (a, b) = TwoFiles()
        let live = Compilation(a, b){IncrementalBodyReuse = true}
        let _ = live.BoundProgram
        let snapshotText = BText.Replace("return 2", "return 200")
        let snapshot = live.WithReplacedSyntaxTree(b, Parse("B.gs", snapshotText))
        let _ = snapshot.BoundProgram
        let hitsBefore = measurements.GetCounter("bodies.cache-hits")
        let successor = live.ReplaceSyntaxTree(a, Parse("A.gs", AText.Replace("return 1", "return 100")))
        let _ = successor.BoundProgram
        // B was not edited, so it is served from the live chain's cache.
        Assert.Equal(hitsBefore + 1L, measurements.GetCounter("bodies.cache-hits"))
    }

    @Fact
    func SuccessiveReplacements_KeepTheEarlierEditsTreeDirtyUntilItsBodiesAreBound() {
        using let measurements = CompilationMeasurements.Start("pending-dirty")
        let two = Parse("A.gs", `package P
func A1() int32 {
    return 1
}
func A2() int32 {
    return 2
}
`)
        let b = Parse("B.gs", BText)
        let live = Compilation(two, b){IncrementalBodyReuse = true}
        let _ = live.BoundProgram
        // The first edit shifts A2; its bodies are not bound before the second edit.
        let shifted = Parse("A.gs", two.Text.ToString().Replace("return 1", "let x int32 = 5\n    return 1"))
        let first = live.ReplaceSyntaxTree(two, shifted)
        let second = first.ReplaceSyntaxTree(b, Parse("B.gs", BText.Replace("return 2", "return 20")))
        let hitsBefore = measurements.GetCounter("bodies.cache-hits")
        let _ = second.BoundProgram
        // Every body belongs to an edited tree, so none may come from the cache at a stale span.
        Assert.Equal(hitsBefore, measurements.GetCounter("bodies.cache-hits"))
    }

    @Fact
    func GetTypeByMetadataName_FindsDeclaredTypesByTheNameTheEmitterWrites() {
        let tree = Parse("Shapes.gs", `package Shapes
class Box[T] {
    var Value T
}
class Outer {
    class Inner {
    }
}
class Holder[T] {
    enum Kind { First, Second }
}
enum Color { Red, Green }
interface IShape {
    func Area() int32
}
delegate Mapper[U](value U) int32;
func Free() int32 -> 1
`)
        let compilation = Compilation(tree)
        Assert.IsType[StructSymbol](compilation.GetTypeByMetadataName("Shapes.Box`1"))
        Assert.Null(compilation.GetTypeByMetadataName("Shapes.Box"))
        Assert.Null(compilation.GetTypeByMetadataName("Box`1"))
        let inner = Assert.IsType[StructSymbol](compilation.GetTypeByMetadataName("Shapes.Outer+Inner"))
        Assert.Equal("Inner", inner.Name)
        Assert.Null(compilation.GetTypeByMetadataName("Shapes.Inner"))
        Assert.IsType[EnumSymbol](compilation.GetTypeByMetadataName("Shapes.Color"))
        Assert.IsType[EnumSymbol](compilation.GetTypeByMetadataName("Shapes.Holder`1+Kind"))
        Assert.IsType[InterfaceSymbol](compilation.GetTypeByMetadataName("Shapes.IShape"))
        Assert.IsType[DelegateTypeSymbol](compilation.GetTypeByMetadataName("Shapes.Mapper`1"))
        Assert.Null(compilation.GetTypeByMetadataName("Shapes.Free"))
        Assert.Null(compilation.GetTypeByMetadataName("Other.Color"))
    }

    @Fact
    func GetTypeByMetadataName_StillFindsAnEnumNestedInAGenericTypeAfterEmit() {
        let tree = Parse("Holder.gs", `package Shapes
class Holder[T] {
    enum Kind { First, Second }
}
`)
        let compilation = Compilation(tree){IsLibrary = true}
        using let stream = MemoryStream()
        Assert.True(compilation.Emit(stream).Success)
        Assert.IsType[EnumSymbol](compilation.GetTypeByMetadataName("Shapes.Holder`1+Kind"))
    }

    @Fact
    func LazyBuilds_AreSingleFlight() {
        let (a, b) = TwoFiles()
        let compilation = Compilation(a, b)
        let binds = Counter()
        compilation.BodyBindProbe = () -> {
            Interlocked.Increment(&binds.Value)
            Thread.Sleep(50)
        }
        let readers = Enumerable.Range(0, 8).Select((_ int32) -> Task.Run(() -> compilation.BoundProgram)).ToArray()
        Task.WaitAll(readers.Cast[Task]().ToArray())
        Assert.Equal(1, binds.Value)
        Assert.All(readers, (reader Task[BoundProgram]) -> Assert.Same(readers[0].Result, reader.Result))
    }

    @Fact
    func ReplaceSyntaxTree_WaitsForABuildInFlight_AndNeverRepointsDuringIt() {
        let (a, b) = TwoFiles()
        let previous = Compilation(a, b)
        let scope_ = previous.GlobalScope
        let function = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "A")
        using let entered = ManualResetEventSlim(false)
        using let release = ManualResetEventSlim(false)
        previous.BodyBindProbe = () -> {
            entered.Set()
            release.Wait()
        }
        let build = Task.Run(() -> previous.BoundProgram)
        Assert.True(entered.Wait(TimeSpan.FromSeconds(30)))
        let editedA = Parse("A.gs", AText.Replace("return 1", "return 100"))
        let replace = Task.Run(() -> previous.ReplaceSyntaxTree(a, editedA))
        // The factory must wait for the build: the symbols still point at the old tree.
        Assert.False(replace.Wait(TimeSpan.FromMilliseconds(500)))
        Assert.Same(a, function.Declaration!!.SyntaxTree)
        release.Set()
        Assert.True(replace.Wait(TimeSpan.FromSeconds(30)))
        Assert.NotNull(build.Result)
        Assert.Same(editedA, function.Declaration!!.SyntaxTree)
        Assert.Same(scope_, replace.Result.GlobalScope)
    }

    @Fact
    func ReplaceSyntaxTree_OnASuccessor_WaitsForABuildOfTheRetiredPredecessor() {
        let (a, b) = TwoFiles()
        let first = Compilation(a, b)
        let scope_ = first.GlobalScope
        let second = first.ReplaceSyntaxTree(a, Parse("A.gs", AText.Replace("return 1", "return 100")))
        Assert.Same(scope_, second.GlobalScope)
        let function = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "B")
        using let entered = ManualResetEventSlim(false)
        using let release = ManualResetEventSlim(false)
        first.BodyBindProbe = () -> {
            entered.Set()
            release.Wait()
        }
        // The retired predecessor may still bind; the successor shares its symbols.
        let build = Task.Run(() -> first.BoundProgram)
        Assert.True(entered.Wait(TimeSpan.FromSeconds(30)))
        let editedB = Parse("B.gs", BText.Replace("return 2", "return 200"))
        let replace = Task.Run(() -> second.ReplaceSyntaxTree(b, editedB))
        Assert.False(replace.Wait(TimeSpan.FromMilliseconds(500)))
        Assert.Same(b, function.Declaration!!.SyntaxTree)
        release.Set()
        Assert.True(replace.Wait(TimeSpan.FromSeconds(30)))
        Assert.NotNull(build.Result)
        Assert.Same(editedB, function.Declaration!!.SyntaxTree)
    }

    @Fact
    func RequestToken_CancelsOnlyTheCallersWait_NotTheBuild() {
        let (a, b) = TwoFiles()
        let compilation = Compilation(a, b)
        let _ = compilation.GlobalScope
        using let entered = ManualResetEventSlim(false)
        using let release = ManualResetEventSlim(false)
        compilation.BodyBindProbe = () -> {
            entered.Set()
            release.Wait()
        }
        let builder = Task.Run(() -> compilation.BoundProgram)
        Assert.True(entered.Wait(TimeSpan.FromSeconds(30)))
        using let cancellation = CancellationTokenSource()
        let waiter = Task.Run(() -> compilation.GetBoundProgram(cancellation.Token))
        Assert.False(waiter.Wait(TimeSpan.FromMilliseconds(200)))
        cancellation.Cancel()
        let thrown = Assert.Throws[AggregateException](
            () -> {
                let _ = waiter.Wait(TimeSpan.FromSeconds(30))
            }
        )
        Assert.IsAssignableFrom[OperationCanceledException](thrown.InnerException)
        release.Set()
        Assert.NotNull(builder.Result)
        Assert.Same(builder.Result, compilation.BoundProgram)
    }

    @Fact
    func LifetimeToken_CancelledBeforeTheBuild_PublishesNothingAndKeepsThrowing() {
        let (a, b) = TwoFiles()
        using let lifetime = CancellationTokenSource()
        let compilation = Compilation(a, b){WorkBudget = CompilationWorkBudget(cancellationToken: lifetime.Token)}
        lifetime.Cancel()
        Assert.Throws[OperationCanceledException](
            () -> {
                let _ = compilation.GlobalScope
            }
        )
        Assert.Throws[OperationCanceledException](
            () -> {
                let _ = compilation.BoundProgram
            }
        )
        Assert.Throws[OperationCanceledException](
            () -> {
                let _ = compilation.GetTypeByMetadataName("P.A")
            }
        )
    }

    private class Counter {
        var Value int32
    }

    private func Parse(name string, text string) SyntaxTree -> SyntaxTree.Parse(SourceText.From(text, name))

    private func TwoFiles()(A SyntaxTree, B SyntaxTree) -> (Parse("A.gs", AText), Parse("B.gs", BText))

    shared {
        private const AText string = `package P
func A() int32 {
    return 1
}
`
        private const BText string = `package P
func B() int32 {
    return 2
}
`
    }
}
