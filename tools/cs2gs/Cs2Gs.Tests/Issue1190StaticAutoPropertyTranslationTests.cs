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
/// Issue #1190: a C# <c>static</c> get-only auto-property with an inline
/// initializer (<c>public static Version OSVersion { get; } = GetOsVersion();</c>)
/// must become a static read-only backing field inside the <c>shared { }</c> block
/// (<c>shared { let OSVersion Version = GetOsVersion() }</c>), preserving the
/// initializer. Previously it was mis-translated to an invalid static
/// <c>prop … { get; init; }</c> (GS0374) and the initializer was dropped, causing
/// downstream <c>GS0113</c> diagnostics. A mutable
/// (<c>{ get; private set; }</c>) static auto-property maps to a
/// <c>shared var NAME T = expr</c> field instead.
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

        public static string Plain { get; }

        public static string Computed { get { return ""c""; } }

        private static string GetOsVersion()
        {
            return ""1.0"";
        }
    }
}
";

    [Fact]
    public void StaticGetOnlyWithInitializer_BecomesSharedLetField()
    {
        SharedBlock shared = SharedBlockOf("ApplEnv");

        FieldDeclaration osVersion = shared.Members
            .OfType<FieldDeclaration>()
            .Single(f => f.Name == "OSVersion");

        Assert.Equal(BindingKind.Let, osVersion.Binding);
        Assert.NotNull(osVersion.Initializer);
    }

    [Fact]
    public void StaticPrivateSetWithInitializer_BecomesSharedVarField()
    {
        SharedBlock shared = SharedBlockOf("ApplEnv");

        FieldDeclaration applName = shared.Members
            .OfType<FieldDeclaration>()
            .Single(f => f.Name == "ApplName");

        Assert.Equal(BindingKind.Var, applName.Binding);
        Assert.NotNull(applName.Initializer);
    }

    [Fact]
    public void StaticGetSetWithInitializer_BecomesSharedVarField()
    {
        SharedBlock shared = SharedBlockOf("ApplEnv");

        FieldDeclaration mutable = shared.Members
            .OfType<FieldDeclaration>()
            .Single(f => f.Name == "Mutable");

        Assert.Equal(BindingKind.Var, mutable.Binding);
        Assert.NotNull(mutable.Initializer);
    }

    [Fact]
    public void ConvertedStaticAutoProperties_DoNotEmitInitAccessor()
    {
        (CompilationUnit unit, _) = Translate();
        string rendered = GSharpPrinter.Print(unit);

        // The shared fields preserve their initializers and never use `init`.
        Assert.Contains("let OSVersion", rendered, StringComparison.Ordinal);
        Assert.Contains("var ApplName", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("OSVersion string { get; init; }", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("ApplName string { get; init; }", rendered, StringComparison.Ordinal);
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
