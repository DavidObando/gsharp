// <copyright file="Issue2436ExplicitInterfacePrimaryConstructorLiftTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #2436: a same-named explicit-interface forwarder must survive beside
/// the ordinary property. Issue #2746 now keeps the explicit constructor and
/// both properties rather than collapsing the ordinary property into a field.
/// </summary>
public class Issue2436ExplicitInterfacePrimaryConstructorLiftTests
{
    [Fact]
    public void ExplicitConstructor_SameNamedExplicitInterfaceForwarderSurvives()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
namespace Demo
{
    public interface IValue
    {
        string Value { get; }
    }

    public class Holder : IValue
    {
        public Holder(string value)
        {
            Value = value;
        }

        public string Value { get; }

        string IValue.Value => Value;
    }
}");

        TypeDeclaration holder = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Holder");
        Assert.True(holder.PrimaryConstructorParameters is null || holder.PrimaryConstructorParameters.Count == 0);
        Assert.Equal(
            "value",
            Assert.Single(holder.Members.OfType<ConstructorDeclaration>()).Parameters.Single().Name);

        PropertyDeclaration forwarder = Assert.Single(
            holder.Members.OfType<PropertyDeclaration>(),
            p => p.Name == "Value" && p.ExplicitInterfaceType != null);
        Assert.True(forwarder.ExplicitInterfaceType is NamedTypeReference { Name: "IValue" });
        Assert.Contains(
            holder.Members.OfType<PropertyDeclaration>(),
            p => p.Name == "Value" && p.ExplicitInterfaceType == null);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertRoundTripParses(GSharpPrinter.Print(unit));
    }

    [Fact]
    public void ExplicitConstructor_SameNamedExplicitGetSetPropertyPreservesAccessorShape()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
namespace Demo
{
    public interface IMutableValue
    {
        string Value { get; set; }
    }

    public class MutableHolder : IMutableValue
    {
        public MutableHolder(string value)
        {
            Value = value;
        }

        public string Value { get; private set; }

        string IMutableValue.Value
        {
            get => Value;
            set => Value = value;
        }
    }
}");

        TypeDeclaration holder = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "MutableHolder");
        Assert.True(holder.PrimaryConstructorParameters is null || holder.PrimaryConstructorParameters.Count == 0);
        Assert.Equal(
            "value",
            Assert.Single(holder.Members.OfType<ConstructorDeclaration>()).Parameters.Single().Name);

        PropertyDeclaration forwarder = Assert.Single(
            holder.Members.OfType<PropertyDeclaration>(),
            p => p.Name == "Value" && p.ExplicitInterfaceType != null);
        Assert.True(forwarder.ExplicitInterfaceType is NamedTypeReference { Name: "IMutableValue" });
        Assert.Contains(forwarder.Accessors, a => a.Kind == AccessorKind.Get);
        Assert.Contains(forwarder.Accessors, a => a.Kind == AccessorKind.Set);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertRoundTripParses(GSharpPrinter.Print(unit));
    }

    [Fact]
    public void RecordAutoPropertyLift_SameNamedExplicitInterfaceForwarderSurvives()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
namespace Demo
{
    public interface IValue
    {
        string Value { get; }
    }

    public record Holder : IValue
    {
        public string Value { get; init; } = ""default"";

        string IValue.Value => Value;
    }
}");

        TypeDeclaration holder = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Holder");
        Assert.True(holder.PrimaryConstructorParameters == null || holder.PrimaryConstructorParameters.Count == 0);
        Assert.Contains(
            holder.Members.OfType<PropertyDeclaration>(),
            property => property.Name == "Value" && property.ExplicitInterfaceType == null);

        PropertyDeclaration forwarder = Assert.Single(
            holder.Members.OfType<PropertyDeclaration>(),
            p => p.Name == "Value" && p.ExplicitInterfaceType != null);
        Assert.True(forwarder.ExplicitInterfaceType is NamedTypeReference { Name: "IValue" });
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        AssertRoundTripParses(GSharpPrinter.Print(unit));
    }

    private static (CompilationUnit Unit, TranslationContext Context) Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Source.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return (unit, context);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = GSharpRoundTrip.Validate(rendered);
        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }
}
