// <copyright file="Issue4817LinkedSourceNullabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

public class Issue4817LinkedSourceNullabilityTests
{
    private const string LinkedPath = "test/Shared/Oracle.cs";

    private const string LinkedSource = """
        namespace Shared;

        internal static class Oracle
        {
            internal static void Accept(string value)
            {
            }
        }
        """;

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void LinkedParameter_UsesRepositoryTaintRegardlessOfProjectOrder(bool nullableFirst)
    {
        LoadedCSharpProject nullableCaller = Load(
            "NullableCaller",
            """
            namespace App;

            internal static class Caller
            {
                internal static void Run() => Shared.Oracle.Accept(null);
            }
            """);
        LoadedCSharpProject nonNullCaller = Load(
            "NonNullCaller",
            """
            namespace App;

            internal static class Caller
            {
                internal static void Run() => Shared.Oracle.Accept("value");
            }
            """);

        AssertRepositoryOrder(
            nullableFirst ? nullableCaller : nonNullCaller,
            nullableFirst ? nonNullCaller : nullableCaller);
    }

    private static void AssertRepositoryOrder(
        LoadedCSharpProject first,
        LoadedCSharpProject second)
    {
        var repository = new[] { first.Compilation, second.Compilation };
        string firstOutput = Translate(first, repository);
        string secondOutput = Translate(second, repository);

        Assert.Equal(firstOutput, secondOutput);
        Assert.Contains("Accept(value string?)", firstOutput, StringComparison.Ordinal);
    }

    private static LoadedCSharpProject Load(string assemblyName, string callerSource)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[]
            {
                (LinkedPath, LinkedSource),
                ($"{assemblyName}.cs", callerSource),
            },
            assemblyName: assemblyName);
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));
        return project;
    }

    private static string Translate(
        LoadedCSharpProject project,
        IReadOnlyList<CSharpCompilation> repository)
    {
        LoadedDocument document = project.Documents.Single(candidate => candidate.FilePath == LinkedPath);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath,
            repository,
            repository);
        return GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }
}
