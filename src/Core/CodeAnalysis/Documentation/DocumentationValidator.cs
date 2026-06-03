// <copyright file="DocumentationValidator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Documentation;

internal static class DocumentationValidator
{
    private static readonly HashSet<string> KnownTags = new(StringComparer.Ordinal)
    {
        "@param",
        "@typeparam",
        "@returns",
        "@remarks",
        "@value",
        "@exception",
        "@seealso",
    };

    /// <summary>
    /// Validates documentation across a single syntax tree, emitting diagnostics.
    /// Called after binding is complete.
    /// </summary>
    /// <param name="tree">The syntax tree being validated.</param>
    /// <param name="functions">The bound source functions.</param>
    /// <param name="structs">The bound source aggregate types.</param>
    /// <param name="diagnostics">The bag that receives documentation diagnostics.</param>
    /// <param name="warnOnMissingDocs">Whether missing public documentation should produce GS0228.</param>
    public static void Validate(
        SyntaxTree tree,
        ImmutableArray<FunctionSymbol> functions,
        ImmutableArray<StructSymbol> structs,
        DiagnosticBag diagnostics,
        bool warnOnMissingDocs)
    {
        Validate(ImmutableArray.Create(tree), functions, structs, diagnostics, warnOnMissingDocs);
    }

    /// <summary>
    /// Validates documentation across the compilation, emitting diagnostics.
    /// Called after binding is complete.
    /// </summary>
    /// <param name="trees">The syntax trees in the compilation.</param>
    /// <param name="functions">The bound source functions.</param>
    /// <param name="structs">The bound source aggregate types.</param>
    /// <param name="diagnostics">The bag that receives documentation diagnostics.</param>
    /// <param name="warnOnMissingDocs">Whether missing public documentation should produce GS0228.</param>
    public static void Validate(
        ImmutableArray<SyntaxTree> trees,
        ImmutableArray<FunctionSymbol> functions,
        ImmutableArray<StructSymbol> structs,
        DiagnosticBag diagnostics,
        bool warnOnMissingDocs)
    {
        foreach (var tree in trees)
        {
            ValidateFloatingDocComments(tree, diagnostics);
            ValidateUnknownTags(tree, diagnostics);
        }

        ValidateParamMatches(functions, diagnostics);
        if (warnOnMissingDocs)
        {
            ValidateMissingDocs(functions, structs, diagnostics);
        }
    }

    private static void ValidateFloatingDocComments(SyntaxTree tree, DiagnosticBag diagnostics)
    {
        var blocks = DocumentationAttacher.GetBlocks(tree);
        if (blocks.IsDefaultOrEmpty)
        {
            return;
        }

        var declarations = DocumentationAttacher.GetDocumentableDeclarations(tree);
        if (declarations.Count == 0)
        {
            foreach (var block in blocks)
            {
                diagnostics.ReportFloatingDocumentationComment(block.Location);
            }

            return;
        }

        var attached = new bool[blocks.Length];
        var declIndex = 0;
        for (var i = 0; i < blocks.Length; i++)
        {
            var block = blocks[i];
            while (declIndex < declarations.Count && declarations[declIndex].Span.Start < block.EndPosition)
            {
                declIndex++;
            }

            if (declIndex >= declarations.Count)
            {
                break;
            }

            var candidate = declarations[declIndex];
            var candidateLine = tree.Text.GetLineIndex(candidate.Span.Start);
            if (candidateLine == block.LastLine + 1)
            {
                attached[i] = true;
            }
        }

        for (var i = 0; i < blocks.Length; i++)
        {
            if (!attached[i])
            {
                diagnostics.ReportFloatingDocumentationComment(blocks[i].Location);
            }
        }
    }

    private static void ValidateUnknownTags(SyntaxTree tree, DiagnosticBag diagnostics)
    {
        var blocks = DocumentationAttacher.GetBlocks(tree);
        if (blocks.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var block in blocks)
        {
            foreach (var line in block.Text.Split('\n'))
            {
                var trimmed = line.TrimStart();
                if (trimmed.Length < 2 || trimmed[0] != '@')
                {
                    continue;
                }

                // Extract the tag name: everything from '@' up to the first space or end of line.
                var spaceIdx = trimmed.IndexOf(' ');
                var tag = spaceIdx < 0 ? trimmed : trimmed.Substring(0, spaceIdx);

                if (!KnownTags.Contains(tag))
                {
                    diagnostics.ReportUnknownDocumentationTag(block.Location, tag);
                }
            }
        }
    }

    private static void ValidateParamMatches(ImmutableArray<FunctionSymbol> functions, DiagnosticBag diagnostics)
    {
        foreach (var function in functions)
        {
            if (function.Declaration is null)
            {
                continue;
            }

            var documentation = function.GetDocumentation();
            if (documentation is null)
            {
                continue;
            }

            var parameterNames = new HashSet<string>(function.Parameters.Select(p => p.Name), System.StringComparer.Ordinal);
            foreach (var parameter in documentation.Parameters)
            {
                if (!parameterNames.Contains(parameter.Name))
                {
                    diagnostics.ReportDocParamMismatch(function.Declaration.Location, parameter.Name, function.Name);
                }
            }

            var typeParameterNames = new HashSet<string>(function.TypeParameters.Select(tp => tp.Name), System.StringComparer.Ordinal);
            foreach (var typeParameter in documentation.TypeParameters)
            {
                if (!typeParameterNames.Contains(typeParameter.Name))
                {
                    diagnostics.ReportDocParamMismatch(function.Declaration.Location, typeParameter.Name, function.Name);
                }
            }
        }
    }

    private static void ValidateMissingDocs(
        ImmutableArray<FunctionSymbol> functions,
        ImmutableArray<StructSymbol> structs,
        DiagnosticBag diagnostics)
    {
        foreach (var function in functions)
        {
            if (function.Declaration is not null && function.Accessibility == Accessibility.Public && function.GetDocumentation() is null)
            {
                diagnostics.ReportMissingDocumentation(function.Declaration.Location, function.Name);
            }
        }

        foreach (var type in structs)
        {
            if (type.Declaration is not null && type.Accessibility == Accessibility.Public && type.GetDocumentation() is null)
            {
                diagnostics.ReportMissingDocumentation(type.Declaration.Location, type.Name);
            }

            ValidateMissingPropertyDocs(type.Properties, diagnostics);
            ValidateMissingPropertyDocs(type.StaticProperties, diagnostics);
        }
    }

    private static void ValidateMissingPropertyDocs(ImmutableArray<PropertySymbol> properties, DiagnosticBag diagnostics)
    {
        foreach (var property in properties)
        {
            if (property.Declaration is not null && property.Accessibility == Accessibility.Public && property.GetDocumentation() is null)
            {
                diagnostics.ReportMissingDocumentation(property.Declaration.Location, property.Name);
            }
        }
    }
}
