// <copyright file="TranslatorExhaustivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Coverage;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests.Coverage;

/// <summary>
/// The translator-exhaustiveness contract (ADR-0138): the
/// <see cref="UnsupportedByDesign"/> registry and the construct inventory's
/// UnsupportedByDesign rows are the same set; every deliberately-rejected
/// fixture produces exactly the recorded by-design diagnostic; and an
/// unhandled construct that is NOT registered is classified as a gap
/// (<c>CS2GS-GAP</c>) — an accidental fallthrough can never masquerade as a
/// design decision.
/// </summary>
public class TranslatorExhaustivenessTests
{
    [Fact]
    public void Registry_MatchesInventoryUnsupportedRows()
    {
        ConstructInventory inventory = ConstructInventory.Load(InventoryPath());
        Dictionary<string, string> inventoryRows = inventory.Entries
            .Where(e => e.Status == ConstructStatus.UnsupportedByDesign)
            .ToDictionary(e => e.Kind, e => e.Rationale.ToString(), StringComparer.Ordinal);
        Dictionary<string, string> registryRows = UnsupportedByDesign.Snapshot()
            .ToDictionary(p => p.Key.ToString(), p => p.Value.ToString(), StringComparer.Ordinal);

        List<string> onlyInventory = inventoryRows.Keys.Except(registryRows.Keys, StringComparer.Ordinal)
            .OrderBy(k => k, StringComparer.Ordinal).ToList();
        List<string> onlyRegistry = registryRows.Keys.Except(inventoryRows.Keys, StringComparer.Ordinal)
            .OrderBy(k => k, StringComparer.Ordinal).ToList();
        List<string> mismatched = inventoryRows.Keys.Intersect(registryRows.Keys, StringComparer.Ordinal)
            .Where(k => inventoryRows[k] != registryRows[k])
            .Select(k => $"{k}: inventory={inventoryRows[k]} registry={registryRows[k]}")
            .ToList();

        Assert.True(
            onlyInventory.Count == 0 && onlyRegistry.Count == 0 && mismatched.Count == 0,
            "UnsupportedByDesign registry and inventory diverged.\n" +
            $"Only in inventory: {string.Join(", ", onlyInventory)}\n" +
            $"Only in registry: {string.Join(", ", onlyRegistry)}\n" +
            $"Rationale mismatches: {string.Join("; ", mismatched)}");
    }

    [Theory]
    [InlineData("MakeRefExpression")]
    [InlineData("RefTypeExpression")]
    [InlineData("RefValueExpression")]
    [InlineData("ArgListExpression")]
    public void UnsupportedFixture_ProducesByDesignDiagnostic(string kind)
    {
        string fixturePath = Path.Combine(
            RepoRoot(), "tools", "cs2gs", "Cs2Gs.Tests", "Fixtures", "Grid", "Unsupported", kind + ".cs");
        Assert.True(File.Exists(fixturePath), $"missing fixture {fixturePath}");

        TranslationContext context = Translate(File.ReadAllText(fixturePath));

        TranslationDiagnostic diagnostic = context.Diagnostics.FirstOrDefault(d =>
            d.IsUnsupported && d.ConstructKind == kind);
        Assert.True(
            diagnostic is not null,
            $"expected an Unsupported diagnostic for {kind}; got:\n" +
            string.Join("\n", context.Diagnostics.Select(d => d.ToString())));
        Assert.Equal(UnsupportedClassification.ByDesign, diagnostic.Classification);
        Assert.Equal(UnsupportedRationale.NoGsharpConstruct, diagnostic.Rationale);
    }

    [Fact]
    public void UnregisteredConstruct_IsClassifiedAsGap()
    {
        // The C# 14 `field` keyword (FieldExpression) currently has no
        // translation rule and is deliberately NOT in the
        // UnsupportedByDesign registry, so the choke point must classify
        // this as an accidental gap. If this construct gains a translation
        // (or a registry entry), swap the snippet for another unregistered
        // kind — the mechanism under test is the classification.
        TranslationContext context = Translate(
            "namespace S { public class C { public int P { get => field; set => field = value; } } }");

        TranslationDiagnostic diagnostic = context.Diagnostics.FirstOrDefault(d => d.IsUnsupported);
        Assert.True(
            diagnostic is not null,
            "expected the field-expression property to be unsupported; if it translates now, update this test's snippet.");
        Assert.Equal(UnsupportedClassification.Gap, diagnostic.Classification);
        Assert.Equal(UnsupportedRationale.None, diagnostic.Rationale);
    }

    [Fact]
    public void Registry_CoversOnlySurfaceKinds()
    {
        var surface = new HashSet<string>(RoslynSurface.NodeKindNames(), StringComparer.Ordinal);
        List<string> offSurface = UnsupportedByDesign.Snapshot().Keys
            .Select(k => k.ToString())
            .Where(k => !surface.Contains(k))
            .ToList();
        Assert.True(offSurface.Count == 0, "registry entries off the node surface: " + string.Join(", ", offSurface));
    }

    private static TranslationContext Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Fixture.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "fixture should bind with no C# errors:\n" + string.Join("\n", project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return context;
    }

    private static string InventoryPath() =>
        Path.Combine(RepoRoot(), ConstructInventory.RepoRelativePath.Replace('/', Path.DirectorySeparatorChar));

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(Path.GetDirectoryName(typeof(TranslatorExhaustivenessTests).Assembly.Location));
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "GSharp.sln")))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        throw new InvalidOperationException("GSharp.sln not found above the test assembly.");
    }
}
