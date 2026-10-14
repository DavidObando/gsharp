// <copyright file="Issue3464ConstructorInlineOutTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import System
import Xunit

class Issue3464ConstructorInlineOutTranslationTests {
    @Fact
    func MutexConstructorInlineOutVar_TranslatesBindsAndRuns() {
        const source = `using System.Threading;

public static class GuardFactory
{
    public static bool Create()
    {
        string? guardName = null;
        var processGuard = new Mutex(initiallyOwned: false, guardName, out var createdNew);
        processGuard.Dispose();
        return createdNew;
    }
}`
        let rendered = Translate(source)
        Assert.Contains(
            "Mutex(initiallyOwned: false, guardName, out var createdNew)",
            rendered,
            StringComparison.Ordinal
        )
        TranslationTestValidation.AssertBinds(rendered)
        let runtime = EmittedOracle.Evaluate(rendered + Environment.NewLine + "GuardFactory.Create()")
        Assert.Empty(runtime.Diagnostics)
        Assert.Equal(true, runtime.Value)
    }

    shared {
        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("GuardFactory.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }
    }
}
