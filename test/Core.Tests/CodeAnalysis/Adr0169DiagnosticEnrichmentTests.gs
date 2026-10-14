// <copyright file="Adr0169DiagnosticEnrichmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// Covers the ADR-0169 diagnostics enrichment: the Roslyn-shaped public
/// (cref:DiagnosticDescriptor), (cref:Diagnostic.Create(DiagnosticDescriptor, TextLocation,
/// object?[])),
/// the (cref:DiagnosticSeverity.Hidden) ordering, and the public
/// (cref:DiagnosticBag.Report(Diagnostic)) entry point.
open class Adr0169DiagnosticEnrichmentTests {
    @Fact
    func CompatConstructor_PreservesPreAdr0169Defaults() {
        let descriptor = DiagnosticDescriptor("GS0001", DiagnosticSeverity.Error, "Bad character input: '{0}'.")
        Assert.Equal("GS0001", descriptor.Id)
        Assert.Equal("GS0001", descriptor.Title)
        Assert.Equal("Compiler", descriptor.Category)
        Assert.Equal(DiagnosticSeverity.Error, descriptor.DefaultSeverity)
        Assert.Equal(DiagnosticSeverity.Error, descriptor.Severity)
        Assert.True(descriptor.IsEnabledByDefault)
        Assert.Null(descriptor.Description)
        Assert.Null(descriptor.HelpLinkUri)
    }

    @Fact
    func Create_FormatsMessage_AndCarriesDescriptor() {
        let diagnostic = Diagnostic.Create(EnrichedRule, default(TextLocation), "answer")
        Assert.Same(EnrichedRule, diagnostic.Descriptor)
        Assert.Equal("TEST0001", diagnostic.Id)
        Assert.Equal(DiagnosticSeverity.Warning, diagnostic.Severity)
        Assert.Equal("Value 'answer' is suspicious.", diagnostic.Message)
        Assert.Empty(diagnostic.AdditionalLocations)
        Assert.Empty(diagnostic.Properties)
    }

    @Fact
    func Create_WithAdditionalLocationsAndProperties_PreservesBoth() {
        let extra = ImmutableArray.Create(default(TextLocation))
        let properties = ImmutableDictionary[string, string].Empty.Add("fixKind", "removeRead")
        let diagnostic = Diagnostic.Create(EnrichedRule, default(TextLocation), extra, properties, "x")
        Assert.Single(diagnostic.AdditionalLocations)
        Assert.Equal("removeRead", diagnostic.Properties["fixKind"])
    }

    @Fact
    func WithSeverity_PreservesDescriptorAndProperties() {
        let properties = ImmutableDictionary[string, string].Empty.Add("k", "v")
        let diagnostic = Diagnostic.Create(
            EnrichedRule,
            default(TextLocation),
            ImmutableArray[TextLocation].Empty,
            properties,
            "x"
        )
        let promoted = diagnostic.WithSeverity(DiagnosticSeverity.Error)
        Assert.Equal(DiagnosticSeverity.Error, promoted.Severity)
        Assert.Same(EnrichedRule, promoted.Descriptor)
        Assert.Equal("v", promoted.Properties["k"])
        Assert.Equal(diagnostic.Message, promoted.Message)
        Assert.Same(diagnostic, diagnostic.WithSeverity(DiagnosticSeverity.Warning))
    }

    @Fact
    func SeverityOrdering_IsHiddenInfoWarningError() {
        Assert.True(DiagnosticSeverity.Hidden < DiagnosticSeverity.Info)
        Assert.True(DiagnosticSeverity.Info < DiagnosticSeverity.Warning)
        Assert.True(DiagnosticSeverity.Warning < DiagnosticSeverity.Error)
    }

    @Fact
    func DiagnosticBag_Report_AddsConstructedDiagnostic() {
        let bag = DiagnosticBag()
        let diagnostic = Diagnostic.Create(EnrichedRule, default(TextLocation), "x")
        bag.Report(diagnostic)
        Assert.Same(diagnostic, Assert.Single(bag.ToImmutableArray()))
    }

    @Fact
    func LegacyConstructor_HasNoDescriptor_AndEmptyBags() {
        let diagnostic = Diagnostic(default(TextLocation), "GS0100", DiagnosticSeverity.Warning, "message")
        Assert.Null(diagnostic.Descriptor)
        Assert.Empty(diagnostic.AdditionalLocations)
        Assert.Empty(diagnostic.Properties)
    }

    shared {
        private let EnrichedRule DiagnosticDescriptor = DiagnosticDescriptor(
            "TEST0001",
            "Test rule title",
            "Value '{0}' is suspicious.",
            "Testing",
            DiagnosticSeverity.Warning,
            isEnabledByDefault: false,
            description: "Longer description.",
            helpLinkUri: "https://example.invalid/TEST0001"
        )
    }
}
