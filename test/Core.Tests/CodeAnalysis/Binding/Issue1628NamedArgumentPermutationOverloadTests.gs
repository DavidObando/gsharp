// <copyright file="Issue1628NamedArgumentPermutationOverloadTests.cs" company="GSharp">
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
import Xunit

/// Issue #1628: Phase-2 exact-match scoring in
/// `OverloadResolver.SelectBestUserOverloadCore` used to map
/// `boundArguments[i]` (source order) onto `cand.Parameters[i]`
/// (declaration order) even when the call used named arguments, so an
/// argument named for parameter `c` could be scored against a
/// different candidate's parameter that merely sits at the SAME source
/// index. Between two overloads whose parameters are a permutation of each
/// other, this let the wrong overload win by accidental positional type
/// coincidence, with no diagnostic. The fix maps each argument to its real
/// name-resolved parameter slot before scoring.
open class Issue1628NamedArgumentPermutationOverloadTests {
    @Fact
    func NamedArgs_PermutationOverloads_SelectsNameCorrectCandidate() {
        // F_Right(a int32, b string, c bool) is the only candidate that is an
        // EXACT type match for every argument once named args are resolved to
        // their real parameter (b -> string, c -> bool).
        //
        // F_Wrong(a int32, b bool, c string) only looks better under the OLD
        // buggy positional scoring: boundArguments[1] (c: true, a bool value)
        // happens to sit at F_Wrong's declaration slot 1 (also bool), and
        // boundArguments[2] (b: "s", a string value) happens to sit at slot 2
        // (also string) -- an accidental positional coincidence that used to
        // out-score the real match.
        const source = `
package p
func F(a int32, b string, c bool) int32 { return 100 }
func F(a int32, b bool, c string) int32 { return 200 }

let x = F(1, c: true, b: "s")
x
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(100, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
