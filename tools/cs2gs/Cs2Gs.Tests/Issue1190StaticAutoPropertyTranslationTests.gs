// <copyright file="Issue1190StaticAutoPropertyTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Linq
import Xunit

/// Issues #1190/#2665: initialized static auto-properties preserve their
/// initializer without collapsing the CLR property ABI to a field.
open class Issue1190StaticAutoPropertyTranslationTests {
    @Fact
    func StaticGetOnlyWithInitializer_KeepsPropertyAndUsesPrivateLetBackingField() {
        let shared = SharedBlockOf("ApplEnv")
        let osVersion = shared.Members.OfType[FieldDeclaration]().Single((f FieldDeclaration) -> f.Name == "_oSVersion")
        Assert.Equal(BindingKind.Let, osVersion.Binding)
        Assert.Equal(Visibility.Private, osVersion.Visibility)
        Assert.NotNull(osVersion.Initializer)
        Assert.Contains(shared.Members.OfType[PropertyDeclaration](), (p PropertyDeclaration) -> p.Name == "OSVersion")
    }

    @Fact
    func StaticPrivateSetWithInitializer_PreservesPropertyAndAccessorAccessibility() {
        let shared = SharedBlockOf("ApplEnv")
        let applName = shared.Members.OfType[FieldDeclaration]().Single((f FieldDeclaration) -> f.Name == "_applName")
        Assert.Equal(BindingKind.Var, applName.Binding)
        Assert.NotNull(applName.Initializer)
        let property = shared
            .Members
            .OfType[PropertyDeclaration]()
            .Single((p PropertyDeclaration) -> p.Name == "ApplName")
        Assert.Equal(
            Visibility.Default,
            property.Accessors.Single((a PropertyAccessor) -> a.Kind == AccessorKind.Get).Visibility
        )
        Assert.Equal(
            Visibility.Private,
            property.Accessors.Single((a PropertyAccessor) -> a.Kind == AccessorKind.Set).Visibility
        )
    }

    @Fact
    func StaticGetSetWithInitializer_KeepsReadWriteProperty() {
        let shared = SharedBlockOf("ApplEnv")
        let mutable = shared.Members.OfType[FieldDeclaration]().Single((f FieldDeclaration) -> f.Name == "_mutable")
        Assert.Equal(BindingKind.Var, mutable.Binding)
        Assert.NotNull(mutable.Initializer)
        Assert.Contains(shared.Members.OfType[PropertyDeclaration](), (p PropertyDeclaration) -> p.Name == "Mutable")
    }

    @Fact
    func ConvertedStaticAutoProperties_RenderBackingFieldsAndPropertyAccessors() {
        let (unit, _) = Translate()
        let rendered = GSharpPrinter.Print(unit)
        Assert.Contains("private let _oSVersion", rendered, StringComparison.Ordinal)
        Assert.Contains("prop OSVersion string", rendered, StringComparison.Ordinal)
        Assert.Contains("prop ApplName string", rendered, StringComparison.Ordinal)
        Assert.Contains("private set", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("var ApplName", rendered, StringComparison.Ordinal)
    }

    @Fact
    func NullableInitializer_PromotesBackingFieldAndPropertyTogether() {
        let shared = SharedBlockOf("ApplEnv")
        let field = shared.Members.OfType[FieldDeclaration]().Single((f FieldDeclaration) -> f.Name == "_maybe")
        let property = shared.Members.OfType[PropertyDeclaration]().Single((p PropertyDeclaration) -> p.Name == "Maybe")
        Assert.True(field.Type!!.IsNullable)
        Assert.True(property.Type.IsNullable)
    }

    @Fact
    func StaticAutoPropertyWithoutInitializer_KeepsPropertyForm() {
        let shared = SharedBlockOf("ApplEnv")
        // `Plain` has no initializer, so it is NOT converted to a backing field.
        Assert.DoesNotContain(shared.Members.OfType[FieldDeclaration](), (f FieldDeclaration) -> f.Name == "Plain")
    }

    @Fact
    func StaticComputedProperty_KeepsPropertyForm() {
        let shared = SharedBlockOf("ApplEnv")
        // A static property with a getter body is unaffected.
        Assert.DoesNotContain(shared.Members.OfType[FieldDeclaration](), (f FieldDeclaration) -> f.Name == "Computed")
    }

    shared {
        private const Source string = `
namespace Corpus.Issue1190
{
    public class ApplEnv
    {
        public static string OSVersion { get; } = GetOsVersion();

        public static string ApplName { get; private set; } = "app";

        public static string Mutable { get; set; } = "m";

        public static string Maybe { get; } = GetMaybe();

        public static string Plain { get; }

        public static string Computed { get { return "c"; } }

        private static string GetOsVersion()
        {
            return "1.0";
        }

        private static string? GetMaybe() => null;
    }
}
`

        private func SharedBlockOf(typeName string) SharedBlock {
            let (unit, _) = Translate()
            let type = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == typeName)
            return type.Members.OfType[SharedBlock]().Single()
        }

        private func Translate()(Unit CompilationUnit, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, Source string){("ApplEnv.cs", Source)})
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
    }
}
