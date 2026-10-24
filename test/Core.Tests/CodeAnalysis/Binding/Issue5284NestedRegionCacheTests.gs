// <copyright file="Issue5284NestedRegionCacheTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #5284: an enclosing region's fixed point probes a nested try, catch, finally, switch-arm,
/// fixed or await-for body again on every iteration. The definite-assignment analysis caches a probe by
/// (region, input set, tracked-local count). These tests compare the cached analysis with the uncached
/// one: the diagnostics, and for the sample programs the emitted bytes, must be identical, and in verify
/// mode every cache hit is re-analyzed and compared with the cached result.
internal class SampleOutcome5284 {
    internal init(diagnostics string, bytes[]uint8) {
        Diagnostics = diagnostics
        Bytes = bytes
    }

    prop Diagnostics string {
        get;
    }
    prop Bytes[]uint8 {
        get;
    }
}

@Collection("DefiniteAssignmentNestedRegionCache")
open class Issue5284NestedRegionCacheTests {
    @Theory
    @InlineData(`func Run(condition bool, out value int32) {
    var i = 0
    while i < 3 {
        try {
            if condition { value = 1 }
            i++
        } catch (e Exception) {
            i++
        }
    }
}`)
    @InlineData(`func Run(condition bool, out value int32) {
    for condition {
        try {
            try {
                value = 1
            } finally {
                value = 2
            }
        } catch (e Exception) {
            if condition { value = 3 }
        } finally {
            value = 4
        }
    }
}`)
    @InlineData(`func Run(condition bool, other bool) {
    var c chan[int32]
    var d chan[int32]
    for condition {
        try {
            c = chan[int32](1)
            if other { d = chan[int32](1) }
        } catch (e Exception) {
            d <- 1
        }
        c <- 2
    }
    d <- 3
}`)
    @InlineData(`func Run(selector int32, out value int32) {
    var i = 0
    for i < 4 {
        switch selector {
            case 1 { value = 1 }
            case 2 { try { value = 2 } finally { i++ } }
            default { i++ }
        }
    }
}`)
    func LoopWithNestedRegions_CachedAndUncachedAgree(body string) {
        let source = "import System\n\n" + body
        let uncached = Bind(source, DefiniteAssignmentAnalyzer.NestedRegionCacheOff)
        let hitsBefore = DefiniteAssignmentAnalyzer.NestedRegionCacheHits
        let mismatchesBefore = DefiniteAssignmentAnalyzer.NestedRegionCacheMismatches
        let verified = Bind(source, DefiniteAssignmentAnalyzer.NestedRegionCacheVerify)
        let cached = Bind(source, DefiniteAssignmentAnalyzer.NestedRegionCacheOn)
        Assert.Equal(uncached, verified)
        Assert.Equal(uncached, cached)
        Assert.Equal(mismatchesBefore, DefiniteAssignmentAnalyzer.NestedRegionCacheMismatches)
        Assert.True(
            DefiniteAssignmentAnalyzer.NestedRegionCacheHits > hitsBefore,
            "The loop re-probes its nested regions with an unchanged state, so the cache must have answered."
        )
    }

    @Fact
    func LoopWithNestedRegions_StillReportsTheUnassignedOutParameter() {
        const source = `import System

func Run(condition bool, out value int32) {
    for condition {
        try {
            if condition { value = 1 }
        } catch (e Exception) {
        }
    }
}`
        let cached = Bind(source, DefiniteAssignmentAnalyzer.NestedRegionCacheOn)
        Assert.Single(cached, (d string) -> d.StartsWith("GS0238@"))
        Assert.Equal(Bind(source, DefiniteAssignmentAnalyzer.NestedRegionCacheOff), cached)
    }

    @Fact
    func LiveAliasMap_BypassesTheCache_AndAgreesWithTheUncachedAnalysis() {
        const source = `import System

unsafe func Run(condition bool, out value int32) {
    var p *int32 = &value
    for condition {
        try {
            *p = 5
        } catch (e Exception) {
        }
    }
}`
        let uncached = Bind(source, DefiniteAssignmentAnalyzer.NestedRegionCacheOff)
        let bypassesBefore = DefiniteAssignmentAnalyzer.NestedRegionCacheBypasses
        let mismatchesBefore = DefiniteAssignmentAnalyzer.NestedRegionCacheMismatches
        let verified = Bind(source, DefiniteAssignmentAnalyzer.NestedRegionCacheVerify)
        Assert.Equal(uncached, verified)
        Assert.True(
            DefiniteAssignmentAnalyzer.NestedRegionCacheBypasses > bypassesBefore,
            "The pointer alias to the out parameter is live when the nested try is probed."
        )
        Assert.Equal(mismatchesBefore, DefiniteAssignmentAnalyzer.NestedRegionCacheMismatches)
    }

    @Fact
    func Samples_DiagnosticsAndEmittedBytesAreIdentical_WithAndWithoutTheCache() {
        let repoRoot = LocateRepoRoot()
        Assert.NotNull(repoRoot)
        let samples = Directory
            .GetFiles(Path.Combine(repoRoot!!, "samples"), "*.gs")
            .OrderBy((path string) -> path, StringComparer.Ordinal)
            .ToArray()
        Assert.NotEmpty(samples)
        using let references = SampleReferences.CreateResolver()
        let mismatchesBefore = DefiniteAssignmentAnalyzer.NestedRegionCacheMismatches
        for path in samples {
            let source = File.ReadAllText(path)
            let uncached = CompileSample(
                source,
                Path.GetFileName(path),
                references,
                DefiniteAssignmentAnalyzer.NestedRegionCacheOff
            )
            let verified = CompileSample(
                source,
                Path.GetFileName(path),
                references,
                DefiniteAssignmentAnalyzer.NestedRegionCacheVerify
            )
            Assert.True(uncached.Diagnostics == verified.Diagnostics, "Diagnostics differ for $path")
            Assert.True(uncached.Bytes.SequenceEqual(verified.Bytes), "Emitted bytes differ for $path")
        }
        Assert.Equal(mismatchesBefore, DefiniteAssignmentAnalyzer.NestedRegionCacheMismatches)
    }

