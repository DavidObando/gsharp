// <copyright file="Issue3410PartialTypeFileOwnershipTests.cs" company="GSharp">
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

/// <summary>
/// Issue #3410: default cs2gs translation keeps each partial type member in
/// the generated file corresponding to its declaring C# source file.
/// </summary>
public class Issue3410PartialTypeFileOwnershipTests
{
    [Fact]
    public void StatementBinderParts_KeepMembersInDeclaringFiles_AndBindDeterministically()
    {
        (string FileName, string Source)[] files =
        {
            ("StatementBinder.Blocks.cs", """
                namespace Demo;

                internal sealed partial class StatementBinder
                {
                    private static bool BindBlock(BoundExpression expression) => expression != null;
                }
                """),
            ("StatementBinder.Jumps.cs", """
                namespace Demo;

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
                }
                """),
        };

        IReadOnlyList<(string FileName, string Printed)> first = Translate(files);
        IReadOnlyList<(string FileName, string Printed)> second = Translate(files);
        Assert.Equal(first, second);

        string blocks = first.Single(file => file.FileName == "StatementBinder.Blocks.gs").Printed;
        string jumps = first.Single(file => file.FileName == "StatementBinder.Jumps.gs").Printed;

        Assert.Contains("partial class StatementBinder", blocks, StringComparison.Ordinal);
        Assert.Contains("shared {", blocks, StringComparison.Ordinal);
        Assert.Contains("func BindBlock(", blocks, StringComparison.Ordinal);
        Assert.DoesNotContain("HasFunctionLocalRefScope", blocks, StringComparison.Ordinal);

        Assert.Contains("partial class StatementBinder", jumps, StringComparison.Ordinal);
        Assert.Contains("shared {", jumps, StringComparison.Ordinal);
        Assert.Contains("func HasFunctionLocalRefScope(", jumps, StringComparison.Ordinal);
        Assert.DoesNotContain("func BindBlock(", jumps, StringComparison.Ordinal);

        // Preserve PR #3417's native named-pattern translation while changing
        // partial-file ownership.
        Assert.Contains(
            "fa.Receiver is { Type: StructSymbol s } && s.IsClass",
            jumps,
            StringComparison.Ordinal);

        TranslationTestValidation.AssertBinds(first.Select(file => file.Printed).ToArray());
    }

    private static IReadOnlyList<(string FileName, string Printed)> Translate(
        params (string FileName, string Source)[] files)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(files);
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        var translator = new CSharpToGSharpTranslator();
        var output = new List<(string FileName, string Printed)>();
        foreach (LoadedDocument document in project.Documents)
        {
            var context = new TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath);
            CompilationUnit unit = translator.TranslateDocument(document, context);
            output.Add((
                Path.ChangeExtension(Path.GetFileName(document.FilePath), ".gs"),
                GSharpPrinter.Print(unit)));
        }

        return output;
    }
}
