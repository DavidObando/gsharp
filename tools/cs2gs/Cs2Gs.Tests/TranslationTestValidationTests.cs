// <copyright file="TranslationTestValidationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.RoundTrip;
using Xunit;
using Xunit.Sdk;

namespace Cs2Gs.Tests;

/// <summary>
/// Tests for the default bind gate and deliberate round-trip-only escape hatch.
/// </summary>
public class TranslationTestValidationTests
{
    [Fact]
    public void AssertBinds_RejectsSourceThatParsesButDoesNotBind()
    {
        TrueException exception = Assert.Throws<TrueException>(
            () => TranslationTestValidation.AssertBinds("package Demo\nvar value = missing\n"));

        Assert.Contains("missing", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AssertBinds_RejectsUnboundReferenceInsideFunctionBody()
    {
        TrueException exception = Assert.Throws<TrueException>(
            () => TranslationTestValidation.AssertBinds(
                "package Demo\nfunc Run() {\n    let value = missing\n}\n"));

        Assert.Contains("missing", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ValidateRoundTripOnly_RequiresAJustification()
    {
        Assert.Throws<ArgumentException>(
            () => TranslationTestValidation.ValidateRoundTripOnly(
                "package Demo\nvar value = missing\n",
                reason: string.Empty));
    }

    [Fact]
    public void ValidateRoundTripOnly_AllowsDeliberateUnboundSource()
    {
        RoundTripResult result = TranslationTestValidation.ValidateRoundTripOnly(
            "package Demo\nvar value = missing\n",
            "This test proves the explicit parse-only escape hatch.");

        Assert.True(result.Success);
    }
}
