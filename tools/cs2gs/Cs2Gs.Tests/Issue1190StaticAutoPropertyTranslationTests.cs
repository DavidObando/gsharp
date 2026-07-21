// <copyright file="Issue1190StaticAutoPropertyTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issues #1190/#2665: initialized static auto-properties preserve their
/// initializer without collapsing the CLR property ABI to a field.
/// </summary>
public class Issue1190StaticAutoPropertyTranslationTests
{
    private const string Source = @"
namespace Corpus.Issue1190
{
    public class ApplEnv
    {
        public static string OSVersion { get; } = GetOsVersion();

        public static string ApplName { get; private set; } = ""app"";

        public static string Mutable { get; set; } = ""m"";

        public static string Maybe { get; } = GetMaybe();

        public static string Plain { get; }

        public static string Computed { get { return ""c""; } }

        private static string GetOsVersion()
        {
            return ""1.0"";
        }

        private static string? GetMaybe() => null;
    }
}
";

    [Fact]
    public void StaticGetOnlyWithInitializer_KeepsPropertyAndUsesPrivateLetBackingField()
    {
        SharedBlock shared = SharedBlockOf("ApplEnv");

        FieldDeclaration osVersion = shared.Members
            .OfType<FieldDeclaration>()
            .Single(f => f.Name == "_oSVersion");

        Assert.Equal(BindingKind.Let, osVersion.Binding);
        Assert.Equal(Visibility.Private, osVersion.Visibility);
        Assert.NotNull(osVersion.Initializer);
        Assert.Contains(shared.Members.OfType<PropertyDeclaration>(), p => p.Name == "OSVersion");
    }

    [Fact]
    public void StaticPrivateSetWithInitializer_PreservesPropertyAndAccessorAccessibility()
    {
        SharedBlock shared = SharedBlockOf("ApplEnv");

        FieldDeclaration applName = shared.Members
            .OfType<FieldDeclaration>()
            .Single(f => f.Name == "_applName");

        Assert.Equal(BindingKind.Var, applName.Binding);
        Assert.NotNull(applName.Initializer);
        PropertyDeclaration property = shared.Members
            .OfType<PropertyDeclaration>()
            .Single(p => p.Name == "ApplName");
        Assert.Equal(Visibility.Default, property.Accessors.Single(a => a.Kind == AccessorKind.Get).Visibility);
        Assert.Equal(Visibility.Private, property.Accessors.Single(a => a.Kind == AccessorKind.Set).Visibility);
    }

    [Fact]
    public void StaticGetSetWithInitializer_KeepsReadWriteProperty()
    {
        SharedBlock shared = SharedBlockOf("ApplEnv");

        FieldDeclaration mutable = shared.Members
            .OfType<FieldDeclaration>()
            .Single(f => f.Name == "_mutable");

        Assert.Equal(BindingKind.Var, mutable.Binding);
        Assert.NotNull(mutable.Initializer);
        Assert.Contains(shared.Members.OfType<PropertyDeclaration>(), p => p.Name == "Mutable");
    }

    [Fact]
    public void ConvertedStaticAutoProperties_RenderBackingFieldsAndPropertyAccessors()
    {
        (CompilationUnit unit, _) = Translate();
        string rendered = GSharpPrinter.Print(unit);

        Assert.Contains("private let _oSVersion", rendered, StringComparison.Ordinal);
        Assert.Contains("prop OSVersion string", rendered, StringComparison.Ordinal);
        Assert.Contains("prop ApplName string", rendered, StringComparison.Ordinal);
        Assert.Contains("private set", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("var ApplName", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void NullableInitializer_PromotesBackingFieldAndPropertyTogether()
    {
        SharedBlock shared = SharedBlockOf("ApplEnv");
        FieldDeclaration field = shared.Members.OfType<FieldDeclaration>().Single(f => f.Name == "_maybe");
        PropertyDeclaration property = shared.Members.OfType<PropertyDeclaration>().Single(p => p.Name == "Maybe");

        Assert.True(field.Type.IsNullable);
        Assert.True(property.Type.IsNullable);
    }

    [Fact]
    public void StaticAutoPropertyWithoutInitializer_KeepsPropertyForm()
    {
        SharedBlock shared = SharedBlockOf("ApplEnv");

        // `Plain` has no initializer, so it is NOT converted to a backing field.
        Assert.DoesNotContain(
            shared.Members.OfType<FieldDeclaration>(),
            f => f.Name == "Plain");
    }

    [Fact]
    public void StaticComputedProperty_KeepsPropertyForm()
    {
        SharedBlock shared = SharedBlockOf("ApplEnv");

        // A static property with a getter body is unaffected.
        Assert.DoesNotContain(
            shared.Members.OfType<FieldDeclaration>(),
            f => f.Name == "Computed");
    }

    private static SharedBlock SharedBlockOf(string typeName)
    {
        (CompilationUnit unit, _) = Translate();
        TypeDeclaration type = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == typeName);
        return type.Members.OfType<SharedBlock>().Single();
    }

    private static (CompilationUnit Unit, TranslationContext Context) Translate()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ApplEnv.cs", Source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return (unit, context);
    }
}
