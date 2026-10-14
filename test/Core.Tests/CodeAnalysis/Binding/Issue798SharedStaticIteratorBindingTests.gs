// <copyright file="Issue798SharedStaticIteratorBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #798 / ADR-0084 §L5: `yield` inside a generic iterator
/// method — including a shared-static method on a class — must bind
/// the yielded expression against the symbolic element type
/// (`T`), not the type-erased `object` form of the return
/// type's (cref:System.Type).
///
/// Pre-fix the binder's iterator-element-type extraction
/// (`StatementBinder.GetIteratorElementType`) only inspected
/// `function.Type.ClrType`. For a method whose return type is
/// `IEnumerable[T]` with an in-scope generic `T`, ClrType
/// is the erased `IEnumerable<object>`, so the element type
/// resolved to `object` and `yield v` (where `v` is
/// typed `T`) failed with `GS0155: Cannot convert type 'T' to
/// 'object'`. The fix honors the symbolic
/// (cref:ImportedTypeSymbol.TypeArguments) (#313) so the
/// element type round-trips as `T`.
///
/// Coverage spans the four iterator return-type spellings —
/// `IEnumerable[T]`, `sequence[T]`,
/// `IAsyncEnumerable[T]` (with `async`), and
/// `async sequence[T]` — across top-level `func`, instance
/// methods, and shared-static methods. `yield break` inside a
/// shared-static iterator is also covered.
open class Issue798SharedStaticIteratorBindingTests {
    @Fact
    func Repro_From_Issue_GenericSharedStatic_IEnumerableT_Binds() {
        // Exact repro from issue #798. Pre-fix this surfaced as
        // "Cannot convert type 'T' to 'object'" inside the binder
        // (and as GS9998 "Unexpected statement: YieldStatement"
        // through the gsc interpreter path because the CFG builder
        // also did not recognize BoundYieldStatement).
        const source = `
package P
import System
import System.Collections.Generic

class Sequences {
    shared {
        func Empty[T any]() IEnumerable[T] {
            for v in []T{} {
                yield v
            }
        }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func GenericSharedStatic_IEnumerableT_With_YieldT_Binds() {
        const source = `
package P
import System
import System.Collections.Generic

class Sequences {
    shared {
        func Of[T any](v T) IEnumerable[T] {
            yield v
        }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func GenericSharedStatic_SequenceT_With_YieldT_Binds() {
        // `sequence[T]` is the G# alias for `IEnumerable[T]` and is
        // already a SequenceTypeSymbol with a non-erased element type,
        // so this path bound pre-fix too — captured here as a
        // regression guard.
        const source = `
package P
import System

class Sequences {
    shared {
        func Of[T any](v T) sequence[T] {
            yield v
        }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func GenericSharedStatic_IAsyncEnumerableT_With_Async_YieldT_Binds() {
        const source = `
package P
import System
import System.Collections.Generic

class Sequences {
    shared {
        async func Of[T any](v T) IAsyncEnumerable[T] {
            yield v
        }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func GenericSharedStatic_AsyncSequenceT_With_YieldT_Binds() {
        // ADR-0041: inside an `async func`, the `sequence[T]` return
        // type clause resolves to `IAsyncEnumerable[T]`. For an in-scope
        // generic T this is an AsyncSequenceTypeSymbol whose ClrType is
        // null, which pre-fix made the binder's iterator-return-type
        // predicates miss it ("yield not allowed outside iterator").
        const source = `
package P
import System

class Sequences {
    shared {
        async func Of[T any](v T) sequence[T] {
            yield v
        }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func NonGenericSharedStatic_IEnumerableInt32_Binds() {
        // Regression guard: the non-generic case worked pre-fix. Keep
        // it covered alongside the generic cases so future refactors
        // don't break the closed shape while focusing on the open one.
        const source = `
package P
import System
import System.Collections.Generic

class Sequences {
    shared {
        func Take3() IEnumerable[int32] {
            yield 1
            yield 2
            yield 3
        }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func GenericTopLevel_IEnumerableT_With_YieldT_Binds() {
        // The same bug surfaced on top-level generic iterators too.
        // The issue narrative diagnosed it as shared-static only, but
        // the root cause is in StatementBinder.GetIteratorElementType
        // which has no shared/instance/top-level distinction.
        const source = `
package P
import System
import System.Collections.Generic

func Of[T any](v T) IEnumerable[T] {
    yield v
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func GenericInstanceMethod_IEnumerableT_With_YieldT_Binds() {
        const source = `
package P
import System
import System.Collections.Generic

class Box {
    func Of[T any](v T) IEnumerable[T] {
        yield v
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func GenericSharedStatic_Yielded_Element_Has_TypeParameter_Symbol() {
        // Drill into the bound body: the BoundYieldStatement's
        // expression must carry the symbolic T as its type, not the
        // ObjectSymbol that the pre-fix element-type extraction
        // produced.
        const source = `
package P
import System
import System.Collections.Generic

class Sequences {
    shared {
        func Of[T any](v T) IEnumerable[T] {
            yield v
        }
    }
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        let program = compilation.BoundProgram
        Assert.False(
            program.Diagnostics.Any((d Diagnostic) -> d.IsError),
            string.Join("; ", program.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        let sequencesStruct = program.Structs.Single((s StructSymbol) -> s.Name == "Sequences")
        let ofMethod = sequencesStruct.StaticMethods.Single((m FunctionSymbol) -> m.Name == "Of")
        let body = program.Functions[ofMethod]
        let yields = CollectYieldExpressions(body)
        Assert.Single(yields)
        let yielded = yields[0]
        Assert.NotNull(yielded.Type)
        Assert.IsType[TypeParameterSymbol](yielded.Type)
        Assert.Equal("T", yielded.Type.Name)
    }

    private class YieldExpressionCollector : BoundTreeWalker {
        init() {
            Expressions = List[BoundExpression]()
        }

        prop Expressions List[BoundExpression] {
            get;
        }

        protected override func VisitYieldStatement(node BoundYieldStatement) {
            if node.Expression != nil {
                Expressions.Add(node.Expression)
            }
            base.VisitYieldStatement(node)
        }
    }

    /// Thin wrapper used so the test cases can call `Assert.Empty`
    /// against a (cref:ImmutableArray{T}) without exposing the
    /// GSharp diagnostic surface to xUnit's enumerable inference.
    private struct ImmutableArrayOfDiagnostic : IReadOnlyCollection[Diagnostic] {
        private let diagnostics ImmutableArray[Diagnostic]

        init(diagnostics ImmutableArray[Diagnostic]) {
            this.diagnostics = diagnostics
        }

        prop Count int32 -> this.diagnostics.Length

        func GetEnumerator() IEnumerator[Diagnostic] {
            for d in this.diagnostics {
                yield d
            }
        }

        private func (IEnumerable) GetEnumerator() IEnumerator -> this.GetEnumerator()
    }

    shared {
        private func CollectYieldExpressions(body BoundStatement) List[BoundExpression] {
            let collector = Issue798SharedStaticIteratorBindingTests.YieldExpressionCollector()
            collector.Visit(body)
            return collector.Expressions
        }

        private func GetDiagnostics(source string) Issue798SharedStaticIteratorBindingTests.ImmutableArrayOfDiagnostic {
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
            return Issue798SharedStaticIteratorBindingTests.ImmutableArrayOfDiagnostic(all)
        }
    }
}
