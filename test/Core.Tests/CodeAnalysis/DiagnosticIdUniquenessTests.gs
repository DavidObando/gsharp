// <copyright file="DiagnosticIdUniquenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Text.RegularExpressions
import GSharp.Core.CodeAnalysis
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import Xunit
import CoreDiagnosticDescriptor = GSharp.Core.CodeAnalysis.DiagnosticDescriptor
import GSharpSyntax = GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.Tests

/// Guards the stable public contract formed by diagnostic IDs, descriptors,
/// report methods, and the diagnostic reference documentation.
open class DiagnosticIdUniquenessTests {
    @Fact
    func Every_DiagnosticId_Maps_To_Exactly_One_Message_Shape() {
        let repoRoot = FindRepoRoot()
        let idToShapes = Dictionary[string, Dictionary[string, string]]()
        for field in GetDescriptorFields() {
            let descriptor CoreDiagnosticDescriptor? = cast[CoreDiagnosticDescriptor](field.GetValue(nil))
            RecordShape(
                descriptor!!.Id,
                "DiagnosticDescriptors.${field.Name}",
                Path.Combine("src", "Core", "CodeAnalysis", "DiagnosticDescriptors.cs"),
                idToShapes
            )
        }
        // Issue #4656: the tree's own language (C# before the cut-over, G#
        // after), and a scan that finds nothing fails. The NotEmpty below is
        // satisfied by the reflected descriptors alone, so it never proved the
        // scan read anything.
        for file in TestSource.SourceFiles(SearchOption.AllDirectories, "src") {
            if TestSource.IsGSharp {
                RecordGSharpLiteralCallSites(file, repoRoot, idToShapes)
                continue
            }
            let text = File.ReadAllText(file)
            let root = CSharpSyntaxTree.ParseText(text, path: file).GetCompilationUnitRoot()
            for creation in root.DescendantNodes()
                .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.ObjectCreationExpressionSyntax]() {
                if GetSimpleName(creation.Type) == "Diagnostic" && creation.ArgumentList != nil {
                    RecordLiteralCallSite(creation.ArgumentList, creation, file, repoRoot, text, idToShapes)
                }
            }
        }
        Assert.NotEmpty(idToShapes)
        let collisions = idToShapes
            .Where((kv KeyValuePair[string, Dictionary[string, string]]) -> kv.Value.Count > 1)
            .OrderBy((kv KeyValuePair[string, Dictionary[string, string]]) -> kv.Key, StringComparer.Ordinal)
            .Select(
            (kv KeyValuePair[string, Dictionary[string, string]]) -> (
                ("${kv.Key}" + ` is used from ` + "${kv.Value.Count}" + ` distinct shapes:
`) + string.Join("\n", kv.Value.Select((t KeyValuePair[string, string]) -> "    ${t.Value}: ${t.Key}"))
            )
        )
            .ToArray()
        Assert.True(collisions.Length == 0, `Duplicate diagnostic IDs found (each GS#### must map to exactly one message shape):

` + string.Join(`

`, collisions))
    }

    @Fact
    func Every_Report_Uses_A_Descriptor_And_Every_Descriptor_Is_Used() {
        let descriptorNames = GetDescriptorFields().Select((field FieldInfo) -> field.Name).ToHashSet(
            StringComparer.Ordinal
        )
        let referencedDescriptors = HashSet[string](StringComparer.Ordinal)
        // Issue #4656: the tree's own language, and an empty scan throws.
        for file in TestSource.SourceFilesMatching(
            "DiagnosticBag.Reports.*",
            SearchOption.TopDirectoryOnly,
            "src/Core/CodeAnalysis"
        ) {
            if TestSource.IsGSharp {
                CheckGSharpReportFile(file, referencedDescriptors)
                continue
            }
            let root = CSharpSyntaxTree.ParseText(File.ReadAllText(file), path: file).GetCompilationUnitRoot()
            for invocation in root.DescendantNodes().OfType[InvocationExpressionSyntax]() {
                let name = GetSimpleName(invocation.Expression)
                if !((name == "Report" || name == "ReportWithErrorPromotion")) {
                    continue
                }
                let arguments = invocation.ArgumentList.Arguments
                Assert.True(arguments.Count >= 2, "$file: malformed $name invocation")
                let descriptorAccess = Assert.IsType[MemberAccessExpressionSyntax](arguments[1].Expression)
                Assert.Equal("DiagnosticDescriptors", descriptorAccess.Expression.ToString())
                let descriptorName = descriptorAccess.Name.Identifier.ValueText
                let reportMethod = invocation.Ancestors().OfType[MethodDeclarationSyntax]().First()
                Assert.Equal(reportMethod.Identifier.ValueText["Report".Length ..], descriptorName)
                referencedDescriptors.Add(descriptorName)
            }
            for method in root
                .DescendantNodes()
                .OfType[MethodDeclarationSyntax]()
                .Where(
                (method MethodDeclarationSyntax) -> method
                    .Identifier
                    .ValueText
                    .StartsWith("Report", StringComparison.Ordinal)
            ) {
                let routesToDiagnostic = method
                    .DescendantNodes()
                    .OfType[InvocationExpressionSyntax]()
                    .Any(
                    (invocation InvocationExpressionSyntax) -> GetSimpleName(invocation.Expression).StartsWith(
                        "Report",
                        StringComparison.Ordinal
                    )
                )
                Assert.True(
                    routesToDiagnostic,
                    "${method.Identifier.ValueText} does not route to a diagnostic descriptor."
                )
            }
        }
        for file in TestSource.SourceFiles(SearchOption.AllDirectories, "src") {
            if TestSource.IsGSharp {
                for access in GSharpSourceSyntax
                    .Parse(file)
                    .Root
                    .DescendantNodes()
                    .OfType[AccessorExpressionSyntax]()
                    .Where(
                    (access AccessorExpressionSyntax) -> GSharpSourceSyntax.SimpleName(
                        access.LeftPart
                    ) == "DiagnosticDescriptors"
                ) {
                    let descriptorName = GSharpSourceSyntax.SimpleName(access.RightPart)
                    if descriptorNames.Contains(descriptorName) {
                        referencedDescriptors.Add(descriptorName)
                    }
                }
                continue
            }
            let root = CSharpSyntaxTree.ParseText(File.ReadAllText(file), path: file).GetCompilationUnitRoot()
            for access in root
                .DescendantNodes()
                .OfType[MemberAccessExpressionSyntax]()
                .Where(
                (access MemberAccessExpressionSyntax) -> access.Expression.ToString() == "DiagnosticDescriptors"
            ) {
                if descriptorNames.Contains(access.Name.Identifier.ValueText) {
                    referencedDescriptors.Add(access.Name.Identifier.ValueText)
                }
            }
        }
        Assert.Equal(
            descriptorNames.OrderBy((name string) -> name, StringComparer.Ordinal),
            referencedDescriptors.OrderBy((name string) -> name, StringComparer.Ordinal)
        )
    }

    @Fact
    func Every_Descriptor_MessageFormat_Is_Valid() {
        let arguments = Enumerable.Repeat[object]("value", 32).ToArray()
        for field in GetDescriptorFields() {
            let descriptor CoreDiagnosticDescriptor? = cast[CoreDiagnosticDescriptor](field.GetValue(nil))
            let exception Exception? = Record.Exception(
                () -> {
                    let _ = string.Format(descriptor!!.MessageFormat, arguments)
                }
            )
            Assert.True(exception == nil, "${field.Name} has an invalid message format: $exception")
        }
    }

    @Fact
    func Every_Diagnostic_Is_Documented_In_Both_References_With_Matching_Severity() {
        let expectedSeverities = GetDescriptorFields().Select(
            (field FieldInfo) -> cast[GSharp.Core.CodeAnalysis.DiagnosticDescriptor](field.GetValue(nil))
        )
            .ToDictionary(
            func (descriptor GSharp.Core.CodeAnalysis.DiagnosticDescriptor) string {
                return descriptor.Id
            },
            (descriptor GSharp.Core.CodeAnalysis.DiagnosticDescriptor) -> descriptor.Severity.ToString(),
            StringComparer.Ordinal
        )
        // These diagnostics intentionally live outside DiagnosticDescriptors.
        // Add an entry only for a directly emitted, retired, or reserved ID.
        let documentedNonDescriptorSeverities = Dictionary[string, string](StringComparer.Ordinal){
            ["GS0190"] = "Error",
            ["GS0217"] = "Retired",
            ["GS0103"] = "Retired",
            ["GS0242"] = "Retired",
            ["GS0294"] = "Retired",
            ["GS0314"] = "Retired",
            ["GS0356"] = "Retired",
            ["GS0316"] = "Retired",
            ["GS0317"] = "Retired",
            ["GS0410"] = "Retired",
            ["GS0419"] = "Reserved",
            ["GS9100"] = "Warning",
            ["GS9200"] = "Error",
            ["GS9201"] = "Reserved",
            ["GS9202"] = "Reserved",
            ["GS9203"] = "Warning",
            ["GS9204"] = "Info",
            ["GS9205"] = "Reserved",
            ["GS9206"] = "Reserved",
            ["GS9207"] = "Info",
            ["GS9208"] = "Error",
            ["GS9209"] = "Error",
            ["GS9998"] = "Error",
            ["GS9999"] = "Error"
        }
        for item in documentedNonDescriptorSeverities {
            expectedSeverities.Add(item.Key, item.Value)
        }
        let repoRoot = FindRepoRoot()
        let primaryPath = Path.Combine(repoRoot, "docs", "diagnostics.md")
        let websitePath = Path.Combine(repoRoot, "website", "docs", "ref", "diagnostics.md")
        let primaryRows = AssertDocumentationMatches(primaryPath, expectedSeverities)
        let websiteRows = AssertDocumentationMatches(websitePath, expectedSeverities)
        let differingRows = expectedSeverities
            .Keys
            .Where((id string) -> primaryRows[id] != websiteRows[id])
            .OrderBy((id string) -> id, StringComparer.Ordinal)
            .Select((id string) -> (("$id" + `:
`) + (`  docs/diagnostics.md: ` + "${primaryRows[id]}" + `
`) + "  website/docs/ref/diagnostics.md: ${websiteRows[id]}"))
            .ToArray()
        Assert.True(differingRows.Length == 0, "Diagnostic reference rows differ:\n" + string.Join("\n", differingRows))
    }

    shared {
        private func GetDescriptorFields()[]FieldInfo {
            let fields = typeof(DiagnosticDescriptors)
                .GetFields(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
                .Where((field FieldInfo) -> field.FieldType == typeof(GSharp.Core.CodeAnalysis.DiagnosticDescriptor))
                .ToArray()
            // Every guard in this class quantifies over these fields. If the
            // descriptors stop being static fields of this exact type (a different
            // emit of the same source, for one), an empty set would make them all
            // pass having checked nothing.
            Assert.True(fields.Length > 400, "only ${fields.Length} diagnostic descriptor fields were reflected")
            return fields
        }

        private func AssertDocumentationMatches(
            path string,
            expectedSeverities IReadOnlyDictionary[string, string]
        ) IReadOnlyDictionary[string, string] {
            let referencePath = Path.GetRelativePath(FindRepoRoot(), path)
            let documentedRows = Regex
                .Matches(
                File.ReadAllText(path),
                "^\\|\\s*(GS\\d{4})\\s*\\|\\s*([^|]+?)\\s*\\|(.*?)\\|\\s*$$",
                RegexOptions.Multiline
            )
                .Cast[Match]()
                .ToArray()
            let documentedSeverityGroups = documentedRows.GroupBy(
                (match Match) -> match.Groups[1].Value,
                StringComparer.Ordinal
            )
                .ToArray()
            let duplicateRows = documentedSeverityGroups
                .Where((group IGrouping[string, Match]) -> group.Count() != 1)
                .Select((group IGrouping[string, Match]) -> "${group.Key}: ${group.Count()} rows")
                .ToArray()
            Assert.True(documentedRows.Length == documentedSeverityGroups.Length, ("$referencePath" + ` contains duplicate diagnostic rows:
`) + string.Join("\n", duplicateRows))
            let conflictingSeverities = documentedSeverityGroups
                .Select(
                (group IGrouping[string, Match]) -> (
                    Id: group.Key,
                    Severities: group.Select(NormalizeDocumentedSeverity).Distinct(StringComparer.Ordinal).ToArray()
                )
            )
                .Where((item(Id string, Severities[]string)) -> item.Item2.Length > 1)
                .Select((item(Id string, Severities[]string)) -> "${item.Item1}: ${string.Join(", ", item.Item2)}")
                .ToArray()
            Assert.True(conflictingSeverities.Length == 0, ("$referencePath" + ` documents diagnostics with conflicting severities:
`) + string.Join("\n", conflictingSeverities))
            let documentedSeverities = documentedSeverityGroups.ToDictionary(
                func (group IGrouping[string, Match]) string {
                    return group.Key
                },
                (group IGrouping[string, Match]) -> NormalizeDocumentedSeverity(group.First()),
                StringComparer.Ordinal
            )
            let missing = expectedSeverities
                .Keys
                .Except(documentedSeverities.Keys, StringComparer.Ordinal)
                .OrderBy((id string) -> id, StringComparer.Ordinal)
                .ToArray()
            let unexpected = documentedSeverities
                .Keys
                .Except(expectedSeverities.Keys, StringComparer.Ordinal)
                .OrderBy((id string) -> id, StringComparer.Ordinal)
                .ToArray()
            let mismatched = expectedSeverities
                .Keys
                .Intersect(documentedSeverities.Keys, StringComparer.Ordinal)
                .Where((id string) -> expectedSeverities[id] != documentedSeverities[id])
                .OrderBy((id string) -> id, StringComparer.Ordinal)
                .Select((id string) -> "$id: expected ${expectedSeverities[id]}, found ${documentedSeverities[id]}")
                .ToArray()
            Assert.True(missing.Length == 0 && unexpected.Length == 0 && mismatched.Length == 0, ("$referencePath" + ` is out of sync with compiler diagnostics:
`) + (`Missing from ` + "$referencePath" + `: ` + "${string.Join(", ", missing)}" + `
`) + (`Unexpected in ` + "$referencePath" + `: ` + "${string.Join(", ", unexpected)}" + `
`) + (`Severity mismatches in ` + "$referencePath" + `:
` + "${string.Join("\n", mismatched)}"))
            return documentedSeverityGroups.ToDictionary(
                func (group IGrouping[string, Match]) string {
                    return group.Key
                },
                (group IGrouping[string, Match]) -> NormalizeDocumentedRow(group.Single()),
                StringComparer.Ordinal
            )
        }

        private func NormalizeDocumentedRow(match Match) string {
            let remainingColumns = Regex
                .Split(match.Groups[3].Value.Trim(), "\\s*\\|\\s*")
                .Select((column string) -> column.Trim())
                .ToList()
            while remainingColumns.Count > 0 && remainingColumns[^1].Length == 0 {
                remainingColumns.RemoveAt(remainingColumns.Count - 1)
            }
            return string.Join(" | ", []string{match.Groups[2].Value.Trim()}.Concat(remainingColumns))
        }

        private func NormalizeDocumentedSeverity(match Match) string {
            let severity = match.Groups[2].Value.Trim().TrimStart('*', '_')
            let severityMatch = Regex.Match(severity, "^(Error|Warning|Info|Retired|Reserved)\\b")
            return if severityMatch.Success {
                severityMatch.Groups[1].Value
            } else {
                severity.Trim('*', '_')
            }
        }

        private func RecordLiteralCallSite(
            argumentList ArgumentListSyntax?,
            callNode Microsoft.CodeAnalysis.SyntaxNode,
            file string,
            repoRoot string,
            text string,
            idToShapes Dictionary[string, Dictionary[string, string]]
        ) {
            let idLiteral Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .LiteralExpressionSyntax? = argumentList!!
                .Arguments
                .Select((argument ArgumentSyntax) -> argument.Expression)
                .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.LiteralExpressionSyntax]()
                .FirstOrDefault(
                (literal Microsoft.CodeAnalysis.CSharp.Syntax.LiteralExpressionSyntax) -> literal.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.StringLiteralExpression
                ) &&
                    IsGsId(literal.Token.ValueText)
            )
            if idLiteral == nil {
                return
            }
            let line = text[.. callNode.SpanStart].Count((character char) -> character == '\n') + 1
            RecordShape(
                idLiteral.Token.ValueText,
                GetEnclosingMemberName(callNode),
                "${Path.GetRelativePath(repoRoot, file)}:$line",
                idToShapes
            )
        }

        private func RecordShape(
            id string,
            shape string,
            site string,
            idToShapes Dictionary[string, Dictionary[string, string]]
        ) {
            if !idToShapes.TryGetValue(id, out var shapes) {
                shapes = Dictionary[string, string]()
                idToShapes[id] = shapes
            }
            if !shapes.ContainsKey(shape) {
                shapes[shape] = site
            }
        }

        private func IsGsId(value string?) bool -> value!!.Length == 6 && value!!.StartsWith(
            "GS",
            StringComparison.Ordinal
        ) &&
            value!![2 ..].All(char.IsDigit)

        private func GetSimpleName(expression Microsoft.CodeAnalysis.SyntaxNode) string -> switch expression {
            case member is MemberAccessExpressionSyntax: member.Name.Identifier.ValueText
            case identifier is IdentifierNameSyntax: identifier.Identifier.ValueText
            case generic is GenericNameSyntax: generic.Identifier.ValueText
            default: string.Empty
        }

        private func GetEnclosingMemberName(node Microsoft.CodeAnalysis.SyntaxNode) string {
            for var current Microsoft
                .CodeAnalysis
                .SyntaxNode? = node.Parent;
                current != nil;
                current = current!!
                .Parent {
                switch current {
                    case method is MethodDeclarationSyntax {
                        return method.Identifier.ValueText
                    }
                    case localFunction is LocalFunctionStatementSyntax {
                        return localFunction.Identifier.ValueText
                    }
                    case constructor is Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax {
                        return constructor.Identifier.ValueText
                    }
                    case accessor is AccessorDeclarationSyntax {
                        return "${(accessor.Parent?.Parent as Microsoft.CodeAnalysis.CSharp.Syntax.PropertyDeclarationSyntax)?.Identifier.ValueText}.${accessor.Keyword.ValueText}"
                    }
                }
            }
            return "<top-level>"
        }

        private func FindRepoRoot() string -> TestSource.Root

        /// Issue #4656: the G# form of the literal call-site scan. G# constructs a
        /// diagnostic with a call, `Diagnostic(location, "GS0190", ...)`.
        private func RecordGSharpLiteralCallSites(
            file string,
            repoRoot string,
            idToShapes Dictionary[string, Dictionary[string, string]]
        ) {
            let tree GSharp.Core.CodeAnalysis.Syntax.SyntaxTree? = GSharpSourceSyntax.Parse(file)
            for call in tree!!
                .Root
                .DescendantNodes()
                .OfType[CallExpressionSyntax]()
                .Where((call CallExpressionSyntax) -> GSharpSourceSyntax.SimpleName(call) == "Diagnostic") {
                let id string? = call
                    .Arguments
                    .Select(
                    (argument GSharp.Core.CodeAnalysis.Syntax.ExpressionSyntax) -> GSharpSourceSyntax.StringLiteral(
                        argument
                    )
                )
                    .FirstOrDefault((value string) -> value != nil && IsGsId(value))
                if id == nil {
                    continue
                }
                let line = tree!!.Text.GetLineIndex(call.Span.Start) + 1
                RecordShape(
                    id,
                    GSharpSourceSyntax.NearestMemberName(call),
                    "${Path.GetRelativePath(repoRoot, file).Replace('\\', '/')}:$line",
                    idToShapes
                )
            }
        }

        /// Issue #4656: the G# form of the report-file check. Each
        /// `Report`/`ReportWithErrorPromotion` call passes
        /// `DiagnosticDescriptors.X` second, where `X` is the reporting
        /// function's name without `Report`, and every `Report*`
        /// function routes to such a call.
        private func CheckGSharpReportFile(file string, referencedDescriptors HashSet[string]) {
            let root = GSharpSourceSyntax.Parse(file).Root
            for call in root.DescendantNodes().OfType[CallExpressionSyntax]() {
                let name = GSharpSourceSyntax.SimpleName(call)
                if !((name == "Report" || name == "ReportWithErrorPromotion")) {
                    continue
                }
                Assert.True(call.Arguments.Count >= 2, "$file: malformed $name call")
                let descriptorAccess = Assert.IsType[AccessorExpressionSyntax](call.Arguments[1])
                Assert.Equal("DiagnosticDescriptors", GSharpSourceSyntax.SimpleName(descriptorAccess.LeftPart))
                let descriptorName = GSharpSourceSyntax.SimpleName(descriptorAccess.RightPart)
                let reportFunction FunctionDeclarationSyntax? = call
                    .Ancestors()
                    .OfType[FunctionDeclarationSyntax]()
                    .FirstOrDefault(
                    (function FunctionDeclarationSyntax) -> function
                        .Identifier
                        .Text
                        .StartsWith("Report", StringComparison.Ordinal)
                )
                Assert.True(reportFunction != nil, "$file: $name is called outside a Report* function")
                Assert.Equal(reportFunction!!.Identifier.Text["Report".Length ..], descriptorName)
                referencedDescriptors.Add(descriptorName)
            }
            for function in root
                .DescendantNodes()
                .OfType[FunctionDeclarationSyntax]()
                .Where(
                (function FunctionDeclarationSyntax) -> function
                    .Identifier
                    .Text
                    .StartsWith("Report", StringComparison.Ordinal)
            ) {
                let routesToDiagnostic = function
                    .DescendantNodes()
                    .OfType[CallExpressionSyntax]()
                    .Any(
                    (call CallExpressionSyntax) -> GSharpSourceSyntax.SimpleName(call).StartsWith(
                        "Report",
                        StringComparison.Ordinal
                    )
                )
                Assert.True(
                    routesToDiagnostic,
                    "${function.Identifier.Text} does not route to a diagnostic descriptor."
                )
            }
        }
    }
}
