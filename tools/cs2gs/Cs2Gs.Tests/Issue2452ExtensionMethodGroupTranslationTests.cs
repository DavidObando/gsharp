// <copyright file="Issue2452ExtensionMethodGroupTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #2452: Roslyn distinguishes a get-only record property, a reduced
/// extension method group, and an invoked reduced extension method. cs2gs must
/// preserve those symbol-directed shapes; gsc is responsible for binding the
/// bare extension method group as a delegate value.
/// </summary>
public class Issue2452ExtensionMethodGroupTranslationTests
{
    [Fact]
    public void RecordPropertyReceiver_ExtensionMethodGroupAndInvocation_KeepDistinctShapes()
    {
        const string source = """
            using System;

            namespace Repro
            {
                public static class Checksums
                {
                    public static uint Checksum32(this string text) => (uint)text.Length;
                }

                public record Profile(string AccountName, string DeviceName)
                {
                    public override string ToString() =>
                        $"{nameof(AccountName)}=<{AccountName!.Checksum32}>, {nameof(DeviceName)}=<{DeviceName?.Checksum32()}>";
                }
            }
            """;

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Records.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var root = document.GetRoot();
        var accountAccess = root.DescendantNodes()
            .OfType<InterpolationSyntax>()
            .Select(h => h.Expression)
            .OfType<MemberAccessExpressionSyntax>()
            .Single(m => m.Name.Identifier.Text == "Checksum32");
        var deviceInvocation = root.DescendantNodes()
            .OfType<InvocationExpressionSyntax>()
            .Single(i => document.SemanticModel.GetSymbolInfo(i).Symbol is IMethodSymbol { Name: "Checksum32" });
        var accountProperty = root.DescendantNodes()
            .OfType<IdentifierNameSyntax>()
            .First(i => i.Identifier.Text == "AccountName" && i.Parent is PostfixUnaryExpressionSyntax);

        var accountMethod = Assert.IsAssignableFrom<IMethodSymbol>(
            document.SemanticModel.GetSymbolInfo(accountAccess).Symbol);
        var deviceMethod = Assert.IsAssignableFrom<IMethodSymbol>(
            document.SemanticModel.GetSymbolInfo(deviceInvocation).Symbol);
        Assert.Equal(MethodKind.ReducedExtension, accountMethod.MethodKind);
        Assert.Equal(MethodKind.ReducedExtension, deviceMethod.MethodKind);
        Assert.IsAssignableFrom<IPropertySymbol>(
            document.SemanticModel.GetSymbolInfo(accountProperty).Symbol);

        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));

        Assert.Contains("AccountName!!.Checksum32}", printed, StringComparison.Ordinal);
        Assert.Contains("DeviceName?.Checksum32()}", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("AccountName!!.Checksum32()}", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void PropertyAndMethodCallSites_AreNotRewrittenByName()
    {
        const string source = """
            namespace Repro
            {
                public interface IShape
                {
                    int Shape { get; }
                }

                public sealed class Host : IShape
                {
                    public int Shape => 7;
                    public int Measure() => 9;
                }

                public static class Extensions
                {
                    public static int Shape(this Host host) => 99;
                    public static int Measure(this Host host, int unused = 0) => 99;
                }

                public sealed class Consumer
                {
                    public int Read(Host host, IShape shape) =>
                        host.Shape + shape.Shape + host.Measure();
                }
            }
            """;

        string printed = Translate(source);
        Assert.Contains("host.Shape + shape.Shape + host.Measure()", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("host.Shape()", printed, StringComparison.Ordinal);
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }
}
