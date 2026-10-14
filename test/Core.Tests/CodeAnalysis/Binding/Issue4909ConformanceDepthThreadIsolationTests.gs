// <copyright file="Issue4909ConformanceDepthThreadIsolationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Threading
import System.Threading.Tasks
import Xunit

/// Issue #4909: `DeclarationBinder.conformanceMatchingDepth` scopes the ADR-0186
/// "`T!` has `T`'s signature" reading to one conformance question on one thread.
/// The bootstrap compiler pinned in `global.json` drops `@ThreadStatic` on a
/// `shared` field (#4903), which made the counter one process-wide slot: a
/// conformance comparison on one thread flipped every exact comparison on every
/// other thread (language server, parallel test hosts) to the lenient reading,
/// and unsynchronised `++`/`--` could also lose updates.
/// The pre-fix mutant is a plain process-wide `int32` counter; the exact
/// comparison below then observes the conformance reading and returns true.
class Hits {
    var ExactSawConformance int32
    var ConformanceSawExact int32
}

class Issue4909ConformanceDepthThreadIsolationTests {
    @Fact
    func ExactComparison_IsNotAffectedByConformanceComparisonsOnOtherThreads() {
        // A same-compilation class has no CLR type, so only the conformance
        // reading (depth > 0) can see through its platform wrapper.
        let plain = DeclaredItem()
        let platform = PlatformTypeSymbol.Get(plain)
        Assert.IsType[PlatformTypeSymbol](platform)
        // Single-threaded control: the two readings really differ.
        Assert.False(DeclarationBinder.TypeSignaturesEquivalent(platform, plain, nil))
        Assert.True(DeclarationBinder.ConformanceSignaturesEquivalent(platform, plain))

        let stop = ManualResetEventSlim(false)
        let start = Barrier(5)
        let hits = Hits()
        // Four conformance threads keep the (process-wide, pre-fix) counter above
        // zero, and their lost updates can also drop it to zero mid-call; one exact
        // thread must never see the lenient reading.
        var tasks = List[Task]()
        for var i = 0; i < 4; i++ {
            tasks.Add(
                Task.Factory.StartNew(
                    () -> {
                        start.SignalAndWait()
                        while !stop.IsSet {
                            if !DeclarationBinder.ConformanceSignaturesEquivalent(platform, plain) {
                                Interlocked.Increment(&hits.ConformanceSawExact)
                            }
                        }
                    },
                    TaskCreationOptions.LongRunning
                )
            )
        }
        tasks.Add(
            Task.Factory.StartNew(
                () -> {
                    start.SignalAndWait()
                    let deadline = DateTime.UtcNow.AddSeconds(2)
                    while DateTime.UtcNow < deadline && Volatile.Read(&hits.ExactSawConformance) == 0 {
                        if DeclarationBinder.TypeSignaturesEquivalent(platform, plain, nil) {
                            Interlocked.Increment(&hits.ExactSawConformance)
                        }
                    }
                    stop.Set()
                },
                TaskCreationOptions.LongRunning
            )
        )
        Task.WaitAll(tasks.ToArray())

        Assert.Equal(0, hits.ExactSawConformance)
        Assert.Equal(0, hits.ConformanceSawExact)
    }

    @Fact
    func ConformanceScope_UnwindsAndDoesNotLeakIntoExactComparison() {
        let plain = DeclaredItem()
        let platform = PlatformTypeSymbol.Get(plain)
        for var i = 0; i < 1000; i++ {
            Assert.True(DeclarationBinder.ConformanceSignaturesEquivalent(platform, plain))
        }
        Assert.False(DeclarationBinder.TypeSignaturesEquivalent(platform, plain, nil))
    }

    private func DeclaredItem() TypeSymbol {
        let tree = SyntaxTree.Parse(SourceText.From(`package p
class Item {}
func Consume(x Item) { }`))
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        return scope_.Functions.Single((f FunctionSymbol) -> f.Name == "Consume").Parameters.Single().Type
    }
}
