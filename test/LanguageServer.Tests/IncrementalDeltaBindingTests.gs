// <copyright file="IncrementalDeltaBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.LanguageServer
import Xunit

/// ADR-0105 (Phase 2) — end-to-end tests driving the real language-server path
/// ((cref:ProjectState.UpdateFile) + (cref:ProjectState.GetCompilation),
/// a fresh `Compilation` per edit). They prove that a single-file,
/// body-only edit reuses the previous compilation's global scope and serves the
/// unchanged files' bodies from the compilation chain's body cache (`IncrementalBodyReuse`), while edits
/// that are not provably body-only fall back to a full rebuild.
open class IncrementalDeltaBindingTests {
    @Fact
    func BodyOnlyEdit_ReusesGlobalScope_AndServesCacheHitsForUnchangedFiles() {
        using let measurements = CompilationMeasurements.Start("incremental-delta")
        let project = ProjectState("/test/project.gsproj")
        project.UpdateFile(FileA, `package P
func A() int {
    return 1
}
`)
        project.UpdateFile(FileB, `package P
func B() int {
    return 2
}
`)
        project.UpdateFile(FileC, `package P
func C() int {
    return 3
}
`)
        let comp1 = project.GetCompilation()
        let _ = comp1.BoundProgram // populate the per-project body cache
        let hitsBefore = measurements.GetCounter("bodies.cache-hits")
        let storesBefore = measurements.GetCounter("bodies.cache-stores")
        // Body-only edit to a.gs — only the returned literal changes.
        project.UpdateFile(FileA, `package P
func A() int {
    return 100
}
`)
        let comp2 = project.GetCompilation()
        Assert.NotSame(comp1, comp2)
        // Fast path taken: comp2 reuses comp1's bound global scope (and therefore
        // every symbol instance), and marks a.gs as the only dirty body tree.
        Assert.Same(comp1.GlobalScope, comp2.GlobalScope)
        let _ = comp2.BoundProgram
        // b.gs and c.gs were served from the cache; only a.gs re-bound and re-stored.
        Assert.Equal(hitsBefore + int64(2), measurements.GetCounter("bodies.cache-hits"))
        Assert.Equal(storesBefore + int64(1), measurements.GetCounter("bodies.cache-stores"))
    }

    @Fact
    func SignatureEdit_FallsBackToFullRebuild() {
        let project = ProjectState("/test/project.gsproj")
        project.UpdateFile(FileA, `package P
func Helper(x int) int {
    return x * 2
}
`)
        project.UpdateFile(FileB, `package P
func UseHelper(y int) int {
    return Helper(y) + 1
}
`)
        let comp1 = project.GetCompilation()
        let _ = comp1.BoundProgram
        // Parameter type changes — a signature edit, not body-only.
        project.UpdateFile(FileA, `package P
func Helper(x int32) int {
    return x * 2
}
`)
        let comp2 = project.GetCompilation()
        Assert.NotSame(comp1, comp2)
        Assert.NotSame(comp1.GlobalScope, comp2.GlobalScope)
    }

    @Fact
    func MultipleFilesChanged_FallsBackToFullRebuild() {
        let project = ProjectState("/test/project.gsproj")
        project.UpdateFile(FileA, `package P
func A() int {
    return 1
}
`)
        project.UpdateFile(FileB, `package P
func B() int {
    return 2
}
`)
        let comp1 = project.GetCompilation()
        let _ = comp1.BoundProgram
        project.UpdateFile(FileA, `package P
func A() int {
    return 10
}
`)
        project.UpdateFile(FileB, `package P
func B() int {
    return 20
}
`)
        let comp2 = project.GetCompilation()
        Assert.NotSame(comp1.GlobalScope, comp2.GlobalScope)
    }

    @Fact
    func FileAdded_FallsBackToFullRebuild() {
        let project = ProjectState("/test/project.gsproj")
        project.UpdateFile(FileA, `package P
func A() int {
    return 1
}
`)
        let comp1 = project.GetCompilation()
        let _ = comp1.BoundProgram
        project.UpdateFile(FileB, `package P
func B() int {
    return 2
}
`)
        let comp2 = project.GetCompilation()
        Assert.NotSame(comp1.GlobalScope, comp2.GlobalScope)
    }

    /// ADR-0105 Phase 2 (broadened member surface) — the headline repro: a file
    /// containing a constructor (`init()`) now takes the incremental fast
    /// path for a pure in-body edit instead of falling back to a full rebuild.
    @Fact
    func BodyOnlyEdit_FileWithConstructor_ReusesGlobalScope() {
        using let measurements = CompilationMeasurements.Start("incremental-delta")
        let project = ProjectState("/test/project.gsproj")
        project.UpdateFile(FileA, `package P
class Box {
    var V int32
    init(v int32) {
        V = v
    }
    func Get() int32 {
        return V
    }
}
`)
        project.UpdateFile(FileB, `package P
func Use() int32 {
    var b = Box(1)
    return b.Get()
}
`)
        let comp1 = project.GetCompilation()
        let _ = comp1.BoundProgram
        let hitsBefore = measurements.GetCounter("bodies.cache-hits")
        // Pure in-body edit to the method (constructor signature unchanged).
        project.UpdateFile(FileA, `package P
class Box {
    var V int32
    init(v int32) {
        V = v
    }
    func Get() int32 {
        return V + 0
    }
}
`)
        let comp2 = project.GetCompilation()
        // Fast path engaged: the global scope (and every symbol) is reused.
        Assert.Same(comp1.GlobalScope, comp2.GlobalScope)
        let _ = comp2.BoundProgram
        // b.gs was served from the cache.
        Assert.True(measurements.GetCounter("bodies.cache-hits") > hitsBefore)
    }

    /// A computed-property type change in a constructor-bearing file is a
    /// signature edit, so the fast path is correctly refused.
    @Fact
    func SignatureEdit_FileWithComputedProperty_FallsBackToFullRebuild() {
        let project = ProjectState("/test/project.gsproj")
        project.UpdateFile(FileA, `package P
class Counter {
    var n int32
    prop Doubled int32 {
        get { return n }
    }
}
`)
        let comp1 = project.GetCompilation()
        let _ = comp1.BoundProgram
        // Property type changes int32 -> int64: a signature edit.
        project.UpdateFile(FileA, `package P
class Counter {
    var n int32
    prop Doubled int64 {
        get { return n }
    }
}
`)
        let comp2 = project.GetCompilation()
        Assert.NotSame(comp1.GlobalScope, comp2.GlobalScope)
    }

    shared {
        private const FileA string = "/test/a.gs"
        private const FileB string = "/test/b.gs"
        private const FileC string = "/test/c.gs"
    }
}
