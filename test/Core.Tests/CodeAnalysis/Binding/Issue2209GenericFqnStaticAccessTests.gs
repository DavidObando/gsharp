// <copyright file="Issue2209GenericFqnStaticAccessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Collections.Immutable
import Xunit

/// Regression tests for issue #2209: static member access through a
/// fully-qualified GENERIC type name (`Ns.Sub.Generic[Args].StaticMember`)
/// failed with GS0157 ("Cannot find type System") because
/// `TryBindImportAccessor`'s dotted-namespace walk only recognised a
/// plain (cref:NameExpressionSyntax) segment; a generic-instantiation
/// segment (`Comparer[int32]`, parsed as an (cref:IndexExpressionSyntax)
/// or a (cref:GenericNameExpressionSyntax)) fell through to the
/// default case and aborted the whole walk at the FIRST segment
/// (`System`). The non-generic FQN static-access form
/// (`System.Text.Encoding.UTF8`) and the FQN generic CONSTRUCTION form
/// (`System.Collections.Generic.List[int32]()`) already worked; this bug
/// was isolated to the generic-instantiation + static-member combination.
open class Issue2209GenericFqnStaticAccessTests {
    @Fact
    func QualifiedGenericComparerDefault_Compare_Binds() {
        // The exact repro from the issue.
        let source = "package T\nfunc F() int32 { return System.Collections.Generic.Comparer[int32].Default.Compare(1, 2) }"
        Assert.Empty(Bind(source))
    }

    @Fact
    func UnqualifiedGenericComparerDefault_Compare_StillBinds_Control() {
        // Control: the same code with an import already worked before the fix
        // and must keep working after it.
        let source = `package T
import System.Collections.Generic
func F() int32 { return Comparer[int32].Default.Compare(1, 2) }`
        Assert.Empty(Bind(source))
    }

    @Fact
    func QualifiedGenericEqualityComparerDefault_Equals_Binds() {
        // Variation: a different imported generic type, and a further member
        // access (`.Equals`) chained after the static member (`.Default`) —
        // mirrors the real-world CommunityToolkit.Mvvm-generated shape from
        // the issue (`EqualityComparer<T>.Default.Equals(...)`).
        let source = `package T
func F(message string, value string) bool {
    return System.Collections.Generic.EqualityComparer[string].Default.Equals(message, value)
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func QualifiedGenericImmutableDictionaryEmpty_Count_Binds() {
        // Variation: a two-type-argument generic (different arity than the
        // repro's single-argument `Comparer[int32]`), plus a further member
        // access chained after the static member.
        let source = "package T\nfunc F() int32 { return System.Collections.Immutable.ImmutableDictionary[string, int32].Empty.Count }"
        Assert.Empty(Bind(source))
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let result = EmittedOracle.Evaluate(source)
            return result.Diagnostics
        }
    }
}
