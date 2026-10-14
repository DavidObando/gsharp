// <copyright file="Issue2859ClassTypedForInBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #2859: binder-level facts for `for x in source` over a
/// class-typed source. The duck-typed enumerable probe used to demand that
/// `GetEnumerator()` return ANOTHER user-declared type exposing
/// `Current` as a FIELD, so the ubiquitous
/// `GetEnumerator() IEnumerator[T]` shape reported
/// `GS0116: Type 'X' is not indexable`. The negative control pins the
/// widening: a class that is genuinely not enumerable must STILL report
/// GS0116, otherwise the fix would have degraded a real diagnostic into
/// silently broken lowering.
open class Issue2859ClassTypedForInBinderTests {
    @Fact
    func ForIn_ClassWithImportedEnumerator_Binds() {
        const source = `
package p
import System.Collections
import System.Collections.Generic
class Bag : IEnumerable[int32] {
    private let items List[int32]
    init() { items = List[int32]() }
    func GetEnumerator() IEnumerator[int32] -> items.GetEnumerator()
    private func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()
}
class C {
    func Sum(b Bag) int32 {
        var total = 0
        for x in b { total += x }
        return total
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ForIn_ClassWithGetEnumeratorOnly_Binds() {
        // No interface at all — the pure duck-typed shape.
        const source = `
package p
import System.Collections.Generic
class Duck {
    private let items List[int32]
    init() { items = List[int32]() }
    func GetEnumerator() IEnumerator[int32] -> items.GetEnumerator()
}
class C {
    func Sum(d Duck) int32 {
        var total = 0
        for x in d { total += x }
        return total
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ForIn_ConstructedGenericClass_SubstitutesEnumeratorElementType() {
        const source = `
package p
import System.Collections.Generic
class Item {
    prop Name string { get; init; }
}
class Bag[T any] {
    private let items List[T]
    init() { items = List[T]() }
    func GetEnumerator() IEnumerator[T] -> items.GetEnumerator()
}
class C {
    func FirstName(b Bag[Item]) string {
        for item in b { return item.Name }
        return ""
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ForIn_ClassWithUserDeclaredEnumerator_StillBinds() {
        // Control: the pre-existing user-declared-enumerator shape
        // (MoveNext() + a Current FIELD) must keep binding.
        const source = `
package p
class E {
    public var Current int32 = 0
    func MoveNext() bool -> false
}
class Coll {
    func GetEnumerator() E -> E()
}
class C {
    func Sum(c Coll) int32 {
        var total = 0
        for x in c { total += x }
        return total
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ForIn_NonEnumerableClass_StillReportsNotIndexable() {
        // Negative control (non-vacuity): the widening must not swallow the
        // real diagnostic for a class that exposes no enumerable shape.
        const source = `
package p
class Plain {
    prop N int32 { get; init; }
}
class C {
    func Sum(x Plain) int32 {
        var total = 0
        for v in x { total += 1 }
        return total
    }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0116")
    }

    shared {
        private func GetDiagnostics(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(compilation.BoundProgram.Diagnostics)
                .Where((d Diagnostic) -> d.IsError)
                .ToImmutableArray()
        }
    }
}
