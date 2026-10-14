// <copyright file="Issue2126InlineOutVarMarkerLeakTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Runtime.InteropServices
import Xunit

/// Regression tests for issue #2126: the overload-resolution sentinel type
/// `ClrOverloadResolution+InlineOutVarArgumentMarker` must never escape the
/// binder into type projection or emit.
///
/// When an inline `out var` (or a pre-declared `out` whose pointee is a
/// same-compilation value type with no reference-context CLR type) is passed to a
/// generic method whose type parameter is inferable only from that `out`
/// slot — e.g. `Enum.TryParse<TEnum>(string, bool, out TEnum)` — the
/// sentinel marker was bound to `TEnum` during type inference and then
/// projected into the reference set's
/// (cref:System.Reflection.MetadataLoadContext). Projecting the
/// GSharp.Core-defined marker (which has no name in the reference set) threw
/// `InvalidOperationException`, surfaced as a fatal `GS9998` ICE.
///
/// The crash only reproduces on the `/reference:` resolver path (MLC), which
/// is why `Issue1601GenericEnumTryParseForwardTests` — running on the
/// host-runtime resolver — never caught it. The fix normalises the sentinel to
/// its erased (cref:object) form before a generic candidate is closed.
open class Issue2126InlineOutVarMarkerLeakTests {
    /// The minimal reproduction: a generic `Enum.TryParse<TEnum>` whose
    /// only type-parameter binding site is a pre-declared `out` argument of a
    /// same-compilation enum. Pre-fix this threw the `GS9998` marker-projection
    /// ICE under the MLC resolver.
    @Fact
    func GenericEnumTryParse_PredeclaredUserEnumOut_UnderMlc_DoesNotLeakMarker() {
        let source = `package Repro
import System

enum ECodec { A, B }

class ExCodec {
    shared {
        func TryParseCodec(format string?, out codec ECodec) bool {
            if format == nil {
                codec = default(ECodec)
                return false
            }
            return Enum.TryParse(format, true, &codec)
        }
    }
}`
        let diagnostics = EmitWithMlc(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9998")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    /// The inline `out var` variant: the type parameter is inferable only
    /// from the inline `out var` slot, whose element type is a
    /// same-compilation enum. Must bind without leaking the marker.
    @Fact
    func GenericEnumTryParse_InlineOutVarUserEnum_UnderMlc_DoesNotLeakMarker() {
        let source = `package Repro
import System

enum EStatus { Off, On }

class Reader {
    shared {
        func Read(text string) string {
            if Enum.TryParse[EStatus](text, out var status) {
                return status.ToString()
            }
            return ""
        }
    }
}`
        let diagnostics = EmitWithMlc(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9998")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    /// The originally-reported shape: an inline `out var` passed to
    /// `Dictionary<TKey, TValue>.TryGetValue` where the receiver is a
    /// qualified static field and the value type is a same-compilation enum. Must
    /// bind cleanly under the MLC resolver with no marker leak.
    @Fact
    func DictionaryTryGetValue_QualifiedStaticFieldReceiver_UserEnumValue_UnderMlc_DoesNotLeakMarker() {
        let source = `package Repro
import System
import System.Collections.Generic

enum EPseudoAsinId { None, First }

class BookDbContext {
    shared {
        let PseudoAsinsValue Dictionary[Type, EPseudoAsinId] = Dictionary[Type, EPseudoAsinId]()

        func Lookup(t Type) string {
            let succ = BookDbContext.PseudoAsinsValue.TryGetValue(t, out var pseudoAsinId)
            if succ {
                return pseudoAsinId.ToString()
            }
            return ""
        }
    }
}`
        let diagnostics = EmitWithMlc(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    shared {
        /// Build a (cref:ReferenceResolver) rooted at the full shared-
        /// framework assembly set, forcing gsc into the
        /// (cref:System.Reflection.MetadataLoadContext) resolution path —
        /// the same path the cs2gs migration pipeline and the MSBuild task drive
        /// gsc through via `/reference:`. The full closure is required to
        /// reproduce issue #2126: with only a handful of assemblies the leaking
        /// `Enum.TryParse` candidate is not projected through the load context.
        private func MetadataLoadContextResolver() ReferenceResolver {
            let runtimeDir = RuntimeEnvironment.GetRuntimeDirectory()
            let paths = Directory.GetFiles(runtimeDir, "*.dll")
            return ReferenceResolver.WithReferences(paths)
        }

        private func EmitWithMlc(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(MetadataLoadContextResolver(), tree)
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            return result.Diagnostics
        }
    }
}
