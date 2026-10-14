// <copyright file="DocumentationValidator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Documentation

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// Validates documentation comments across a compilation or syntax tree,
/// emitting diagnostics for missing, floating, or unknown doc tags.
shared class DocumentationValidator {
    private let KnownTags HashSet[string] = HashSet[string](StringComparer.Ordinal){
        "@param",
        "@typeparam",
        "@returns",
        "@remarks",
        "@value",
        "@exception",
        "@seealso"
    }

    /// Validates documentation across a single syntax tree, emitting diagnostics.
    /// Called after binding is complete.
    /// @param tree The syntax tree being validated.
    /// @param functions The bound source functions.
    /// @param structs The bound source aggregate types.
    /// @param diagnostics The bag that receives documentation diagnostics.
    /// @param warnOnMissingDocs Whether missing public documentation should produce GS0228.
    func Validate(
        tree SyntaxTree,
        functions ImmutableArray[FunctionSymbol],
        structs ImmutableArray[StructSymbol],
        diagnostics DiagnosticBag,
        warnOnMissingDocs bool
    ) {
        Validate(ImmutableArray.Create(tree), functions, structs, diagnostics, warnOnMissingDocs)
    }

    /// Validates documentation across the compilation, emitting diagnostics.
    /// Called after binding is complete.
    /// @param trees The syntax trees in the compilation.
    /// @param functions The bound source functions.
    /// @param structs The bound source aggregate types.
    /// @param diagnostics The bag that receives documentation diagnostics.
    /// @param warnOnMissingDocs Whether missing public documentation should produce GS0228.
    func Validate(
        trees ImmutableArray[SyntaxTree],
        functions ImmutableArray[FunctionSymbol],
        structs ImmutableArray[StructSymbol],
        diagnostics DiagnosticBag,
        warnOnMissingDocs bool
    ) {
        for tree in trees {
            ValidateFloatingDocComments(tree, diagnostics)
            ValidateUnknownTags(tree, diagnostics)
        }
        ValidateParamMatches(functions, diagnostics)
        if warnOnMissingDocs {
            ValidateMissingDocs(functions, structs, diagnostics)
        }
    }

    private func ValidateFloatingDocComments(tree SyntaxTree, diagnostics DiagnosticBag) {
        let blocks = DocumentationAttacher.GetBlocks(tree)
        if blocks.IsDefaultOrEmpty {
            return
        }
        let declarations = DocumentationAttacher.GetDocumentableDeclarations(tree)
        if declarations.Count == 0 {
            for block in blocks {
                diagnostics.ReportFloatingDocumentationComment(block.Location)
            }
            return
        }
        let attached = [blocks.Length]bool
        var declIndex = 0
        for var i = 0; i < blocks.Length; i++ {
            let block = blocks[i]
            while declIndex < declarations.Count && declarations[declIndex].Span.Start < block.EndPosition {
                declIndex++
            }
            if declIndex >= declarations.Count {
                break
            }
            let candidate = declarations[declIndex]
            let candidateLine = tree.Text.GetLineIndex(candidate.Span.Start)
            if candidateLine == block.LastLine + 1 {
                attached[i] = true
            }
        }
        for var i = 0; i < blocks.Length; i++ {
            if !attached[i] {
                diagnostics.ReportFloatingDocumentationComment(blocks[i].Location)
            }
        }
    }

    private func ValidateUnknownTags(tree SyntaxTree, diagnostics DiagnosticBag) {
        let blocks = DocumentationAttacher.GetBlocks(tree)
        if blocks.IsDefaultOrEmpty {
            return
        }
        for block in blocks {
            for line in block.Text.Split('\n') {
                let trimmed = line.TrimStart()
                if trimmed.Length < 2 || trimmed[0] != '@' {
                    continue
                }
                // Extract the tag name: everything from '@' up to the first space or end of line.
                let spaceIdx = trimmed.IndexOf(' ')
                let tag = if spaceIdx < 0 {
                    trimmed
                } else {
                    trimmed.Substring(0, spaceIdx)
                }
                if !KnownTags.Contains(tag) {
                    diagnostics.ReportUnknownDocumentationTag(block.Location, tag)
                }
            }
        }
    }

    private func ValidateParamMatches(functions ImmutableArray[FunctionSymbol], diagnostics DiagnosticBag) {
        for function in functions {
            if function.Declaration == nil {
                continue
            }
            let documentation DocumentationComment? = function.GetDocumentation()
            if documentation == nil {
                continue
            }
            let parameterNames = HashSet[string](
                function.Parameters.Select((p ParameterSymbol) -> p.Name),
                StringComparer.Ordinal
            )
            for parameter in documentation.Parameters {
                if parameter.Name != nil && !parameterNames.Contains(parameter.Name) {
                    diagnostics.ReportDocParamMismatch(function.Declaration!!.Location, parameter.Name, function.Name)
                }
            }
            let typeParameterNames = HashSet[string](
                function.TypeParameters.Select((tp TypeParameterSymbol) -> tp.Name),
                StringComparer.Ordinal
            )
            for typeParameter in documentation.TypeParameters {
                if typeParameter.Name != nil && !typeParameterNames.Contains(typeParameter.Name) {
                    diagnostics.ReportDocParamMismatch(
                        function.Declaration!!.Location,
                        typeParameter.Name,
                        function.Name
                    )
                }
            }
        }
    }

    private func ValidateMissingDocs(
        functions ImmutableArray[FunctionSymbol],
        structs ImmutableArray[StructSymbol],
        diagnostics DiagnosticBag
    ) {
        for function in functions {
            if function.Declaration != nil &&
                function.Accessibility == Accessibility.Public &&
                function.GetDocumentation() == nil {
                diagnostics.ReportMissingDocumentation(function.Declaration!!.Location, function.Name)
            }
        }
        for type in structs {
            if type.Declaration != nil && type.Accessibility == Accessibility.Public && type.GetDocumentation() == nil {
                diagnostics.ReportMissingDocumentation(type.Declaration!!.Location, type.Name)
            }
            ValidateMissingPropertyDocs(type.Properties, diagnostics)
            ValidateMissingPropertyDocs(type.StaticProperties, diagnostics)
        }
    }

    private func ValidateMissingPropertyDocs(properties ImmutableArray[PropertySymbol], diagnostics DiagnosticBag) {
        for property in properties {
            if property.Declaration != nil &&
                property.Accessibility == Accessibility.Public &&
                property.GetDocumentation() == nil {
                diagnostics.ReportMissingDocumentation(property.Declaration!!.Location, property.Name)
            }
        }
    }
}
