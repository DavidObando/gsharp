// <copyright file="Issue1328DictionaryUserElementErasureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1328: enumerating a `Dictionary[K, V]` whose VALUE type
/// `V` is a same-compilation user type erased the element to
/// `System.Object` whenever the element type had to be INFERRED
/// (foreach / LINQ). Member access on the inferred element then failed
/// `GS0158` (cannot find member) and assignment failed `GS0155`
/// (cannot convert `object` to `V`). This is the
/// `Dictionary`/`ValueCollection` sibling of #1320 (which fixed the
/// same erasure for `sequence[T]` / `[]T`). The fix recovers the
/// symbolic `V` from the constructed-generic collection type
/// (`ValueCollection[K, V]`, `KeyCollection[K, V]`,
/// `KeyValuePair[K, V]`) instead of reflecting over the erased CLR
/// interface. These binder-level tests mirror the issue's repro matrix; every
/// formerly-broken inference form now binds clean, and the controls (explicit
/// element annotation, primitive value type, `List[E]`) keep working.
open class Issue1328DictionaryUserElementErasureTests {
    @Fact
    func ViaValues_ForIn_UserMember_Binds() {
        // BUG: GS0158 — `x` erased to object so `.Value` was not found.
        const source = `
package p
import System.Collections.Generic
import System.Linq
data class E(Value uint32) {}
class C {
    func ViaValues(d Dictionary[uint32, E]) uint32 {
        for x in d.Values { return x.Value }
        return 0
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ViaPair_ForIn_KeyValuePair_UserMember_Binds() {
        // BUG: GS0158 — single-var dict iteration must yield KeyValuePair[K, V]
        // whose `.Value` carries the user `V` and `.Key` the symbolic `K`.
        const source = `
package p
import System.Collections.Generic
import System.Linq
data class E(Value uint32) {}
class C {
    func ViaPair(d Dictionary[uint32, E]) uint32 {
        for kv in d { return kv.Key + kv.Value.Value }
        return 0
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ViaSingle_LinqTerminal_UserMember_Binds() {
        // BUG: GS0158 — `.Single()` return type erased to object.
        const source = `
package p
import System.Collections.Generic
import System.Linq
data class E(Value uint32) {}
class C {
    func ViaSingle(d Dictionary[uint32, E]) uint32 {
        let s = d.Values.Single()
        return s.Value
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ViaToList_Indexer_Assignment_Binds() {
        // BUG: GS0155 — `.ToList()[0]` typed as object could not convert to E.
        const source = `
package p
import System.Collections.Generic
import System.Linq
data class E(Value uint32) {}
class C {
    func ViaToList(d Dictionary[uint32, E]) E {
        return d.Values.ToList()[0]
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func TwoVar_ForIn_Destructures_To_UserValue_And_Key() {
        // The two-var form keeps destructuring into K and V; V must carry the
        // user type so `.Value` resolves.
        const source = `
package p
import System.Collections.Generic
data class E(Value uint32) {}
class C {
    func TwoVar(d Dictionary[uint32, E]) uint32 {
        for k, v in d { return k + v.Value }
        return 0
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func Keys_ForIn_UserKey_Member_Binds() {
        // `.Keys` (KeyCollection) over a user KEY type must surface the user
        // element so `.Value` resolves.
        const source = `
package p
import System.Collections.Generic
data class E(Value uint32) {}
class C {
    func ViaKeys(d Dictionary[E, uint32]) uint32 {
        for k in d.Keys { return k.Value }
        return 0
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func Controls_StillBind() {
        // Primitive value type, List[E], and explicit lambda-param annotation
        // were never broken; capture them as regression guards.
        const primitiveValues = `
package p
import System.Collections.Generic
import System.Linq
class C {
    func PrimValues(d Dictionary[uint32, int32]) int32 {
        for x in d.Values { return x }
        return 0
    }
}
`
        const listSingle = `
package p
import System.Collections.Generic
import System.Linq
data class E(Value uint32) {}
class C {
    func ListSingle(l List[E]) uint32 -> l.Single().Value
}
`
        const selectExplicit = `
package p
import System.Collections.Generic
import System.Linq
data class E(Value uint32) {}
class C {
    func SelectExplicit(d Dictionary[uint32, E]) uint32 -> d.Values.Select((e E) -> e.Value).First()
}
`
        Assert.Empty(GetDiagnostics(primitiveValues))
        Assert.Empty(GetDiagnostics(listSingle))
        Assert.Empty(GetDiagnostics(selectExplicit))
    }

    /// Thin wrapper so the test cases can call `Assert.Empty` against a
    /// (cref:ImmutableArray{T}) without exposing the GSharp diagnostic
    /// surface to xUnit's enumerable inference.
    private struct ImmutableArrayOfDiagnostic : IReadOnlyCollection[Diagnostic] {
        private let diagnostics ImmutableArray[Diagnostic]

        init(diagnostics ImmutableArray[Diagnostic]) {
            this.diagnostics = diagnostics
        }

        prop Count int32 -> this.diagnostics.Length

        func GetEnumerator() IEnumerator[Diagnostic] {
            for diagnostic in this.diagnostics {
                yield diagnostic
            }
        }

        private func (IEnumerable) GetEnumerator() IEnumerator {
            return GetEnumerator()
        }
    }

    shared {
        private func GetDiagnostics(source string) Issue1328DictionaryUserElementErasureTests
            .ImmutableArrayOfDiagnostic {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let parseDiagnostics = tree.Diagnostics
            let bindDiagnostics = compilation.GlobalScope.Diagnostics
            let programDiagnostics = compilation.BoundProgram.Diagnostics
            let all = parseDiagnostics
                .Concat(bindDiagnostics)
                .Concat(programDiagnostics)
                .Where((d Diagnostic) -> d.IsError)
                .ToImmutableArray()
            return Issue1328DictionaryUserElementErasureTests.ImmutableArrayOfDiagnostic(all)
        }
    }
}
