// <copyright file="Issue3410PartialTypeFileOwnershipTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #3410: default cs2gs translation keeps each partial type member in
/// the generated file corresponding to its declaring C# source file.
open class Issue3410PartialTypeFileOwnershipTests {
    @Fact
    func StatementBinderParts_KeepMembersInDeclaringFiles_AndBindDeterministically() {
        let files[](FileName string, Source string) = [](FileName string, Source string){("StatementBinder.Blocks.cs", `namespace Demo;

internal sealed partial class StatementBinder
{
    private static bool BindBlock(BoundExpression expression) => expression != null;
}`), ("StatementBinder.Jumps.cs", `namespace Demo;

internal class BoundExpression { }

internal class TypeSymbol { }

internal sealed class StructSymbol : TypeSymbol
{
    public bool IsClass { get; init; }
}

internal sealed class Receiver
{
    public TypeSymbol Type { get; init; } = new TypeSymbol();
}

internal sealed class FieldAccess : BoundExpression
{
    public Receiver Receiver { get; init; } = new Receiver();
}

internal sealed partial class StatementBinder
{
    private static bool HasFunctionLocalRefScope(BoundExpression expr)
    {
        if (expr is FieldAccess fa &&
            fa.Receiver is { Type: StructSymbol s } &&
            s.IsClass)
        {
            return BindBlock(expr);
        }

        return false;
    }
}`)}
        let first = Translate(files)
        let second = Translate(files)
        Assert.Equal(first, second)
        let blocks = first.Single(
            (file(FileName string, Printed string)) -> file.FileName == "StatementBinder.Blocks.gs"
        )
            .Printed
        let jumps = first.Single((file(FileName string, Printed string)) -> file.FileName == "StatementBinder.Jumps.gs")
            .Printed
        Assert.Contains("partial class StatementBinder", blocks, StringComparison.Ordinal)
        Assert.Contains("shared {", blocks, StringComparison.Ordinal)
        Assert.Contains("func BindBlock(", blocks, StringComparison.Ordinal)
        Assert.DoesNotContain("HasFunctionLocalRefScope", blocks, StringComparison.Ordinal)
        Assert.Contains("partial class StatementBinder", jumps, StringComparison.Ordinal)
        Assert.Contains("shared {", jumps, StringComparison.Ordinal)
        Assert.Contains("func HasFunctionLocalRefScope(", jumps, StringComparison.Ordinal)
        Assert.DoesNotContain("func BindBlock(", jumps, StringComparison.Ordinal)
        // Preserve PR #3417's native named-pattern translation while changing
        // partial-file ownership.
        Assert.Contains("fa.Receiver is { Type: StructSymbol s } && s.IsClass", jumps, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(
            first.Select((file(FileName string, Printed string)) -> file.Printed).ToArray()
        )
    }

    shared {
        private func Translate(files ...(FileName string, Source string)) IReadOnlyList[
            (FileName string, Printed string)
        ] {
            let project = CSharpProjectLoader.LoadInMemory(files)
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let translator = CSharpToGSharpTranslator()
            let output = List[(FileName string, Printed string)]()
            for document in project.Documents {
                let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                let unit = translator.TranslateDocument(document, context)
                output.Add(
                    (Path.ChangeExtension(Path.GetFileName(document.FilePath), ".gs"), GSharpPrinter.Print(unit))
                )
            }
            return output
        }
    }
}
