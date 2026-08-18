// <copyright file="Issue3445AttributeImportTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue3445AttributeImportTranslationTests
{
    [Fact]
    public void NotNullWhen_FromGlobalUsing_SynthesizesImportAndBinds()
    {
        IReadOnlyDictionary<string, string> translated = Translate(
            ("GlobalUsings.cs", "global using System.Diagnostics.CodeAnalysis;"),
            ("Consumer.cs", """
                #nullable enable

                namespace Demo;

                public static class Parser
                {
                    public static bool TryParse(
                        string input,
                        [NotNullWhen(true)] out string? value)
                    {
                        value = input.Length > 0 ? input : null;
                        return value is not null;
                    }
                }
                """));

        string consumer = translated["Consumer.cs"];
        Assert.Contains("import System.Diagnostics.CodeAnalysis", consumer, StringComparison.Ordinal);
        Assert.Contains("@NotNullWhen(true) out value string?", consumer, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(translated.Values.ToArray());
    }

    [Fact]
    public void AttributeTypes_UseSemanticNamesAndOneContainingNamespaceImport()
    {
        IReadOnlyDictionary<string, string> translated = Translate(
            ("GlobalUsings.cs", """
                global using External.Attributes;
                global using AttributeAlias = External.Attributes.MarkerAttribute;
                """),
            ("Attributes.cs", """
                using System;

                namespace External.Attributes;

                [AttributeUsage(AttributeTargets.All, AllowMultiple = true)]
                public sealed class MarkerAttribute : Attribute
                {
                }

                public sealed class GenericAttribute<T> : Attribute
                {
                }

                """),
            ("Consumer.cs", """
                [assembly: Marker]

                namespace Demo;

                [Marker]
                [MarkerAttribute]
                [AttributeAlias]
                [Generic<int>]
                public sealed class Consumer
                {
                    [Marker]
                    public string Value { get; } = "";

                    [return: Marker]
                    [Marker]
                    public string Echo([Marker] string value) => value;
                }
                """));

        string consumer = translated["Consumer.cs"];
        Assert.Equal(
            1,
            consumer.Split('\n').Count(line => line == "import External.Attributes"));
        Assert.Contains("@assembly:Marker", consumer, StringComparison.Ordinal);
        Assert.Contains(
            "import AttributeAlias = External.Attributes.MarkerAttribute",
            consumer,
            StringComparison.Ordinal);
        Assert.Contains("@AttributeAlias", consumer, StringComparison.Ordinal);
        Assert.Contains("@Generic[int32]", consumer, StringComparison.Ordinal);
        Assert.Contains("@return:Marker", consumer, StringComparison.Ordinal);
        Assert.Contains("@Marker value string", consumer, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(translated.Values.ToArray());
    }

    [Fact]
    public void QualifiedAttribute_PreservesNameAndSynthesizesImport()
    {
        IReadOnlyDictionary<string, string> translated = Translate(
            ("Consumer.cs", """
                namespace Demo;

                [global::System.Obsolete]
                public sealed class Consumer
                {
                }
                """));

        string consumer = translated["Consumer.cs"];
        Assert.Contains("import System", consumer, StringComparison.Ordinal);
        Assert.Contains("@System.Obsolete", consumer, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(consumer);
    }

    [Fact]
    public void NestedAttribute_TracksContainingNamespaceAndMappedName()
    {
        IReadOnlyDictionary<string, string> translated = Translate(
            ("GlobalUsings.cs", """
                global using External.Attributes;
                global using AttributeNamespace = External.Attributes;
                """),
            ("Attributes.cs", """
                using System;

                namespace External.Attributes;

                public sealed class NestedAttribute : Attribute
                {
                }

                public sealed class GenericAttribute<T> : Attribute
                {
                }

                public static class Holder
                {
                    public sealed class Nested
                    {
                    }

                    public sealed class NestedAttribute : Attribute
                    {
                    }

                    public sealed class Generic<T>
                    {
                    }

                    public sealed class GenericAttribute<T> : Attribute
                    {
                    }
                }
                """),
            ("Consumer.cs", """
                namespace Demo;

                [Holder.Nested]
                public sealed class Consumer
                {
                }

                [Holder.NestedAttribute]
                public sealed class ExplicitConsumer
                {
                }

                [Holder.Generic<int>]
                public sealed class GenericConsumer
                {
                }

                [global::External.Attributes.Holder.Nested]
                public sealed class QualifiedConsumer
                {
                }

                [AttributeNamespace.Holder.Nested]
                public sealed class AliasQualifiedConsumer
                {
                }
                """));

        string consumer = translated["Consumer.cs"];
        Assert.Contains("import External.Attributes", consumer, StringComparison.Ordinal);
        Assert.Contains("@Holder.Nested", consumer, StringComparison.Ordinal);
        Assert.Contains("@Holder.NestedAttribute", consumer, StringComparison.Ordinal);
        Assert.Contains("@Holder.Generic[int32]", consumer, StringComparison.Ordinal);
        Assert.Contains("@External.Attributes.Holder.Nested", consumer, StringComparison.Ordinal);
        Assert.Contains("@AttributeNamespace.Holder.Nested", consumer, StringComparison.Ordinal);
        Assert.Contains(
            "import AttributeNamespace = External.Attributes",
            consumer,
            StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(translated.Values.ToArray());
    }

    [Fact]
    public void GlobalNamespaceAttribute_DoesNotSynthesizeImportAndBinds()
    {
        IReadOnlyDictionary<string, string> translated = Translate(
            ("Attributes.cs", """
                using System;

                public sealed class MarkerAttribute : Attribute
                {
                }
                """),
            ("Consumer.cs", """
                [Marker]
                public sealed class Consumer
                {
                }
                """));

        string consumer = translated["Consumer.cs"];
        Assert.DoesNotContain("import ", consumer, StringComparison.Ordinal);
        Assert.Contains("@Marker", consumer, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(translated.Values.ToArray());
    }

    private static IReadOnlyDictionary<string, string> Translate(
        params (string FileName, string Source)[] sources)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(sources);
        Assert.True(
            project.BoundWithoutErrors,
            "Snippets should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        var translator = new CSharpToGSharpTranslator();
        var translated = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (LoadedDocument document in project.Documents.Where(document =>
            Path.GetFileName(document.FilePath) != "GlobalUsings.cs"))
        {
            var context = new TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath);
            CompilationUnit unit = translator.TranslateDocument(document, context);
            Assert.DoesNotContain(
                context.Diagnostics,
                diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
            translated.Add(Path.GetFileName(document.FilePath), GSharpPrinter.Print(unit));
        }

        return translated;
    }
}