    @Fact
    func Replay_RequiresTheSameRegionAndTheSameInputSet() {
        let a = Local("a")
        let b = Local("b")
        let cache = DefiniteAssignmentAnalyzer.TrackedLocals()
        let region = BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
        let otherRegion = BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
        cache.Record(region, SetOf(a), SetOf(a, b), 0)
        Assert.True(cache.TryReplay(region, SetOf(a), out var hit))
        Assert.True(hit.SetEquals(SetOf(a, b)))
        Assert.False(cache.TryReplay(region, SetOf(b), out var differentInput))
        Assert.Null(differentInput)
        Assert.False(cache.TryReplay(region, SetOf(a, b), out var supersetInput))
        Assert.False(cache.TryReplay(otherRegion, SetOf(a), out var differentRegion))
    }

    @Fact
    func Replay_ReturnsACopyAndRemembersARegionThatNeverCompletes() {
        let a = Local("a")
        let cache = DefiniteAssignmentAnalyzer.TrackedLocals()
        let region = BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
        let exit = SetOf(a)
        cache.Record(region, SetOf(), exit, 0)
        exit.Clear()
        Assert.True(cache.TryReplay(region, SetOf(), out var first))
        Assert.True(first.SetEquals(SetOf(a)))
        first.Clear()
        Assert.True(cache.TryReplay(region, SetOf(), out var second))
        Assert.True(second.SetEquals(SetOf(a)))
        let neverCompletes = BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
        cache.Record(neverCompletes, SetOf(), nil, 0)
        Assert.True(cache.TryReplay(neverCompletes, SetOf(), out var none))
        Assert.Null(none)
    }

    @Fact
    func Replay_IsKeyedByTheTrackedLocalCount_AndAProbeThatAddedOneIsNotRemembered() {
        let a = Local("a")
        let cache = DefiniteAssignmentAnalyzer.TrackedLocals()
        let region = BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
        let grew = BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
        cache.Record(region, SetOf(), SetOf(a), 0)
        cache.Add(Local("tracked"))
        Assert.False(cache.TryReplay(region, SetOf(), out var afterGrowth))
        // The probe started with one tracked local and ended with two. Replaying it would skip that side effect,
        // so it is not remembered (and the tracked count, which only grows, could not match its key again).
        cache.Add(Local("addedByTheProbe"))
        cache.Record(grew, SetOf(), SetOf(a), 1)
        Assert.False(cache.TryReplay(grew, SetOf(), out var notRemembered))
        cache.Record(grew, SetOf(), SetOf(a), 2)
        Assert.True(cache.TryReplay(grew, SetOf(), out var remembered))
    }

    shared {
        private func Local(name string) LocalVariableSymbol -> LocalVariableSymbol(
            name,
            isReadOnly: false,
            TypeSymbol.Int32
        )

        private func SetOf(items ...LocalVariableSymbol) HashSet[VariableSymbol] {
            let set = HashSet[VariableSymbol]()
            for item in items {
                set.Add(item)
            }
            return set
        }

        private func Bind(source string, mode int32)[]string {
            let previous = DefiniteAssignmentAnalyzer.NestedRegionCacheMode
            DefiniteAssignmentAnalyzer.NestedRegionCacheMode = mode
            try {
                let tree = SyntaxTree.Parse(SourceText.From(source))
                Assert.Empty(tree.Diagnostics)
                let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
                Assert.Empty(globalScope.Diagnostics)
                return Binder
                    .BindProgram(globalScope)
                    .Diagnostics
                    .Select((d Diagnostic) -> d.Id + "@" + d.Location.Span.Start.ToString() + ":" + d.Message)
                    .ToArray()
            } finally {
                DefiniteAssignmentAnalyzer.NestedRegionCacheMode = previous
            }
        }

        private func CompileSample(
            source string,
            fileName string,
            references ReferenceResolver,
            mode int32
        ) SampleOutcome5284 {
            let previous = DefiniteAssignmentAnalyzer.NestedRegionCacheMode
            DefiniteAssignmentAnalyzer.NestedRegionCacheMode = mode
            try {
                let tree = SyntaxTree.Parse(SourceText.From(source, fileName))
                let compilation = Compilation(references, tree){
                    DebugInformation = DebugInformationOptions{Deterministic: true}
                }
                using let peStream = MemoryStream()
                let result = compilation.Emit(
                    peStream: peStream,
                    pdbStream: nil,
                    refStream: nil,
                    assemblyName: "GSharp.Issue5284",
                    assemblyVersion: "1.0.0.0"
                )
                return SampleOutcome5284(
                    string.Join(
                        "\n",
                        result.Diagnostics.Select(
                            (d Diagnostic) -> d.Id + "@" + d.Location.Span.Start.ToString() + ":" + d.Message
                        )
                    ),
                    peStream.ToArray()
                )
            } finally {
                DefiniteAssignmentAnalyzer.NestedRegionCacheMode = previous
            }
        }

        private func LocateRepoRoot() string? {
            var dir DirectoryInfo? = DirectoryInfo(
                Path.GetDirectoryName(typeof(Issue5284NestedRegionCacheTests).Assembly.Location)!!
            )
            while dir != nil {
                if RepositoryRootMarker.IsRoot(dir.FullName) {
                    return dir.FullName
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}
