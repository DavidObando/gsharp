// <copyright file="Issue3464ConstructorInlineOutTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue3464ConstructorInlineOutTranslationTests
{
    [Fact]
    public void MutexConstructorInlineOutVar_TranslatesBindsAndRuns()
    {
        const string source = """
            using System.Threading;

            public static class GuardFactory
            {
                public static bool Create()
                {
                    string? guardName = null;
                    var processGuard = new Mutex(initiallyOwned: false, guardName, out var createdNew);
                    processGuard.Dispose();
                    return createdNew;
                }
            }
            """;

        var rendered = Translate(source);

        Assert.Contains(
            "Mutex(initiallyOwned: false, guardName, out var createdNew)",
            rendered,
            StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);

        var runtime = EmittedOracle.Evaluate(rendered + Environment.NewLine + "GuardFactory.Create()");
        Assert.Empty(runtime.Diagnostics);
        Assert.Equal(true, runtime.Value);
    }

    private static string Translate(string source)
    {
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("GuardFactory.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
