// <copyright file="Issue4412OverloadCallbackSelfMigrationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Issue #4412: the hidden-parameter callback remains self-migratable.
/// @remarks ADR-0154 witness: changing the callback input from `MethodBase` back to
/// the resolver's `T` breaks the signature assertion and reproduces the
/// MethodInfo/ConstructorInfo call-site binding failure in the round-trip test.
class Issue4412OverloadCallbackSelfMigrationTests {
    @Fact
    func MethodBaseCallback_MethodAndConstructorCallsRoundTrip() {
        const source = `using System;
using System.Reflection;

public static class Resolver
{
    public static T Resolve<T>(
        T candidate,
        Func<MethodBase, int>? trailingParameterCountToIgnore = null)
        where T : MethodBase =>
        candidate;

    public static MethodInfo ResolveMethod(MethodInfo candidate) =>
        Resolve(candidate, static member => member is MethodInfo ? 1 : 0);

    public static ConstructorInfo ResolveConstructor(ConstructorInfo candidate) =>
        Resolve(candidate, static member => member is ConstructorInfo ? 1 : 0);
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        let printed = GSharpPrinter.Print(unit)
        // Formerly asserted against the real ClrOverloadResolution.cs; the pinned
        // shape is this declaration (a Func<MethodBase, int> callback on a method
        // generic over T : MethodBase), so the assertion lives on the snippet and
        // survives the compiler sources becoming G# (#4661).
        let compact = string.Concat(printed.Where((character char) -> !char.IsWhiteSpace(character)))
        Assert.Contains("trailingParameterCountToIgnore((MethodBase)->int32)?=nil", compact, StringComparison.Ordinal)
        Assert.DoesNotContain("trailingParameterCountToIgnore((T)->int32)?", compact, StringComparison.Ordinal)
        let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(result!!.Success, "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed)
    }
}
