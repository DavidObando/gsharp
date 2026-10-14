// <copyright file="TranslationTestValidation.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.RoundTrip
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Shared validation for G# emitted by cs2gs translation tests.
internal shared class TranslationTestValidation {
    /// Asserts that emitted G# parses and binds without errors.
    /// @param sources One or more emitted G# source files.
    /// @returns The first source's round-trip result for callers that retain detailed parse assertions.
    func AssertBinds(sources ...string) RoundTripResult? -> AssertBinds(references: nil, sources)

    /// Asserts that emitted G# parses and binds against explicit CLR references.
    /// @param references CLR references available to binding.
    /// @param sources One or more emitted G# source files.
    /// @returns The first source's round-trip result.
    func AssertBinds(references ReferenceResolver?, sources ...string) RoundTripResult? {
        Assert.NotNull(sources)
        Assert.NotEmpty(sources)
        var firstResult RoundTripResult? = nil
        let trees = sources.Select(
            (source string, index int32) -> {
                let result = GSharpRoundTrip.Validate(source)
                firstResult ??= result
                Assert.True(result.Success, (`Translated G# source ` + "${index + 1}" + ` must round-trip. Errors:
`) + string.Join("\n", result.Errors) + `

Printed:
` + source)
                return SyntaxTree.Parse(SourceText.From(source))
            }
        )
            .ToImmutableArray()
        let scope_ = Binder.BindGlobalScope(previous: nil, trees, references)
        let errors = scope_
            .Diagnostics
            .Concat(Binder.BindProgram(scope_, references).Diagnostics)
            .Where((diagnostic Diagnostic) -> diagnostic.IsError)
            .ToArray()
        Assert.True(
            errors.Length == 0,
            "Translated G# must bind without errors. Errors:\n" + string.Join(
                "\n",
                errors.Select((error Diagnostic) -> error.ToString())
            ) +
                `

Printed:
` +
                string.Join(`

`, sources)
        )
        return firstResult
    }

    /// Runs parse-only validation for a deliberate language gap.
    /// @param source Emitted G# source.
    /// @param reason Why binding cannot gate this test.
    /// @returns The round-trip result for the caller to assert.
    func ValidateRoundTripOnly(source string, reason string) RoundTripResult {
        ArgumentException.ThrowIfNullOrWhiteSpace(reason, paramName: "reason")
        return GSharpRoundTrip.Validate(source)
    }
}
