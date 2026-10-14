// <copyright file="Issue2111FieldInitializerAccessibilityTests.cs" company="GSharp">
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

/// Issue #2111: a static field/property initializer inside a `shared { }`
/// block is bound outside any function body, so no "current type" was
/// established for the accessibility gate
/// ((cref:AccessibilityChecker.IsAccessible)). As a result a
/// `private` member of the ENCLOSING type accessed through a type-qualified
/// receiver (`Type.Member`) or a constructor call (`Type()`) was
/// wrongly rejected with GS0472 — even though an unqualified call in the same
/// initializer, and both access forms from a `shared` function body,
/// already worked. The fix threads the enclosing type through the accessibility
/// context while binding field/property initializers.
open class Issue2111FieldInitializerAccessibilityTests {
    @Fact
    func SharedFieldInitializer_QualifiedPrivateStaticCall_NoGS0472() {
        let source = `
class ApplEnv {
    shared {
        let OSVersion int32 = ApplEnv.GetOsVersion()
        private func GetOsVersion() int32 {
            return 42
        }
    }
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func SharedFieldInitializer_PrivateConstructorCall_NoGS0472() {
        let source = `
class Logging {
    private init() {
    }
    shared {
        private let Instance Logging = Logging()
    }
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func SharedFieldInitializer_UnqualifiedPrivateStaticCall_NoGS0472() {
        let source = `
class ApplEnv2 {
    shared {
        let OSVersion int32 = GetOsVersion()
        private func GetOsVersion() int32 {
            return 42
        }
    }
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func ExternalCode_QualifiedPrivateStaticCallInInitializer_StillReportsGS0472() {
        let source = `
class Foo {
    shared {
        private func Secret() int32 {
            return 42
        }
    }
}

class Bar {
    shared {
        let Value int32 = Foo.Secret()
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
