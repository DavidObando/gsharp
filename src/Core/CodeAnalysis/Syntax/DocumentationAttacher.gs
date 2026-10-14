// <copyright file="DocumentationAttacher.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable

/// Implements the position-based documentation attachment pass (ADR-0057 §7).
/// Groups consecutive (cref:SyntaxKind.DocumentationCommentToken)s into blocks
/// by line-adjacency, then attaches each block to the nearest documentable declaration
/// whose start follows immediately after.
internal shared class DocumentationAttacher {
    internal struct DocBlock {
        init(firstLine int32, lastLine int32, endPosition int32, location TextLocation, text string) {
            FirstLine = firstLine
            LastLine = lastLine
            EndPosition = endPosition
            Location = location
            Text = text
        }

        prop FirstLine int32 {
            get;
        }

        prop LastLine int32 {
            get;
        }

        prop EndPosition int32 {
            get;
        }

        prop Location TextLocation {
            get;
        }

        prop Text string {
            get;
        }
    }

    /// Runs the attachment algorithm over a parsed syntax tree, returning a table
    /// that maps declaration nodes to their joined documentation block text.
    /// @param tree The fully-parsed syntax tree.
    /// @returns A dictionary from declaration node to documentation text.
    internal func Attach(tree SyntaxTree) Dictionary[SyntaxNode, string] {
        let result = Dictionary[SyntaxNode, string]()
        let blocks = GetBlocks(tree)
        if blocks.IsDefaultOrEmpty {
            return result
        }
        let sourceText = tree.Text
        // Collect all documentable declarations sorted by source position.
        let declarations = GetDocumentableDeclarations(tree)
        var declIndex = 0
        for block in blocks {
            // Advance past declarations that start before the block end.
            while declIndex < declarations.Count && declarations[declIndex].Span.Start < block.EndPosition {
                declIndex++
            }
            if declIndex >= declarations.Count {
                break
            }
            let candidate = declarations[declIndex]
            // The declaration must start on the line immediately following the block's last line.
            let candidateLine = sourceText.GetLineIndex(candidate.Span.Start)
            if candidateLine == block.LastLine + 1 {
                result[candidate] = block.Text
            }
        }
        return result
    }

    internal func GetBlocks(tree SyntaxTree) ImmutableArray[DocBlock] {
        let docTokens = tree.DocumentationTokens
        if docTokens.IsDefaultOrEmpty {
            return ImmutableArray[DocBlock].Empty
        }
        return GroupIntoBlocks(docTokens, tree.Text).ToImmutableArray()
    }

    internal func GetDocumentableDeclarations(tree SyntaxTree) List[SyntaxNode] {
        let declarations = CollectDocumentableDeclarations(tree.Root)
        declarations.Sort((a SyntaxNode, b SyntaxNode) -> a.Span.Start.CompareTo(b.Span.Start))
        return declarations
    }

    private func GroupIntoBlocks(docTokens ImmutableArray[SyntaxToken], sourceText SourceText) List[DocBlock] {
        let blocks = List[DocBlock]()
        let currentLines = List[string]()
        var currentFirstLine = -1
        var currentLastLine = -1
        var currentEndPosition = 0
        var currentLocation = default(TextLocation)
        for token in docTokens {
            let tokenLine = sourceText.GetLineIndex(token.Span.Start)
            if currentLines.Count > 0 && tokenLine != currentLastLine + 1 {
                // Gap: finalize current block.
                blocks.Add(
                    DocBlock(
                        currentFirstLine,
                        currentLastLine,
                        currentEndPosition,
                        currentLocation,
                        JoinBlock(currentLines)
                    )
                )
                currentLines.Clear()
            }
            if currentLines.Count == 0 {
                currentFirstLine = tokenLine
                currentLocation = token.Location
            }
            currentLastLine = tokenLine
            currentEndPosition = token.Span.End
            currentLines.Add(cast[string?](token.Value) ?? string.Empty)
        }
        if currentLines.Count > 0 {
            blocks.Add(
                DocBlock(
                    currentFirstLine,
                    currentLastLine,
                    currentEndPosition,
                    currentLocation,
                    JoinBlock(currentLines)
                )
            )
        }
        return blocks
    }

    private func JoinBlock(lines List[string]) string {
        return string.Join("\n", lines)
    }

    private func CollectDocumentableDeclarations(root CompilationUnitSyntax) List[SyntaxNode] {
        let result = List[SyntaxNode]()
        for member in root.Members {
            // Named delegates are top-level-only. Keep their attachment path
            // outside nested aggregate traversal until syntax and binding
            // support nested delegate declarations.
            if member is DelegateDeclarationSyntax delegate {
                result.Add(delegate)
                continue
            }
            CollectFromMember(member, result)
        }
        return result
    }

    private func CollectFromMember(node SyntaxNode, result List[SyntaxNode]) {
        switch node {
            case pkg is PackageSyntax {
                result.Add(pkg)
            }
            case imp is ImportSyntax {
                result.Add(imp)
            }
            case func_ is FunctionDeclarationSyntax {
                result.Add(func_)
            }
            case ctor is ConstructorDeclarationSyntax {
                result.Add(ctor)
            }
            case alias is TypeAliasDeclarationSyntax {
                result.Add(alias)
            }
            case structDecl is StructDeclarationSyntax {
                result.Add(structDecl)
                CollectFromStructBody(structDecl, result)
            }
            case enumDecl is EnumDeclarationSyntax {
                result.Add(enumDecl)
                CollectFromEnumBody(enumDecl, result)
            }
            case ifaceDecl is InterfaceDeclarationSyntax {
                result.Add(ifaceDecl)
                CollectFromInterfaceBody(ifaceDecl, result)
            }
            case global is GlobalStatementSyntax {
                // Top-level variable declarations are documentable.
                if global.Statement is VariableDeclarationSyntax {
                    result.Add(global)
                }
            }
        }
    }

    private func CollectFromStructBody(structDecl StructDeclarationSyntax, result List[SyntaxNode]) {
        for field in structDecl.Fields {
            result.Add(field)
        }
        for prop in structDecl.Properties {
            result.Add(prop)
        }
        for evt in structDecl.Events {
            result.Add(evt)
        }
        for method in structDecl.Methods {
            result.Add(method)
        }
        if !structDecl.Constructors.IsDefaultOrEmpty {
            for ctor in structDecl.Constructors {
                result.Add(ctor)
            }
        }
        // A `deinit` block is a member declaration in its own right (the CLR
        // finalizer), so a `///` block above it attaches to it rather than
        // floating (GS0227).
        if structDecl.Deinitializer != nil {
            result.Add(structDecl.Deinitializer!!)
        }
        // ADR-0053: members declared inside a `shared { … }` block are still
        // documentable. The block itself is not a documentable declaration,
        // but each contained field/property/event/method is.
        if structDecl.SharedBlock != nil {
            for field in structDecl.SharedBlock!!.Fields {
                result.Add(field)
            }
            for prop in structDecl.SharedBlock!!.Properties {
                result.Add(prop)
            }
            for evt in structDecl.SharedBlock!!.Events {
                result.Add(evt)
            }
            for method in structDecl.SharedBlock!!.Methods {
                result.Add(method)
            }
        }
        for nestedType in structDecl.NestedTypes {
            CollectFromMember(nestedType, result)
        }
    }

    private func CollectFromEnumBody(enumDecl EnumDeclarationSyntax, result List[SyntaxNode]) {
        for member in enumDecl.Members {
            result.Add(member)
        }
    }

    private func CollectFromInterfaceBody(interfaceDecl InterfaceDeclarationSyntax, result List[SyntaxNode]) {
        for prop in interfaceDecl.Properties {
            result.Add(prop)
        }
        for evt in interfaceDecl.Events {
            result.Add(evt)
        }
        for method in interfaceDecl.Methods {
            result.Add(method)
        }
        for field in interfaceDecl.StaticFields {
            result.Add(field)
        }
    }
}
