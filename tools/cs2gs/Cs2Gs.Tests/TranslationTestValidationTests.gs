// <copyright file="TranslationTestValidationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.RoundTrip
import System
import Xunit
import Xunit.Sdk

/// Tests for the default bind gate and deliberate round-trip-only escape hatch.
open class TranslationTestValidationTests {
    @Fact
    func AssertBinds_RejectsSourceThatParsesButDoesNotBind() {
        let exception = Assert.Throws[TrueException](
            func () object? {
                return TranslationTestValidation.AssertBinds(`package Demo
var value = missing
`)
            }
        )
        Assert.Contains("missing", exception.Message, StringComparison.Ordinal)
    }

    @Fact
    func AssertBinds_RejectsUnboundReferenceInsideFunctionBody() {
        let exception = Assert.Throws[TrueException](
            func () object? {
                return TranslationTestValidation.AssertBinds(`package Demo
func Run() {
    let value = missing
}
`)
            }
        )
        Assert.Contains("missing", exception.Message, StringComparison.Ordinal)
    }

    @Fact
    func ValidateRoundTripOnly_RequiresAJustification() {
        Assert.Throws[ArgumentException](
            func () object? {
                return TranslationTestValidation.ValidateRoundTripOnly(`package Demo
var value = missing
`, reason: string.Empty)
            }
        )
    }

    @Fact
    func ValidateRoundTripOnly_AllowsDeliberateUnboundSource() {
        let result = TranslationTestValidation.ValidateRoundTripOnly(`package Demo
var value = missing
`, "This test proves the explicit parse-only escape hatch.")
        Assert.True(result.Success)
    }
}
