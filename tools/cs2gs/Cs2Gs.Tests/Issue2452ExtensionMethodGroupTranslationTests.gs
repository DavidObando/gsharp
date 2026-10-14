// <copyright file="Issue2452ExtensionMethodGroupTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.IO
import System.Linq
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp.Syntax
import Xunit
import GSharpCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharpSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharpSourceText = GSharp.Core.CodeAnalysis.Text.SourceText
import GSharp.Core.CodeAnalysis

/// Issue #2452: Roslyn distinguishes a get-only record property, a reduced
/// extension method group, and an invoked reduced extension method. cs2gs must
/// preserve those symbol-directed shapes; gsc is responsible for binding the
/// bare extension method group as a delegate value.
open class Issue2452ExtensionMethodGroupTranslationTests {
    @Fact
    func RecordPropertyReceiver_ExtensionMethodGroupAndInvocation_KeepDistinctShapes() {
        const source = `using System;

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
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Records.cs", source)})
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        let document = Assert.Single(project.Documents)
        let root = document.GetRoot()
        let accountAccess = root
            .DescendantNodes()
            .OfType[InterpolationSyntax]()
            .Select((h InterpolationSyntax) -> h.Expression)
            .OfType[MemberAccessExpressionSyntax]()
            .Single((m MemberAccessExpressionSyntax) -> m.Name.Identifier.Text == "Checksum32")
        let deviceInvocation = root
            .DescendantNodes()
            .OfType[InvocationExpressionSyntax]()
            .Single(
            (i InvocationExpressionSyntax) -> (
                document.SemanticModel.GetSymbolInfo(i).Symbol is IMethodSymbol and {Name: "Checksum32"}
            )
        )
        let accountProperty = root
            .DescendantNodes()
            .OfType[IdentifierNameSyntax]()
            .First(
            (i IdentifierNameSyntax) -> i.Identifier.Text == "AccountName" && i.Parent is PostfixUnaryExpressionSyntax
        )
        let accountMethod = Assert.IsAssignableFrom[IMethodSymbol](
            document.SemanticModel.GetSymbolInfo(accountAccess).Symbol
        )
        let deviceMethod = Assert.IsAssignableFrom[IMethodSymbol](
            document.SemanticModel.GetSymbolInfo(deviceInvocation).Symbol
        )
        Assert.Equal(MethodKind.ReducedExtension, accountMethod.MethodKind)
        Assert.Equal(MethodKind.ReducedExtension, deviceMethod.MethodKind)
        Assert.IsAssignableFrom[IPropertySymbol](document.SemanticModel.GetSymbolInfo(accountProperty).Symbol)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("AccountName!!.Checksum32}", printed, StringComparison.Ordinal)
        Assert.Contains("DeviceName?.Checksum32()}", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("AccountName!!.Checksum32()}", printed, StringComparison.Ordinal)
    }

    @Fact
    func PropertyAndMethodCallSites_AreNotRewrittenByName() {
        const source = `namespace Repro
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
            host.Shape + shape.Shape + host.Measure() + Extensions.Shape(host);
    }
}`
        let printed = Translate(source)
        Assert.Contains(
            "host.Shape + shape.Shape + host.Measure() + Extensions.Shape(host)",
            printed,
            StringComparison.Ordinal
        )
        Assert.Contains("class Extensions", printed, StringComparison.Ordinal)
        Assert.Contains("func Shape(host Host)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("func (host Host) Shape", printed, StringComparison.Ordinal)
        Assert.Contains("func (host Host) Measure(unused int32 = 0)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("host.Shape()", printed, StringComparison.Ordinal)
        AssertCompilesWithoutErrors(printed)
    }

    shared {
        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func AssertCompilesWithoutErrors(source string) {
            let compilation = GSharpCompilation(GSharpSyntaxTree.Parse(GSharpSourceText.From(source))){IsLibrary = true}
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "Emit failed:\n" + string.Join(
                    "\n",
                    result.Diagnostics.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.ToString())
                )
            )
            Assert.DoesNotContain(result.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
        }
    }
}
