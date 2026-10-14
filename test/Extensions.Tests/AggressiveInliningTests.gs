// <copyright file="AggressiveInliningTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Extensions.Tests

import Gsharp.Extensions.Sequences
import System
import System.Collections.Generic
import System.Linq
import System.Reflection
import System.Runtime.CompilerServices
import Xunit

/// Spot-check that the IL emits the (cref:MethodImplAttributes.AggressiveInlining)
/// flag on the helpers ADR-0084 marks as hot. This guards against accidental
/// removal of the attribute on the helpers that benefit most from inlining
/// across the Gsharp.Extensions assembly boundary.
/// @remarks Issue #806 ported `Gsharp.Extensions.Optional` and the transformer / terminal
/// helpers under `Gsharp.Extensions.Sequences` from C# to idiomatic G#.
/// Top-level extension funcs in G# lower to static methods on a compiler-
/// generated `<Program>` host typedef inside the package namespace; the
/// original C# host classes (`OptionalExtensions`, `SequenceExtensions`,
/// `SequenceValueExtensions`) no longer exist as real types. The tests
/// therefore resolve the host by `(namespace, <Program>)` reflection
/// instead of `typeof(OptionalExtensions)` etc. `Sequences` (the named class
/// for builders) is unaffected and still resolves via `typeof`.
open class AggressiveInliningTests {
    @Theory
    @MemberData("InlinedMethodCases")
    func HotHelper_HasAggressiveInliningFlag(declaringType Type, methodName string) {
        var matched = false
        for m in declaringType.GetMethods(BindingFlags.Public | BindingFlags.Static).Where(
            (m MethodInfo) -> m.Name == methodName
        ) {
            matched = true
            Assert.True(
                (m.MethodImplementationFlags & MethodImplAttributes.AggressiveInlining) != 0,
                "${declaringType.FullName}.$methodName is missing MethodImplOptions.AggressiveInlining (per ADR-0084)."
            )
        }
        Assert.True(matched, "${declaringType.FullName}.$methodName not found.")
    }

    @Theory
    @MemberData("NotInlinedMethodCases")
    func NonInlinedHelper_DoesNotHaveAggressiveInliningFlag(declaringType Type, methodName string) {
        var matched = false
        for m in declaringType.GetMethods(BindingFlags.Public | BindingFlags.Static).Where(
            (m MethodInfo) -> m.Name == methodName
        ) {
            matched = true
            Assert.False(
                (m.MethodImplementationFlags & MethodImplAttributes.AggressiveInlining) != 0,
                "${declaringType.FullName}.$methodName unexpectedly carries MethodImplOptions.AggressiveInlining (per ADR-0084)."
            )
        }
        Assert.True(matched, "${declaringType.FullName}.$methodName not found.")
    }

    shared {
        private let ExtensionsAssembly Assembly = typeof(Sequences).Assembly

        private func ResolveHost(namespaceName string) Type {
            // G# emits each package's free-standing functions into a
            // compiler-generated `<Program>` host typedef under the
            // package namespace. The angle brackets are part of the metadata
            // name; reflection's GetType() accepts them literally.
            let full = namespaceName + ".<Program>"
            return ExtensionsAssembly.GetType(full, throwOnError: true)!!
        }

        private let OptionalHost Type = ResolveHost("Gsharp.Extensions.Optional")
        private let SequencesHost Type = ResolveHost("Gsharp.Extensions.Sequences")
        private let InlinedMethods[](Type Type, Method string) = [](Type, string){
            (OptionalHost, "Map"),
            (OptionalHost, "FlatMap"),
            (OptionalHost, "OrElse"),
            (OptionalHost, "OrCompute"),
            (OptionalHost, "IfPresent"),
            (OptionalHost, "Filter"),
            (SequencesHost, "FirstOrNil"),
            (SequencesHost, "LastOrNil"),
            (SequencesHost, "SingleOrNil"),
            (SequencesHost, "Indexed"),
            (typeof(Sequences), "Of"),
            (typeof(Sequences), "Empty")
        }
        private let NotInlinedMethods[](Type Type, Method string) = [](Type, string){
            (OptionalHost, "OrThrow"),
            (SequencesHost, "Windowed"),
            (SequencesHost, "Chunked"),
            (SequencesHost, "Pairwise"),
            (SequencesHost, "Interleave"),
            (typeof(Sequences), "Range"),
            (typeof(Sequences), "RangeStep"),
            (typeof(Sequences), "Iterate"),
            (typeof(Sequences), "Repeat")
        }

        func InlinedMethodCases() IEnumerable[[]object] -> InlinedMethods.Select(
            func (pair(Type Type, Method string))[]object {
                return []object{pair.Type, pair.Method}
            }
        )

        func NotInlinedMethodCases() IEnumerable[[]object] -> NotInlinedMethods.Select(
            func (pair(Type Type, Method string))[]object {
                return []object{pair.Type, pair.Method}
            }
        )
    }
}
