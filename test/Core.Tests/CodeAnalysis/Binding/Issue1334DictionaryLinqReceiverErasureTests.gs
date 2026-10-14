// <copyright file="Issue1334DictionaryLinqReceiverErasureTests.cs" company="GSharp">
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

/// Issue #1334 (follow-up to #1328): when a `Dictionary[K, V].Values` /
/// `.Keys` collection over a same-compilation user element `V` / `K`
/// is used as the RECEIVER of a LINQ operator (`.Select`, `.Where`,
/// `.OrderBy`, …), the projected/result element type erased to
/// `System.Object`. A subsequent member access on the loop / chain variable
/// then failed `GS0159` (cannot find function) or `GS0158` even though
/// the source element type is the symbolic user type and the lambda is
/// explicitly annotated.
///
/// Root cause: the LINQ overload's generic inference reflected over the receiver's
/// type-erased CLR `IEnumerable<object>` shape and inferred
/// `TSource = object`, which poisoned the projection result `TResult` to
/// `object`. The fix unifies the arrow/lambda argument
/// (`FunctionTypeSymbol`) against the open delegate formal
/// (`Func<TSource, TResult>`) during symbolic method-type-argument
/// inference, so `TResult` recovers the same-compilation user type from the
/// lambda's symbolic return while the receiver supplies `TSource`.
///
/// These binder-level tests mirror the issue's repro matrix; every formerly-broken
/// LINQ-receiver form now binds clean. Controls (projection to a primitive, a
/// `List[E]` receiver, and the direct non-LINQ enumeration) keep working.
open class Issue1334DictionaryLinqReceiverErasureTests {
    @Fact
    func ValuesSelect_ProjectsUserType_ForIn_UserMember_Binds() {
        // BUG: GS0159 — `.Select` projection result erased to object so the
        // loop variable lost the user `Filter` identity and `.Go()` was not found.
        const source = `
package p
import System.Collections.Generic
import System.Linq
class Filter { func Go() {} }
class Entry { prop FirstFilter Filter -> Filter() }
class C {
    func ViaSelect(d Dictionary[uint32, Entry]) {
        for f in d.Values.Select((e Entry) -> e.FirstFilter) { f.Go() }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ValuesWhere_ForIn_UserMember_Binds() {
        // BUG: GS0159/GS0158 — `.Where` result element erased to object.
        const source = `
package p
import System.Collections.Generic
import System.Linq
class Filter { func Go() {} }
class Entry { prop FirstFilter Filter -> Filter() }
class C {
    func ViaWhere(d Dictionary[uint32, Entry]) {
        for e in d.Values.Where((x Entry) -> true) { e.FirstFilter.Go() }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ValuesWhereThenSelect_Chained_ForIn_UserMember_Binds() {
        // BUG: GS0159 — the chained `.Where(...).Select(...)` projection result
        // erased to object across both operators.
        const source = `
package p
import System.Collections.Generic
import System.Linq
class Filter { func Go() {} }
class Entry { prop FirstFilter Filter -> Filter() }
class C {
    func Chained(d Dictionary[uint32, Entry]) {
        for f in d.Values.Where((x Entry) -> true).Select((e Entry) -> e.FirstFilter) { f.Go() }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ValuesSelect_ThenLinqTerminal_UserMember_Binds() {
        // BUG: GS0159 — `.Select(...).First()` terminal returned object.
        const source = `
package p
import System.Collections.Generic
import System.Linq
class Filter { func Go() {} }
class Entry { prop FirstFilter Filter -> Filter() }
class C {
    func SelectFirst(d Dictionary[uint32, Entry]) {
        d.Values.Select((e Entry) -> e.FirstFilter).First().Go()
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ValuesSelect_OrderBy_ForIn_UserMember_Binds() {
        // BUG: GS0159 — `.OrderBy` on a user-projected sequence erased the
        // ordered element to object.
        const source = `
package p
import System.Collections.Generic
import System.Linq
class Filter { prop Tag uint32 -> 0 func Go() {} }
class Entry { prop FirstFilter Filter -> Filter() }
class C {
    func ViaOrderBy(d Dictionary[uint32, Entry]) {
        for f in d.Values.Select((e Entry) -> e.FirstFilter).OrderBy((g Filter) -> g.Tag) { f.Go() }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func KeysSelect_ProjectsUserType_ForIn_UserMember_Binds() {
        // BUG: GS0159 — `.Keys` receiver erased the user key element through
        // the `.Select` projection.
        const source = `
package p
import System.Collections.Generic
import System.Linq
class Filter { func Go() {} }
class Entry { prop FirstFilter Filter -> Filter() }
class C {
    func ViaKeys(d Dictionary[Entry, uint32]) {
        for f in d.Keys.Select((e Entry) -> e.FirstFilter) { f.Go() }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ListSelect_ProjectsUserType_ForIn_UserMember_Binds() {
        // Sibling: a plain List[Entry] LINQ receiver projecting to a user type
        // shares the same recovery path.
        const source = `
package p
import System.Collections.Generic
import System.Linq
class Filter { func Go() {} }
class Entry { prop FirstFilter Filter -> Filter() }
class C {
    func ViaList(items List[Entry]) {
        for f in items.Select((e Entry) -> e.FirstFilter) { f.Go() }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func Controls_PrimitiveProjection_And_DirectEnumeration_Bind() {
        // Control 1: projecting to a primitive still binds (closed-CLR path).
        const primitiveProjection = `
package p
import System.Collections.Generic
import System.Linq
data class E(Value uint32) {}
class C {
    func SelectPrimitive(d Dictionary[uint32, E]) uint32 -> d.Values.Select((e E) -> e.Value).First()
}
`
        // Control 2: direct (non-LINQ) enumeration of the user values keeps
        // working (#1328).
        const directEnumeration = `
package p
import System.Collections.Generic
import System.Linq
data class E(Value uint32) {}
class C {
    func Direct(d Dictionary[uint32, E]) uint32 {
        for x in d.Values { return x.Value }
        return 0
    }
}
`
        Assert.Empty(GetDiagnostics(primitiveProjection))
        Assert.Empty(GetDiagnostics(directEnumeration))
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
        private func GetDiagnostics(source string) Issue1334DictionaryLinqReceiverErasureTests
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
            return Issue1334DictionaryLinqReceiverErasureTests.ImmutableArrayOfDiagnostic(all)
        }
    }
}
