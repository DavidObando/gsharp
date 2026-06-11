// file: Deinit.gs
// Issue #698 / ADR-0068: GSharp `class` types may declare a Swift-style
// `deinit { … }` block. The compiler lowers it to a CLR
// `protected override void Finalize()` method whose body is the user's
// statements wrapped in `try { … } finally { base.Finalize(); }`, exactly
// matching the IL the C# compiler emits for `~Type()`.
//
// This sample exercises the feature end-to-end:
//   * a leaf class that declares `deinit { … }`
//   * a derived class that also declares `deinit { … }` — each level's
//     destructor body runs, in derived-then-base order
//   * the deinit body reads instance fields (proving `this` is available)
//
// The trace below proves both finalizers ran when the GC collected the
// instances.

package GSharp.Example.Deinit

import System

type Resource open class(Tag string) {
    deinit {
        Console.WriteLine("Resource deinit: " + Tag)
    }
}

type CachedResource class : Resource {
    var CacheKey string = ""

    init(tag string, key string) : base(tag) {
        CacheKey = key
    }

    deinit {
        Console.WriteLine("CachedResource deinit: " + CacheKey)
    }
}

func Allocate() {
    var r = CachedResource("db", "users")
    Console.WriteLine("Allocated: " + r.Tag + "/" + r.CacheKey)
}

Allocate()
GC.Collect()
GC.WaitForPendingFinalizers()
Console.WriteLine("done")
