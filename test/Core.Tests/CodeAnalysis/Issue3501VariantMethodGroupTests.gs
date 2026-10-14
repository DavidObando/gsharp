// <copyright file="Issue3501VariantMethodGroupTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #3501 Track A5: generic inference accepts VARIANT method-group
/// candidates — a method may take a broader parameter type than the target
/// delegate (contravariance) and return a narrower one (covariance), exactly
/// as C# method-group conversions permit. Method-group arguments contribute
/// only output-type inference: their natural function type no longer
/// hard-unifies the delegate's parameter slots. Explicit type arguments
/// already accepted these groups; inference now matches.
open class Issue3501VariantMethodGroupTests {
    @Fact
    func ContravariantParameter_UnderInference_BindsAndRuns() {
        let source = `
import System.Collections.Generic
import System.Linq

class W {
    shared {
        func Stringify(value object?) string -> value?.ToString() ?? "<nil>"

        func Run() string {
            let paths = List[string]{ "a", "b" }
            return string.Join(",", paths.Select(Stringify))
        }
    }
}

W.Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("a,b", result.Value)
    }

    @Fact
    func ContravariantParameter_InPredicateSlot_BindsAndRuns() {
        let source = `
import System.Collections.Generic
import System.Linq

class W {
    shared {
        func IsShort(value object?) bool -> value?.ToString()?.Length < 2

        func Run() int32 {
            let paths = List[string]{ "a", "bb", "c" }
            return paths.Where(IsShort).Count()
        }
    }
}

W.Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(2, result.Value)
    }

    @Fact
    func CovariantReturn_IntoFixedDelegateSlot_BindsAndRuns() {
        let source = `
class W {
    shared {
        func Twice(s string) string -> s + s

        func Apply(f (string) -> object) object -> f("q")

        func Run() string -> Apply(Twice).ToString() ?? ""
    }
}

W.Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("qq", result.Value)
    }

    @Fact
    func ExactCandidate_StillPreferredOverVariant() {
        let source = `
import System.Collections.Generic
import System.Linq

class W {
    shared {
        func Mark(value object?) string -> "object"

        func Mark(value string) string -> "string"

        func Run() string {
            let paths = List[string]{ "a" }
            return paths.Select(Mark).First()
        }
    }
}

W.Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("string", result.Value)
    }

    @Fact
    func IncompatibleGroup_StillReportsResolutionFailure() {
        let source = `
import System.Collections.Generic
import System.Linq

class W {
    shared {
        func Weigh(value int32) string -> value.ToString()

        func Run() string {
            let paths = List[string]{ "a" }
            return paths.Select(Weigh).First()
        }
    }
}

W.Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.IsError)
    }
}
