// <copyright file="Issue4289NullableVariantMethodGroupTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #4289: a user method group whose nullable reference parameter is
/// broader than the target delegate parameter remains contravariant.
open class Issue4289NullableVariantMethodGroupTests {
    @Fact
    func NullableBaseParameter_IntoDerivedPredicate_BindsAndRuns() {
        const source = `import System.Collections.Immutable
import System.Linq

open class Animal { }
class Dog : Animal { }

class Checker {
    shared {
        func Check(a Animal?) bool -> a is Dog
    }
}

let values ImmutableArray[Dog] = ImmutableArray.Create(Dog())
values.Any(Checker.Check)`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(true, result.Value)
    }

    @Fact
    func PlatformBaseParameter_IntoDerivedPredicate_BindsAndRuns() {
        const source = `import System.Collections.Immutable
import System.Linq

open class Animal { }
class Dog : Animal { }

class Checker {
    shared {
        @Oblivious
        func Check(a Animal) bool -> a is Dog
    }
}

let values ImmutableArray[Dog] = ImmutableArray.Create(Dog())
values.Any(Checker.Check)`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(true, result.Value)
    }

    @Fact
    func NullableDerivedTarget_DoesNotAcceptNonNullableBaseParameter() {
        const source = `open class Animal { }
class Dog : Animal { }

class Checker {
    shared {
        func Check(a Animal) bool -> true
    }
}

func Use(check (Dog?) -> bool) bool -> check(nil)

Use(Checker.Check)`
        let result = EmittedOracle.Evaluate(source)
        let diagnostic = Assert.Single(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("GS0218", diagnostic.Id)
        Assert.Equal("Checker.Check", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }
}
