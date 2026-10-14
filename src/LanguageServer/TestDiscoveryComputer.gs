// <copyright file="TestDiscoveryComputer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer.Protocol
import System
import System.Collections.Generic
import System.Linq

/// Pure-function test discovery usable by both the handler and tests. Walks a
/// document's syntax tree for functions annotated with a recognized test
/// attribute (xUnit/NUnit/MSTest) and produces a tree of (cref:TestDiscoveryItem).
shared class TestDiscoveryComputer {
    // Recognized test-method annotations across the common .NET test frameworks.
    // Matched against the annotation's last name segment, with or without the
    // conventional "Attribute" suffix.
    private let TestAttributeNames HashSet[string] = HashSet[string](StringComparer.Ordinal){
        "Fact",
        "Theory",
        "Test",
        "TestCase",
        "TestMethod"
    }

    /// Computes the discovered tests for a single document.
    /// @param uri The document URI (used on every emitted item).
    /// @param content The document content to scan.
    /// @returns The discovered top-level test items (class groups and free test functions).
    func ComputeTests(uri string, content DocumentContent) IReadOnlyList[TestDiscoveryItem] -> ComputeTests(
        uri,
        content?.SyntaxTree
    )

    /// Computes the discovered tests for a single syntax tree. This overload lets
    /// workspace-wide discovery scan a project's parsed source files directly,
    /// without requiring each file to be open in an editor buffer.
    /// @param uri The document URI (used on every emitted item).
    /// @param syntaxTree The parsed syntax tree to scan.
    /// @returns The discovered top-level test items (class groups and free test functions).
    func ComputeTests(uri string, syntaxTree SyntaxTree?) IReadOnlyList[TestDiscoveryItem] {
        let items = List[TestDiscoveryItem]()
        if syntaxTree?.Root == nil {
            return items
        }
        let namespaceName = ComputeNamespace(syntaxTree!!)
        for member in syntaxTree!!.Root.Members {
            switch member {
                case func_ is FunctionDeclarationSyntax when IsTest(func_) {
                    items.Add(CreateItem(uri, func_.Identifier, (name string) -> name))
                }
                case type is StructDeclarationSyntax when type.IsClass {
                    let className = type.Identifier.Text
                    let methods = type
                        .Methods
                        .Where(IsTest)
                        .Select(
                        (m FunctionDeclarationSyntax) -> CreateItem(
                            uri,
                            m.Identifier,
                            (name string) -> className + "." + name
                        )
                    )
                        .ToArray()
                    if methods.Length > 0 {
                        // The middle grouping node is the fully-qualified type name
                        // (<namespace>.<class>) — e.g. "Oahu.Cli.Tests.App.CredentialStoreTests" —
                        // so the Test Explorer reads Project (tfm) / Namespace.Class / Test.
                        let qualified = if string.IsNullOrEmpty(namespaceName) {
                            className
                        } else {
                            namespaceName + "." + className
                        }
                        items.Add(
                            TestDiscoveryItem{
                                Id: uri + "#" + qualified,
                                Label: qualified,
                                Uri: uri,
                                Line: LineOf(type.Identifier),
                                Filter: nil,
                                Children: methods
                            }
                        )
                    }
                }
            }
        }
        return items
    }

    /// Extracts the document's declared package (namespace) as a dotted string, or an
    /// empty string when the file declares no `package`. Used to qualify the test
    /// grouping node's label in the Test Explorer.
    /// @param syntaxTree The parsed syntax tree to inspect.
    /// @returns The dotted package name, or the empty string.
    func ComputeNamespace(syntaxTree SyntaxTree) string {
        let package_ PackageSyntax? = syntaxTree?.Root?.Members.OfType[PackageSyntax]().FirstOrDefault()
        if package_ == nil {
            return string.Empty
        }
        return string.Concat(package_.IdentifiersWithDots.Select((t SyntaxToken) -> t.Text))
    }

    private func IsTest(function FunctionDeclarationSyntax) bool {
        for annotation in function.Annotations {
            let name = LastSegment(annotation.GetNameText())
            if TestAttributeNames.Contains(name) ||
                (
                name.EndsWith("Attribute", StringComparison.Ordinal) && TestAttributeNames.Contains(
                    name.Substring(0, name.Length - "Attribute".Length)
                )
            ) {
                return true
            }
        }
        return false
    }

    private func CreateItem(uri string, identifier SyntaxToken, toFilter(string) -> string) TestDiscoveryItem {
        let name = identifier.Text
        return TestDiscoveryItem{
            Id: uri + "#" + toFilter(name),
            Label: name,
            Uri: uri,
            Line: LineOf(identifier),
            Filter: toFilter(name),
            Children: nil
        }
    }

    private func LineOf(token SyntaxToken) int32 -> SemanticLookup.ToRange(token).Start.Line

    private func LastSegment(dottedName string) string {
        if string.IsNullOrEmpty(dottedName) {
            return dottedName
        }
        let lastDot = dottedName.LastIndexOf('.')
        return if lastDot < 0 {
            dottedName
        } else {
            dottedName.Substring(lastDot + 1)
        }
    }
}
