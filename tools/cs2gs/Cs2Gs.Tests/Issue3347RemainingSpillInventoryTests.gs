// <copyright file="Issue3347RemainingSpillInventoryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharpAsExpressionSyntax = GSharp.Core.CodeAnalysis.Syntax.AsExpressionSyntax
import GSharpExpressionSyntax = GSharp.Core.CodeAnalysis.Syntax.ExpressionSyntax
import GSharpParenthesizedExpressionSyntax = GSharp.Core.CodeAnalysis.Syntax.ParenthesizedExpressionSyntax
import GSharpSyntaxKind = GSharp.Core.CodeAnalysis.Syntax.SyntaxKind
import GSharpSyntaxNode = GSharp.Core.CodeAnalysis.Syntax.SyntaxNode
import GSharpSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharpUnaryExpressionSyntax = GSharp.Core.CodeAnalysis.Syntax.UnaryExpressionSyntax
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Current-state synthetic-spill inventory for issue #3347.
class Issue3347RemainingSpillInventoryTests {
    /// Issue #3423 ratchet. Regenerated from `be857f02c4`, Core started
    /// with 16 `__castN` occurrences (8 block conversions), 22
    /// `__deconN` occurrences (11 temp names), and 17 `__using`
    /// declarations. Those families and issue #3347's `__spillN`
    /// declarations are now retired from Core output; the companion translator
    /// project ratchet below protects its independently verified zero-spill output.
    @Fact
    async func CoreMigration_Issue3421CheckedCastNoiseAndSynthesizedNameFamiliesStayRetired() {
        let repoRoot = GsharpTestProjectRunner.FindRepoRoot()!!
        if CommittedCompilerSource.IsGSharp(repoRoot) {
            // Issue #4656: after the cut-over the committed G# IS the
            // translation. The same four families must not appear in it.
            var committedCasts = 0
            var committedDeconstructions = 0
            var committedSpills = 0
            var committedUsings = 0
            for file in CommittedCompilerSource.GSharpFiles(repoRoot, "src/Core") {
                let committed = File.ReadAllText(file)
                committedCasts += CountOccurrences(committed, "__cast")
                committedDeconstructions += CountOccurrences(committed, "__decon")
                committedSpills += CountOccurrences(StripCommentLines(committed), "let __spill")
                committedUsings += CountOccurrences(committed, "__using")
            }
            Assert.Equal(0, committedCasts)
            Assert.Equal(0, committedDeconstructions)
            Assert.Equal(0, committedSpills)
            Assert.Equal(0, committedUsings)
            return
        }
        let project = await CSharpProjectLoader.LoadProjectAsync(Path.Combine(repoRoot, "src", "Core", "Core.csproj"))
        Assert.True(
            project.BoundWithoutErrors,
            "Core should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        // Issue #4656: zero documents would count zero of everything and pass.
        Assert.NotEmpty(project.Documents)
        let translator = CSharpToGSharpTranslator(preservePartialParts: true)
        var castCount = 0
        var deconstructionCount = 0
        var spillCount = 0
        var usingCount = 0
        var sourceAssertedAsConversions = 0
        var translatedAssertedAsConversions = 0
        for document in project.Documents {
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(translator.TranslateDocument(document, context))
            castCount += CountOccurrences(printed, "__cast")
            deconstructionCount += CountOccurrences(printed, "__decon")
            // Issue #3469: author comments now flow into the emitted G#,
            // and Translator-source comments mention the very patterns this
            // inventory counts — count code lines only.
            spillCount += CountOccurrences(StripCommentLines(printed), "let __spill")
            usingCount += CountOccurrences(printed, "__using")
            sourceAssertedAsConversions += CountSourceAssertedAsConversions(document)
            translatedAssertedAsConversions += CountTranslatedAssertedAsConversions(printed)
        }
        Assert.Equal(0, castCount)
        Assert.Equal(0, deconstructionCount)
        Assert.Equal(0, spillCount)
        Assert.Equal(0, usingCount)
        Assert.Equal(sourceAssertedAsConversions, translatedAssertedAsConversions)
    }

    @Fact
    async func TranslatorMigration_SpillFamilyStaysRetired() {
        let repoRoot = GsharpTestProjectRunner.FindRepoRoot()!!
        if CommittedCompilerSource.IsGSharp(repoRoot) {
            // Issue #4656: the committed G# translator is checked directly.
            let committedSpills = CommittedCompilerSource.GSharpFiles(repoRoot, "tools/cs2gs/Cs2Gs.Translator").Sum(
                (file string) -> CountOccurrences(StripCommentLines(File.ReadAllText(file)), "let __spill")
            )
            Assert.Equal(0, committedSpills)
            return
        }
        let project = await CSharpProjectLoader.LoadProjectAsync(
            Path.Combine(repoRoot, "tools", "cs2gs", "Cs2Gs.Translator", "Cs2Gs.Translator.csproj")
        )
        Assert.True(
            project.BoundWithoutErrors,
            "Translator should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        // Issue #4656: zero documents would count zero spills and pass.
        Assert.NotEmpty(project.Documents)
        let translator = CSharpToGSharpTranslator(preservePartialParts: true)
        var spillCount = 0
        for document in project.Documents {
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(translator.TranslateDocument(document, context))
            // Issue #3469: author comments now flow into the emitted G#,
            // and Translator-source comments mention the very patterns this
            // inventory counts — count code lines only.
            spillCount += CountOccurrences(StripCommentLines(printed), "let __spill")
        }
        Assert.Equal(0, spillCount)
    }

    @Fact
    func Issue3421AssertedAsInventory_AllowsExplicitSourceSuppression() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", `public static class C
{
    public static int Length(object value) => (value as string)!.Length;
}`)})
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Equal(1, CountSourceAssertedAsConversions(document))
        Assert.Equal(1, CountTranslatedAssertedAsConversions(printed))
    }

    @Fact
    func NonBindingPatterns_UseNativeBooleanPatterns() {
        let printed = Translate(`public sealed class Node
{
    public object Value;
}

public static class C
{
    private static object Get() => "abc";

    public static bool Match(Node node) =>
        Get() is string { Length: > 0 } or int
        && node.Value is not null;
}`)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        Assert.Contains("Get() is string and { Length: > 0 } or int32", printed, StringComparison.Ordinal)
        Assert.Contains("node.Value != nil", printed, StringComparison.Ordinal)
    }

    /// ADR-0166 / issue #3409: a top-level typed binder with a native property
    /// residual is a native pattern variable in both value and statement
    /// position, so neither surface needs the `if let` lowering (or a spill).
    @Fact
    func TopLevelPatternBinders_UseNativePatternVariablesAcrossValueAndStatementPositions() {
        let printed = Translate(`public static class C
{
    private static object Get() => "abc";

    public static int Value() =>
        Get() is string { Length: > 0 } text && text[0] == 'a'
            ? text.Length
            : 0;

    public static int Statement()
    {
        if (Get() is string { Length: > 0 } text)
        {
            return text.Length;
        }

        return 0;
    }
}`)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        Assert.Contains(
            "if Get() is string { Length: > 0 } text && text[0] == 'a' { text.Length } else { 0 }",
            printed,
            StringComparison.Ordinal
        )
        Assert.Contains("if Get() is string { Length: > 0 } text {", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("as string", printed, StringComparison.Ordinal)
    }

    @Fact
    func IfLetResidualPatterns_PreserveNestedTypedConstraintsAcrossAllSurfaces() {
        let printed = Translate(`public sealed record Point(int X, int Y);
public sealed record Shape(Point Center);

public static class C
{
    private static object Get() => new Shape(new Point(0, 1));

    public static int Value() =>
        Get() is Shape { Center: Point(0, > 0) } shape
            ? shape.Center.Y
            : 0;

    public static int Statement()
    {
        if (Get() is Shape { Center: Point(0, > 0) } shape)
        {
            return shape.Center.Y;
        }

        return 0;
    }

    public static int Loop()
    {
        int result = 0;
        while (Get() is Shape { Center: Point(0, > 0) } shape)
        {
            result = shape.Center.Y;
            break;
        }

        return result;
    }

    public static bool Boolean() =>
        Get() is Shape { Center: Point(0, > 0) } shape
        && shape.Center.Y == 1;
}`)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        Assert.Equal(4, CountOccurrences(printed, "shape is { Center: Point and { X: 0, Y: > 0 } }"))
    }

    @Fact
    func NativeAssignmentExpressions_RemoveValueCarryingSpills() {
        let printed = Translate(`public sealed class Holder
{
    private int value;
    private readonly int[] values = new int[1];

    public int P
    {
        get => value;
        set => this.value = value;
    }

    public int this[int index]
    {
        set => values[index] = value;
    }
}

public static class C
{
    private static int Echo(int value) => value;

    public static int Assign(Holder holder)
    {
        int a = 0;
        int b = 0;
        a = b = Echo(holder.P = 5);
        return holder[0] = a + b;
    }
}`)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        Assert.Contains("a = (b = Echo((holder.P = 5)))", printed, StringComparison.Ordinal)
        Assert.Contains("return (holder[0] = a + b)", printed, StringComparison.Ordinal)
    }

    @Fact
    func VarPatternBindings_NoLongerRequireCrossScopeSpills() {
        let printed = Translate(`#nullable enable

public sealed class Item
{
    public int X;
    public int Y;
}

public static class C
{
    private static Item GetItem() => new Item();

    public static bool NestedBinding() =>
        GetItem() is { X: var x, Y: > 0 } && x > 0;
}`)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("&& true", printed, StringComparison.Ordinal)
        Assert.Contains("GetItem() is { X: var x, Y: > 0 } && x > 0", printed, StringComparison.Ordinal)
        Assert.Equal(1, CountOccurrences(printed, "GetItem() is"))
    }

    @Fact
    func MutableNestedGuardBinder_UsesNativeMatchThenAuthorNamedStorage() {
        let printed = Translate(`using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using System.Linq;

public static class C
{
    public static bool IsAsLocal(ILocalSymbol local)
    {
        if (local.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
            is not VariableDeclaratorSyntax { Initializer.Value: { } initializer })
        {
            return false;
        }

        while (initializer is ParenthesizedExpressionSyntax parenthesized)
        {
            initializer = parenthesized.Expression;
        }

        return initializer is BinaryExpressionSyntax;
    }
}`)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("&& true", printed, StringComparison.Ordinal)
        Assert.Contains("initializerMatch", printed, StringComparison.Ordinal)
        Assert.Contains("var initializer ExpressionSyntax = initializerMatch", printed, StringComparison.Ordinal)
    }

    @Fact
    func NullabilityOnlyMethodGroupDifference_UsesDirectMemberReference() {
        let printed = Translate(`using System;
using System.Diagnostics.CodeAnalysis;

public sealed class Mapper
{
    [return: NotNullIfNotNull(nameof(value))]
    public string? Map(string? value) => value;
}

public sealed class Holder
{
    public Mapper Mapper { get; } = new Mapper();
}

public static class C
{
    private static string Apply(string value, Func<string, string> map) => map(value);

    public static string Run(Holder holder, string value) =>
        Apply(value, holder.Mapper.Map);
}`)
        Assert.Contains("Apply(value, holder.Mapper.Map)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__arg", printed, StringComparison.Ordinal)
    }

    @Fact
    func CoalesceAssignmentOnNontrivialTarget_RemainsRequiredSpill() {
        let printed = Translate(`#nullable enable

public sealed class Item
{
    public string? Name { get; set; }
}

public static class C
{
    private static Item GetItem() => new Item();

    public static string Coalesce() =>
        GetItem().Name ??= "default";
}`)
        Assert.Contains("__spill", printed, StringComparison.Ordinal)
        Assert.Equal(1, CountOccurrences(printed, "= GetItem()"))
    }

    @Fact
    func AssignmentBodiedLambdas_PreserveValueOrDiscardContract() {
        let printed = Translate(`using System;

public sealed class Holder
{
    public int P { get; set; }
}

public static class C
{
    public static int Run(Holder holder)
    {
        Func<int> value = () => holder.P = 7;
        Action discard = () => holder.P = 8;
        int result = value();
        discard();
        return result + holder.P;
    }
}`)
        Assert.Contains("-> (holder.P = 7)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
    }

    @Fact
    func NativePatternDelimitersAndElseIfBindings_RemainScoped() {
        let printed = Translate(`public enum Phase
{
    Queued,
    Completed,
}

public sealed class Update
{
    public double? Progress;
    public Phase Phase;
}

public static class C
{
    private static object GetValue() => "ok";

    public static bool IsTerminal(Update update) =>
        update.Progress is 0.0 or 1.0
        || update.Phase is Phase.Queued or Phase.Completed;

    public static int ElseIf(bool first)
    {
        if (first)
        {
            return 1;
        }
        else if (GetValue() is string text && text.Length > 0)
        {
            return text.Length;
        }

        return 0;
    }
}`)
        Assert.Contains("(update.Progress is 0.0 or 1.0) ||", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
    }

    shared {
        private func StripCommentLines(printed string) string -> string.Join(
            "\n",
            printed.Split('\n').Where(
                (line string) -> {
                    let trimmed = line.TrimStart()
                    return !trimmed.StartsWith("//", StringComparison.Ordinal)
                }
            )
        )

        private func CountOccurrences(haystack string, needle string) int32 {
            var count = 0
            for var index = haystack.IndexOf(needle, StringComparison.Ordinal); index >= 0; index = haystack.IndexOf(
                needle,
                index + needle.Length,
                StringComparison.Ordinal
            ) {
                count++
            }
            return count
        }

        private func CountSourceAssertedAsConversions(document LoadedDocument) int32 -> document
            .GetRoot()
            .DescendantNodes()
            .OfType[PostfixUnaryExpressionSyntax]()
            .Count(
            (postfix PostfixUnaryExpressionSyntax) -> postfix.RawKind == int32(
                Microsoft.CodeAnalysis.CSharp.SyntaxKind.SuppressNullableWarningExpression
            ) &&
                UnwrapCSharpParentheses(postfix.Operand) is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .BinaryExpressionSyntax binary &&
                binary.RawKind == int32(Microsoft.CodeAnalysis.CSharp.SyntaxKind.AsExpression)
        )

        private func CountTranslatedAssertedAsConversions(printed string) int32 {
            let tree = GSharpSyntaxTree.Parse(printed)
            Assert.Empty(tree.Diagnostics)
            return Descendants(tree.Root).OfType[GSharpUnaryExpressionSyntax]().Count(IsAssertedAsConversion)
        }

        private func UnwrapCSharpParentheses(expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax) Microsoft
            .CodeAnalysis
            .CSharp
            .Syntax
            .ExpressionSyntax {
            var expression = expression
            while expression is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax parenthesized {
                expression = parenthesized.Expression
            }
            return expression
        }

        private func IsAssertedAsConversion(unary GSharpUnaryExpressionSyntax) bool {
            if unary.OperatorToken.Kind != GSharpSyntaxKind.BangBangToken {
                return false
            }
            var operand = unary.Operand
            while operand is GSharpParenthesizedExpressionSyntax parenthesized {
                operand = parenthesized.Expression
            }
            return operand is GSharpAsExpressionSyntax
        }

        private func Descendants(node GSharpSyntaxNode) sequence[GSharpSyntaxNode] {
            yield node
            for child in node.GetChildren() {
                for descendant in Descendants(child) {
                    yield descendant
                }
            }
        }

        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", `using System;

namespace Demo
{
` + source + `
}
`)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(result!!.Success, "Translated G# must bind. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed)
            return printed
        }
    }
}
