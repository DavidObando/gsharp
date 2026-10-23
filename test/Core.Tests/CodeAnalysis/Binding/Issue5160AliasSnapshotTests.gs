package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Text
import System.Threading
import System.Threading.Tasks
import Xunit

// Issue #5160: GetDeclaredStructs and the ordered alias view it reads are memos on a
// scope that body workers share. Each memo is one immutable snapshot behind one
// reference, so concurrent first readers agree on a single published value.
class Issue5160AliasSnapshotTests {
    private func DeclareTypes(count int32)[]StructSymbol {
        let source = StringBuilder("package Snap5160\n")
        for var index = 0; index < count; index++ {
            source.Append("class T").Append(index).Append(" {}\n")
        }
        let compilation = Compilation(SyntaxTree.Parse(source.ToString()))
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        return compilation.GlobalScope.Structs.ToArray()
    }

    @Fact
    func ConcurrentFirstReads_ShareOnePublishedStructArray() {
        let types = DeclareTypes(400)
        using let measurements = CompilationMeasurements.Start("test")
        const workers = 8
        const rounds = 60
        for var round = 0; round < rounds; round++ {
            let parent = BoundScope(nil)
            for var index = 0; index < 300; index++ {
                Assert.True(parent.TryDeclareTypeAlias(types[index].Name, types[index]))
            }
            let child = BoundScope(parent)
            for var index = 300; index < types.Length; index++ {
                Assert.True(child.TryDeclareTypeAlias(types[index].Name, types[index]))
            }
            using let barrier = Barrier(workers)
            let tasks = List[Task[ImmutableArray[StructSymbol]]]()
            for var worker = 0; worker < workers; worker++ {
                tasks.Add(
                    Task.Run(
                        () -> {
                            barrier.SignalAndWait()
                            return child.GetDeclaredStructs()
                        }
                    )
                )
            }
            let results = Task.WhenAll(tasks).GetAwaiter().GetResult()
            Assert.Equal(types.Length, results[0].Length)
            for result in results {
                Assert.True(result.Equals(results[0]), "every reader must share the published array")
            }
            Assert.True(results[0].Equals(child.GetDeclaredStructs()))
        }
        Assert.Equal(int64(rounds), measurements.GetCounter("scope.declared-structs.publishes"))
        Assert.Equal(int64(rounds * 2), measurements.GetCounter("scope.ordered-type-aliases.publishes"))
    }

    @Fact
    func ChangedOwnAliases_RepublishAndKeepEarlierSnapshotsIntact() {
        let types = DeclareTypes(3)
        let single = BoundScope(nil)
        Assert.True(single.TryDeclareTypeAlias(types[0].Name, types[0]))
        let before = single.GetDeclaredStructs()
        Assert.True(single.TryDeclareTypeAlias(types[1].Name, types[1]))
        let after = single.GetDeclaredStructs()
        Assert.Equal(1, before.Length)
        Assert.Equal(2, after.Length)
        Assert.True(after.Equals(single.GetDeclaredStructs()))
    }

    @Fact
    func ChangedAliases_RepublishAndKeepEarlierSnapshotsIntact() {
        let types = DeclareTypes(3)
        let parent = BoundScope(nil)
        Assert.True(parent.TryDeclareTypeAlias(types[0].Name, types[0]))
        let child = BoundScope(parent)
        Assert.True(child.TryDeclareTypeAlias(types[1].Name, types[1]))
        let before = child.GetDeclaredStructs()
        Assert.True(before.Equals(child.GetDeclaredStructs()))
        Assert.True(parent.TryDeclareTypeAlias(types[2].Name, types[2]))
        let after = child.GetDeclaredStructs()
        Assert.Equal(2, before.Length)
        Assert.Equal(3, after.Length)
        Assert.True(after.Equals(child.GetDeclaredStructs()))
    }
}
