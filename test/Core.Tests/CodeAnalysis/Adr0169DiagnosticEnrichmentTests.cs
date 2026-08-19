// <copyright file="Adr0169DiagnosticEnrichmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Covers the ADR-0169 diagnostics enrichment: the Roslyn-shaped public
/// <see cref="DiagnosticDescriptor"/>, <see cref="Diagnostic.Create(DiagnosticDescriptor, TextLocation, object?[])"/>,
/// the <see cref="DiagnosticSeverity.Hidden"/> ordering, and the public
/// <see cref="DiagnosticBag.Report(Diagnostic)"/> entry point.
/// </summary>
public class Adr0169DiagnosticEnrichmentTests
{
    private static readonly DiagnosticDescriptor EnrichedRule = new(
        "TEST0001",
        "Test rule title",
        "Value '{0}' is suspicious.",
        "Testing",
        DiagnosticSeverity.Warning,
        isEnabledByDefault: false,
        description: "Longer description.",
        helpLinkUri: "https://example.invalid/TEST0001");

    [Fact]
    public void CompatConstructor_PreservesPreAdr0169Defaults()
    {
        var descriptor = new DiagnosticDescriptor("GS0001", DiagnosticSeverity.Error, "Bad character input: '{0}'.");

        Assert.Equal("GS0001", descriptor.Id);
        Assert.Equal("GS0001", descriptor.Title);
        Assert.Equal("Compiler", descriptor.Category);
        Assert.Equal(DiagnosticSeverity.Error, descriptor.DefaultSeverity);
        Assert.Equal(DiagnosticSeverity.Error, descriptor.Severity);
        Assert.True(descriptor.IsEnabledByDefault);
        Assert.Null(descriptor.Description);
        Assert.Null(descriptor.HelpLinkUri);
    }

    [Fact]
    public void Create_FormatsMessage_AndCarriesDescriptor()
    {
        var diagnostic = Diagnostic.Create(EnrichedRule, default, "answer");

        Assert.Same(EnrichedRule, diagnostic.Descriptor);
        Assert.Equal("TEST0001", diagnostic.Id);
        Assert.Equal(DiagnosticSeverity.Warning, diagnostic.Severity);
        Assert.Equal("Value 'answer' is suspicious.", diagnostic.Message);
        Assert.Empty(diagnostic.AdditionalLocations);
        Assert.Empty(diagnostic.Properties);
    }

    [Fact]
    public void Create_WithAdditionalLocationsAndProperties_PreservesBoth()
    {
        var extra = ImmutableArray.Create(default(TextLocation));
        var properties = ImmutableDictionary<string, string>.Empty.Add("fixKind", "removeRead");

        var diagnostic = Diagnostic.Create(EnrichedRule, default, extra, properties, "x");

        Assert.Single(diagnostic.AdditionalLocations);
        Assert.Equal("removeRead", diagnostic.Properties["fixKind"]);
    }

    [Fact]
    public void WithSeverity_PreservesDescriptorAndProperties()
    {
        var properties = ImmutableDictionary<string, string>.Empty.Add("k", "v");
        var diagnostic = Diagnostic.Create(EnrichedRule, default, ImmutableArray<TextLocation>.Empty, properties, "x");

        var promoted = diagnostic.WithSeverity(DiagnosticSeverity.Error);

        Assert.Equal(DiagnosticSeverity.Error, promoted.Severity);
        Assert.Same(EnrichedRule, promoted.Descriptor);
        Assert.Equal("v", promoted.Properties["k"]);
        Assert.Equal(diagnostic.Message, promoted.Message);
        Assert.Same(diagnostic, diagnostic.WithSeverity(DiagnosticSeverity.Warning));
    }

    [Fact]
    public void SeverityOrdering_IsHiddenInfoWarningError()
    {
        Assert.True(DiagnosticSeverity.Hidden < DiagnosticSeverity.Info);
        Assert.True(DiagnosticSeverity.Info < DiagnosticSeverity.Warning);
        Assert.True(DiagnosticSeverity.Warning < DiagnosticSeverity.Error);
    }

    [Fact]
    public void DiagnosticBag_Report_AddsConstructedDiagnostic()
    {
        var bag = new DiagnosticBag();
        var diagnostic = Diagnostic.Create(EnrichedRule, default, "x");

        bag.Report(diagnostic);

        Assert.Same(diagnostic, Assert.Single(bag.ToImmutableArray()));
    }

    [Fact]
    public void LegacyConstructor_HasNoDescriptor_AndEmptyBags()
    {
        var diagnostic = new Diagnostic(default, "GS0100", DiagnosticSeverity.Warning, "message");

        Assert.Null(diagnostic.Descriptor);
        Assert.Empty(diagnostic.AdditionalLocations);
        Assert.Empty(diagnostic.Properties);
    }
}
