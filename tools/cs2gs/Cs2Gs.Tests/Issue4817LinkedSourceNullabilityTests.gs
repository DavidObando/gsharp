// <copyright file="Issue4817LinkedSourceNullabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Linq
import Xunit

open class Issue4817LinkedSourceNullabilityTests {
    @Theory
    @InlineData(true)
    @InlineData(false)
    func LinkedParameter_UsesRepositoryTaintRegardlessOfProjectOrder(nullableFirst bool) {
        let nullableCaller = Load("NullableCaller", `namespace App;

internal static class Caller
{
    internal static void Run() => Shared.Oracle.Accept(null);
}`)
        let nonNullCaller = Load("NonNullCaller", `namespace App;

internal static class Caller
{
    internal static void Run() => Shared.Oracle.Accept("value");
}`)
        AssertRepositoryOrder(
            if nullableFirst {
                nullableCaller
            } else {
                nonNullCaller
            },
            if nullableFirst {
                nonNullCaller
            } else {
                nullableCaller
            }
        )
    }

    shared {
        private const LinkedPath string = "test/Shared/Oracle.cs"

        private const LinkedSource string = `namespace Shared;

internal static class Oracle
{
    internal static void Accept(string value)
    {
    }
}`

        private func AssertRepositoryOrder(first LoadedCSharpProject, second LoadedCSharpProject) {
            let repository = []CSharpCompilation{first.Compilation, second.Compilation}
            let firstOutput = Translate(first, repository)
            let secondOutput = Translate(second, repository)
            Assert.Equal(firstOutput, secondOutput)
            Assert.Contains("Accept(value string?)", firstOutput, StringComparison.Ordinal)
        }

        private func Load(assemblyName string, callerSource string) LoadedCSharpProject {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, string){(LinkedPath, LinkedSource), ("$assemblyName.cs", callerSource)},
                assemblyName: assemblyName
            )
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            return project
        }

        private func Translate(project LoadedCSharpProject, repository IReadOnlyList[CSharpCompilation]) string {
            let document = project.Documents.Single((candidate LoadedDocument) -> candidate.FilePath == LinkedPath)
            let context = TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath,
                repository,
                repository
            )
            return GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }
    }
}
