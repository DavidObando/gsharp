// <copyright file="Issue1262DiscardParameterBinderTests.cs" company="GSharp">
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
import System.Linq
import Xunit

/// Issue #1262 — a parameter list with more than one discard parameter named
/// `_` was wrongly rejected with GS0101 ("A parameter with the name '_'
/// already exists."). In C# `_` is a discard and repeated `_`
/// parameters are permitted (e.g. event handlers `(_, _) => ...`). G#
/// now allows repeated `_` discard parameters on both lambdas and named
/// functions/methods. Each `_` still occupies a positional slot but is not
/// added to the body's lookup scope, so referencing `_` does not bind to a
/// parameter and non-`_` duplicates still error.
open class Issue1262DiscardParameterBinderTests {
    @Fact
    func TwoDiscardLambdaParameters_NoGS0101() {
        let result = Evaluate("let h = (_ int32, _ int32) -> 0\n")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0101")
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func TwoDiscardNamedFunctionParameters_NoGS0101() {
        let result = Evaluate("func G(_ int32, _ int32) int32 { return 0 }\n")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0101")
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func MixedDiscardAndNamedLambdaParameters_NamedStillResolves_NoGS0101() {
        let result = Evaluate("let h = (_ int32, x int32) -> x\n")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0101")
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func RealDuplicateLambdaParameters_StillReportsGS0101() {
        let result = Evaluate("let h = (x int32, x int32) -> 0\n")
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0101")
    }

    @Fact
    func RealDuplicateNamedFunctionParameters_StillReportsGS0101() {
        let result = Evaluate("func G(x int32, x int32) int32 { return 0 }\n")
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0101")
    }

    @Fact
    func ReferencingDiscardParameter_DoesNotBind_NoGS0101() {
        // `_` is a discard: it is not added to the body scope, so referencing it
        // does NOT resolve to a parameter. The reference is an undefined-name
        // error (GS0125), never GS0101.
        let result = Evaluate("let h = (_ int32) -> _ + 1\n")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0101")
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0125")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            let prelude = "import System\n"
            return EmittedOracle.Evaluate(prelude + source)
        }
    }
}
