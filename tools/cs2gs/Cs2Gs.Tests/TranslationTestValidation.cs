// <copyright file="TranslationTestValidation.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using Cs2Gs.CodeModel.RoundTrip;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Shared validation for G# emitted by cs2gs translation tests.
/// </summary>
internal static class TranslationTestValidation
{
    /// <summary>
    /// Asserts that emitted G# parses and binds without errors.
    /// </summary>
    /// <param name="sources">One or more emitted G# source files.</param>
    /// <returns>The first source's round-trip result for callers that retain detailed parse assertions.</returns>
    public static RoundTripResult AssertBinds(params string[] sources)
    {
        Assert.NotNull(sources);
        Assert.NotEmpty(sources);

        RoundTripResult firstResult = null;
        var trees = sources.Select((source, index) =>
        {
            RoundTripResult result = GSharpRoundTrip.Validate(source);
            firstResult ??= result;
            Assert.True(
                result.Success,
                $"Translated G# source {index + 1} must round-trip. Errors:\n"
                    + string.Join("\n", result.Errors) + "\n\nPrinted:\n" + source);
            return SyntaxTree.Parse(SourceText.From(source));
        }).ToImmutableArray();

        BoundGlobalScope scope = Binder.BindGlobalScope(previous: null, trees);
        var errors = scope.Diagnostics
            .Concat(Binder.BindProgram(scope).Diagnostics)
            .Where(diagnostic => diagnostic.IsError)
            .ToArray();
        Assert.True(
            errors.Length == 0,
            "Translated G# must bind without errors. Errors:\n"
                + string.Join("\n", errors.Select(error => error.ToString()))
                + "\n\nPrinted:\n" + string.Join("\n\n", sources));

        return firstResult;
    }

    /// <summary>
    /// Runs parse-only validation for a deliberate language gap.
    /// </summary>
    /// <param name="source">Emitted G# source.</param>
    /// <param name="reason">Why binding cannot gate this test.</param>
    /// <returns>The round-trip result for the caller to assert.</returns>
    public static RoundTripResult ValidateRoundTripOnly(string source, string reason)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(reason);
        return GSharpRoundTrip.Validate(source);
    }
}
