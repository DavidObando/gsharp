// <copyright file="Issue1423UserCollectionInterfaceExtensionTests.cs" company="GSharp">
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

/// Issue #1423: LINQ extension methods (`OrderBy`, `Where`,
/// `Select`, …) resolve on a concrete `List[T]` but failed
/// `GS0159` on a user-defined class that implements a generic collection
/// interface such as `IReadOnlyCollection[T]` (which extends
/// `IEnumerable[T]`). They should bind via the inherited base interface
/// `IEnumerable[TSource]`.
///
/// Root cause: a user class with no imported base class erased to
/// `System.Object` for the extension-call receiver slot, so the
/// `this IEnumerable<TSource>` self-parameter could not match and
/// `TSource` could not be inferred. The fix projects the receiver to the
/// most-derived implemented CLR collection interface so overload resolution
/// recovers the element type.
open class Issue1423UserCollectionInterfaceExtensionTests {
    @Fact
    func OrderBy_OnUserReadOnlyCollection_Binds() {
        // BUG: GS0159 — `.OrderBy` self-param `IEnumerable<TSource>` unmatched
        // because EntryList erased to System.Object.
        const source = `
package p
import System.Collections
import System.Collections.Generic
import System.Linq
class Entry { prop Off int64 }
class EntryList : IReadOnlyCollection[Entry] {
    prop Count int32 -> 0
    func GetEnumerator() IEnumerator[Entry] -> List[Entry]().GetEnumerator()
    private func GetEnumerator() IEnumerator -> GetEnumerator()
}
class C {
    func F(e EntryList) {
        let c = e.OrderBy((s Entry) -> s.Off).ToList()
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func Where_Select_Count_OnUserReadOnlyCollection_Bind() {
        const source = `
package p
import System.Collections
import System.Collections.Generic
import System.Linq
class Entry { prop Off int64 }
class EntryList : IReadOnlyCollection[Entry] {
    prop Count int32 -> 0
    func GetEnumerator() IEnumerator[Entry] -> List[Entry]().GetEnumerator()
    private func GetEnumerator() IEnumerator -> GetEnumerator()
}
class C {
    func F(e EntryList) {
        let a = e.Where((s Entry) -> s.Off > 0).ToList()
        let b = e.Select((s Entry) -> s.Off).ToList()
        let n = e.Count((s Entry) -> s.Off > 0)
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func Select_OnUserDirectEnumerable_Binds() {
        // A class implementing IEnumerable[T] directly must keep working.
        const source = `
package p
import System.Collections
import System.Collections.Generic
import System.Linq
class Entry { prop Off int64 }
class DirectList : IEnumerable[Entry] {
    func GetEnumerator() IEnumerator[Entry] -> List[Entry]().GetEnumerator()
    private func GetEnumerator() IEnumerator -> GetEnumerator()
}
class C {
    func G(d DirectList) {
        let a = d.Select((s Entry) -> s.Off).ToList()
        let b = d.Where((s Entry) -> s.Off > 0).ToList()
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func OrderBy_OnConcreteList_StillBinds() {
        // Control: the concrete List[T] receiver path was never broken.
        const source = `
package p
import System.Collections.Generic
import System.Linq
class C {
    func F(xs List[int32]) {
        let c = xs.OrderBy((s int32) -> s).ToList()
    }
}
`
        Assert.Empty(GetDiagnostics(source))
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
        private func GetDiagnostics(source string) Issue1423UserCollectionInterfaceExtensionTests
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
            return Issue1423UserCollectionInterfaceExtensionTests.ImmutableArrayOfDiagnostic(all)
        }
    }
}
