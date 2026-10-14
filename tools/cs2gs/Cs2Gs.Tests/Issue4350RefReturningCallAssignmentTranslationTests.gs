// <copyright file="Issue4350RefReturningCallAssignmentTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import System
import System.Collections.Generic
import Xunit

/// Issue #4350: preserve direct writes through ref-returning calls.
class Issue4350RefReturningCallAssignmentTranslationTests {
    @Fact
    func ManagedReferenceBorrow_AssignmentAndIncrementRemainDirect() {
        const source = `using Gsharp.Values;
namespace RefCallTranslation;
public class Probe
{
    public static int Run()
    {
        var values = new[] { 10 };
        var handle = ManagedRef<int>.FromArray(values, 0);
        handle.Borrow() = 17;
        handle.Borrow()++;
        ManagedRef<int> nil = null;
        if (nil != null) return 0;
        return values[0];
    }
}`
        let references = List[MetadataReference](
            CSharpProjectLoader.RuntimeReferences()
        ){MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)}
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Probe.cs", source)}, references)
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Empty(context.Diagnostics)
        Assert.Contains("handle.Borrow() = 17", printed, StringComparison.Ordinal)
        Assert.Contains("handle.Borrow()++", printed, StringComparison.Ordinal)
        Assert.Contains("nil_ managed[int32]? = nil", printed, StringComparison.Ordinal)
        Assert.True(TranslationTestValidation.AssertBinds(printed)!!.Success)
        let result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "Probe.Run()",
            []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(18, result.Value)
    }
}
