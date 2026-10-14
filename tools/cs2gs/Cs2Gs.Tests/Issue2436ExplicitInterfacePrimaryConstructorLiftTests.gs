// <copyright file="Issue2436ExplicitInterfacePrimaryConstructorLiftTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Linq
import Xunit

/// Issue #2436: a same-named explicit-interface forwarder must survive beside
/// the ordinary property. Issue #2746 now keeps the explicit constructor and
/// both properties rather than collapsing the ordinary property into a field.
open class Issue2436ExplicitInterfacePrimaryConstructorLiftTests {
    @Fact
    func ExplicitConstructor_SameNamedExplicitInterfaceForwarderSurvives() {
        let (unit, context) = Translate(`
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
}`)
        let holder = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Holder")
        Assert.True(holder.PrimaryConstructorParameters == nil || holder.PrimaryConstructorParameters!!.Count == 0)
        Assert.Equal("value", Assert.Single(holder.Members.OfType[ConstructorDeclaration]()).Parameters.Single().Name)
        let forwarder = Assert.Single(
            holder.Members.OfType[PropertyDeclaration](),
            (p PropertyDeclaration) -> p.Name == "Value" && p.ExplicitInterfaceType != nil
        )
        Assert.True((forwarder.ExplicitInterfaceType is NamedTypeReference and {Name: "IValue"}))
        Assert.Contains(
            holder.Members.OfType[PropertyDeclaration](),
            (p PropertyDeclaration) -> p.Name == "Value" && p.ExplicitInterfaceType == nil
        )
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        AssertRoundTripParses(GSharpPrinter.Print(unit))
    }

    @Fact
    func ExplicitConstructor_SameNamedExplicitGetSetPropertyPreservesAccessorShape() {
        let (unit, context) = Translate(`
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
}`)
        let holder = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "MutableHolder")
        Assert.True(holder.PrimaryConstructorParameters == nil || holder.PrimaryConstructorParameters!!.Count == 0)
        Assert.Equal("value", Assert.Single(holder.Members.OfType[ConstructorDeclaration]()).Parameters.Single().Name)
        let forwarder = Assert.Single(
            holder.Members.OfType[PropertyDeclaration](),
            (p PropertyDeclaration) -> p.Name == "Value" && p.ExplicitInterfaceType != nil
        )
        Assert.True((forwarder.ExplicitInterfaceType is NamedTypeReference and {Name: "IMutableValue"}))
        Assert.Contains(forwarder.Accessors, (a PropertyAccessor) -> a.Kind == AccessorKind.Get)
        Assert.Contains(forwarder.Accessors, (a PropertyAccessor) -> a.Kind == AccessorKind.Set)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        AssertRoundTripParses(GSharpPrinter.Print(unit))
    }

    @Fact
    func RecordAutoPropertyLift_SameNamedExplicitInterfaceForwarderSurvives() {
        let (unit, context) = Translate(`
namespace Demo
{
    public interface IValue
    {
        string Value { get; }
    }

    public record Holder : IValue
    {
        public string Value { get; init; } = "default";

        string IValue.Value => Value;
    }
}`)
        let holder = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Holder")
        Assert.True(holder.PrimaryConstructorParameters == nil || holder.PrimaryConstructorParameters!!.Count == 0)
        Assert.Contains(
            holder.Members.OfType[PropertyDeclaration](),
            (property PropertyDeclaration) -> property.Name == "Value" && property.ExplicitInterfaceType == nil
        )
        let forwarder = Assert.Single(
            holder.Members.OfType[PropertyDeclaration](),
            (p PropertyDeclaration) -> p.Name == "Value" && p.ExplicitInterfaceType != nil
        )
        Assert.True((forwarder.ExplicitInterfaceType is NamedTypeReference and {Name: "IValue"}))
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        AssertRoundTripParses(GSharpPrinter.Print(unit))
    }

    shared {
        private func Translate(source string)(Unit CompilationUnit, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return (unit, context)
        }

        private func AssertRoundTripParses(rendered string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
            Assert.True(
                result!!.Success,
                "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
            )
        }
    }
}
