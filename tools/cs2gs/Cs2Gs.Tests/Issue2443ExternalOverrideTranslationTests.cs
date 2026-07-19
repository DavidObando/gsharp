// <copyright file="Issue2443ExternalOverrideTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #2443: cs2gs must preserve overrides whose root declaration comes
/// from metadata; dropping the modifier silently creates a shadowing member.
/// </summary>
public sealed class Issue2443ExternalOverrideTranslationTests
{
    [Fact]
    public void MetadataBaseOverrides_ArePrintedForEverySupportedMemberKind()
    {
        const string Source = """
            using System;
            using External2443;

            namespace Demo;

            public class Derived : ExternalBase<int>
            {
                public override string Echo(int value) => value.ToString();

                public sealed override object Identity(object value) => value;

                public override int Value => 7;

                public override int this[int index] => index;

                public override event EventHandler Changed
                {
                    add { }
                    remove { }
                }
            }
            """;

        string printed = Translate(Source);

        Assert.Contains("override func Echo", printed, StringComparison.Ordinal);
        Assert.Contains("override func Identity", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("open override func Identity", printed, StringComparison.Ordinal);
        Assert.Contains("override prop Value", printed, StringComparison.Ordinal);
        Assert.Contains("override prop this[", printed, StringComparison.Ordinal);
        Assert.Contains("override event Changed", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void BclOverride_IsNotSilentlyLoweredToPlainMethod()
    {
        const string Source = """
            using System;
            using System.Threading;

            namespace Demo;

            public sealed class Context : SynchronizationContext
            {
                public override void Post(SendOrPostCallback callback, object state)
                {
                }
            }
            """;

        string printed = Translate(Source, includeExternalBase: false);
        Assert.Contains("override func Post", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("\n    func Post", printed, StringComparison.Ordinal);
    }

    private static string Translate(string source, bool includeExternalBase = true)
    {
        var references = CSharpProjectLoader.RuntimeReferences().ToList();
        if (includeExternalBase)
        {
            references.Add(BuildExternalBaseReference());
        }

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Derived.cs", source) },
            references);
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        return GSharpPrinter.Print(unit);
    }

    private static MetadataReference BuildExternalBaseReference()
    {
        const string Source = """
            using System;

            namespace External2443;

            public class ExternalBase<T>
            {
                public virtual T Value => default!;

                public virtual T this[int index] => default!;

                public virtual event EventHandler Changed
                {
                    add { }
                    remove { }
                }

                public virtual string Echo(T value) => string.Empty;

                public virtual object Identity(object value) => value;
            }
            """;

        var compilation = CSharpCompilation.Create(
            "External2443",
            new[] { CSharpSyntaxTree.ParseText(Source, new CSharpParseOptions(LanguageVersion.Latest)) },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var stream = new MemoryStream();
        var emitResult = compilation.Emit(stream);
        Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics));
        return MetadataReference.CreateFromImage(stream.ToArray());
    }
}
