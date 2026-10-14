// <copyright file="Issue1344ChannelReaderUserElementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Threading.Channels
import System.Threading.Tasks
import Xunit

/// Issue #1344: iterating `Channel[UserType].Reader.ReadAllAsync()` with
/// `await for` erased the user element type to `object`, so member
/// access on the loop variable failed `GS0158`. The `.Reader`
/// property surfaced an erased `ChannelReader[object]` whose
/// `ReadAllAsync()` yields `IAsyncEnumerable[object]`. The fix keeps
/// the symbolic `ChannelReader[UserType]` projection (sibling of
/// #1320/#1328). These binder tests mirror the issue repro; the user-element
/// case binds clean and the primitive-element control keeps working.
open class Issue1344ChannelReaderUserElementTests {
    @Fact
    func ReadAllAsync_UserElement_AwaitFor_MemberAccess_Binds() {
        // BUG: GS0158 — `messages` erased to object so `.NumEntries` not found.
        const source = `
package p
import System.Threading.Channels
import System.Threading.Tasks
class BufferEntry { prop NumEntries int32 { get; init; } }
class Reader {
    async func Consume(ch Channel[BufferEntry]) {
        await for messages in ch.Reader.ReadAllAsync() {
            let n = messages.NumEntries
        }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ReadAllAsync_PrimitiveElement_Control_Binds() {
        // Control: primitive element type was never affected.
        const source = `
package p
import System.Threading.Channels
import System.Threading.Tasks
class Reader {
    async func Consume(ch Channel[int32]) {
        await for n in ch.Reader.ReadAllAsync() {
            let m = n + 1
        }
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
        private func MetadataLoadContextResolver() ReferenceResolver {
            let paths = []string{
                typeof(object).Assembly.Location,
                typeof(Console).Assembly.Location,
                typeof(Channel).Assembly.Location,
                typeof(Task).Assembly.Location,
                typeof(System.Collections.Generic.List[_]).Assembly.Location
            }
                .Where((p string) -> !string.IsNullOrEmpty(p))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray()
            return ReferenceResolver.WithReferences(paths)
        }

        private func GetDiagnostics(source string) Issue1344ChannelReaderUserElementTests.ImmutableArrayOfDiagnostic {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(
                previous: nil,
                ImmutableArray.Create(tree),
                MetadataLoadContextResolver()
            )
            let program = Binder.BindProgram(globalScope, MetadataLoadContextResolver())
            let all = tree
                .Diagnostics
                .Concat(globalScope.Diagnostics)
                .Concat(program.Diagnostics)
                .Where((d Diagnostic) -> d.IsError)
                .ToImmutableArray()
            return Issue1344ChannelReaderUserElementTests.ImmutableArrayOfDiagnostic(all)
        }
    }
}
