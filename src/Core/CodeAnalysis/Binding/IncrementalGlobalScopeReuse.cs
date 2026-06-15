// <copyright file="IncrementalGlobalScopeReuse.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using System.Text;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0105 Phase 2 — establishes <em>stable symbol identity</em> across a
/// language-server edit so a body-only change to a single file re-binds only
/// that file's member bodies while every unchanged file's bodies are served
/// from the <see cref="BoundBodyCache"/>.
/// </summary>
/// <remarks>
/// <para>
/// The reuse vehicle is the previous compilation's <see cref="BoundGlobalScope"/>
/// itself: when exactly one file changed and that change is a <em>body-only</em>
/// edit (package, imports, type aliases, and every declaration signature are
/// byte-identical; only plain <c>func</c>/method block bodies differ), the new
/// compilation reuses the prior <see cref="BoundGlobalScope"/> wholesale. Every
/// symbol instance therefore survives the edit, which is exactly the identity
/// the <see cref="BoundBodyCache"/>'s soundness gate and the emitter (which keys
/// members by reference) require.
/// </para>
/// <para>
/// The edited file's reused symbols are <em>re-pointed</em> at the freshly
/// parsed syntax tree (<see cref="FunctionSymbol.RepointDeclaration"/>,
/// <see cref="StructSymbol.RepointDeclaration"/>) so that re-binding their
/// bodies binds the new text and reports diagnostics at the new spans, and so
/// language-server navigation resolves to current source. Re-binding of those
/// bodies is forced by passing the edited tree as a <c>dirtyTree</c> to
/// <see cref="Binder.BindProgram(BoundGlobalScope, ReferenceResolver, BoundBodyCache, System.Collections.Immutable.ImmutableHashSet{SyntaxTree})"/>.
/// </para>
/// <para>
/// This phase deliberately supports only the dominant editing shape — plain
/// top-level functions and struct/class instance/static methods. Any file
/// containing constructors, destructors, computed properties, explicit events,
/// interfaces, enums, delegates, or top-level statements falls back to a full
/// rebuild (over-invalidation is always safe; under-invalidation would be a
/// correctness bug). Broadening the supported member surface and adding cache
/// eviction are tracked as Phase 3 follow-ups.
/// </para>
/// </remarks>
public static class IncrementalGlobalScopeReuse
{
    private const string BodyPlaceholder = "\u0000\u0000GS_BODY\u0000\u0000";

    /// <summary>
    /// Attempts to turn <paramref name="scope"/> (the previous compilation's
    /// global scope) into the global scope for an edit that replaced
    /// <paramref name="previousTree"/> with <paramref name="updatedTree"/>,
    /// when that edit is a supported body-only change. On success the edited
    /// file's reused symbols are re-pointed at <paramref name="updatedTree"/>
    /// and the method returns <see langword="true"/>; the caller then builds a
    /// new compilation that reuses <paramref name="scope"/> and marks
    /// <paramref name="updatedTree"/> dirty. On any failure the method returns
    /// <see langword="false"/> <em>without mutating anything</em>, and the
    /// caller must perform a full rebuild.
    /// </summary>
    /// <param name="scope">The previous compilation's bound global scope.</param>
    /// <param name="previousTree">The file's syntax tree before the edit.</param>
    /// <param name="updatedTree">The file's freshly parsed syntax tree after the edit.</param>
    /// <returns><see langword="true"/> when the edit was a supported body-only change and reuse was applied.</returns>
    public static bool TryRepointBodyOnlyEdit(BoundGlobalScope scope, SyntaxTree previousTree, SyntaxTree updatedTree)
    {
        if (scope == null || previousTree == null || updatedTree == null)
        {
            return false;
        }

        // Chained (REPL) scopes are not produced by the language server; reuse
        // only the single-link shape the LSP builds.
        if (scope.Previous != null)
        {
            return false;
        }

        var previousText = previousTree.Text;
        var updatedText = updatedTree.Text;
        if (previousText == null || updatedText == null)
        {
            return false;
        }

        // The edited file must not contain any construct this phase cannot
        // re-point soundly (see remarks). Reject on either side.
        if (ContainsUnsupportedConstruct(previousTree) || ContainsUnsupportedConstruct(updatedTree))
        {
            return false;
        }

        var previousFunctions = CollectFunctionDeclarations(previousTree);
        var updatedFunctions = CollectFunctionDeclarations(updatedTree);

        // Blank out plain function/method bodies and require everything else —
        // package, imports, type aliases, every declaration signature, fields,
        // struct headers — to be byte-identical. A signature edit, added or
        // removed member, or any non-body change makes the skeletons differ.
        var previousSkeleton = BuildSkeleton(previousText, previousFunctions);
        var updatedSkeleton = BuildSkeleton(updatedText, updatedFunctions);
        if (!string.Equals(previousSkeleton, updatedSkeleton, System.StringComparison.Ordinal))
        {
            return false;
        }

        // Skeleton equality guarantees identical structure, hence identical
        // function/struct counts and ordering; assert defensively.
        if (previousFunctions.Count != updatedFunctions.Count)
        {
            return false;
        }

        var previousStructs = CollectStructDeclarations(previousTree);
        var updatedStructs = CollectStructDeclarations(updatedTree);
        if (previousStructs.Count != updatedStructs.Count)
        {
            return false;
        }

        // Reusing the prior scope keeps the prior (signature-level) diagnostics
        // verbatim. For unchanged files their spans are still correct, but the
        // edited file's spans may have shifted — so refuse the fast path when
        // the edited file contributed any global-scope diagnostic, to keep
        // diagnostics bit-for-bit identical to a full rebuild.
        var editedFile = previousText.FileName;
        if (!string.IsNullOrEmpty(editedFile))
        {
            foreach (var diagnostic in scope.Diagnostics)
            {
                if (string.Equals(diagnostic.Location.Text?.FileName, editedFile, System.StringComparison.Ordinal))
                {
                    return false;
                }
            }
        }

        // Map each previous declaration node to its positional counterpart in
        // the re-parsed tree.
        var functionMap = new Dictionary<FunctionDeclarationSyntax, FunctionDeclarationSyntax>(previousFunctions.Count);
        for (var i = 0; i < previousFunctions.Count; i++)
        {
            functionMap[previousFunctions[i]] = updatedFunctions[i];
        }

        var structMap = new Dictionary<StructDeclarationSyntax, StructDeclarationSyntax>(previousStructs.Count);
        for (var i = 0; i < previousStructs.Count; i++)
        {
            structMap[previousStructs[i]] = updatedStructs[i];
        }

        // Gather the reused symbols that belong to the edited file. Every one
        // must have a mapped replacement node; otherwise the structural
        // assumptions do not hold and we fall back rather than risk a stale
        // re-point.
        var functionsToRepoint = new List<(FunctionSymbol Symbol, FunctionDeclarationSyntax Updated)>();
        foreach (var function in EnumerateFunctionSymbols(scope))
        {
            var declaration = function.Declaration;
            if (declaration == null || declaration.SyntaxTree != previousTree)
            {
                continue;
            }

            if (!functionMap.TryGetValue(declaration, out var updated))
            {
                return false;
            }

            functionsToRepoint.Add((function, updated));
        }

        var structsToRepoint = new List<(StructSymbol Symbol, StructDeclarationSyntax Updated)>();
        foreach (var structSymbol in scope.Structs)
        {
            var declaration = structSymbol.Declaration;
            if (declaration == null || declaration.SyntaxTree != previousTree)
            {
                continue;
            }

            if (!structMap.TryGetValue(declaration, out var updated))
            {
                return false;
            }

            structsToRepoint.Add((structSymbol, updated));
        }

        // All validation passed — apply the re-point. This is the only
        // mutation, and it only swaps backing syntax (signature byte-identical).
        foreach (var (symbol, updated) in functionsToRepoint)
        {
            symbol.RepointDeclaration(updated);
        }

        foreach (var (symbol, updated) in structsToRepoint)
        {
            symbol.RepointDeclaration(updated);
        }

        return true;
    }

    private static IEnumerable<FunctionSymbol> EnumerateFunctionSymbols(BoundGlobalScope scope)
    {
        foreach (var function in scope.Functions)
        {
            yield return function;
        }

        foreach (var structSymbol in scope.Structs)
        {
            if (!structSymbol.Methods.IsDefaultOrEmpty)
            {
                foreach (var method in structSymbol.Methods)
                {
                    yield return method;
                }
            }

            if (!structSymbol.StaticMethods.IsDefaultOrEmpty)
            {
                foreach (var method in structSymbol.StaticMethods)
                {
                    yield return method;
                }
            }
        }
    }

    private static bool ContainsUnsupportedConstruct(SyntaxTree tree)
    {
        foreach (var node in Descendants(tree.Root))
        {
            switch (node)
            {
                case ConstructorDeclarationSyntax:
                case DeinitDeclarationSyntax:
                case InterfaceDeclarationSyntax:
                case EnumDeclarationSyntax:
                case DelegateDeclarationSyntax:
                case GlobalStatementSyntax:
                case EventDeclarationSyntax:
                    return true;
                case PropertyDeclarationSyntax property:
                    // Auto-properties (no accessor body) are fine; a computed
                    // property carries a rebindable accessor body this phase
                    // does not re-point, so fall back.
                    if (property.Accessors.Any(a => a.Body != null))
                    {
                        return true;
                    }

                    break;
            }
        }

        return false;
    }

    private static List<FunctionDeclarationSyntax> CollectFunctionDeclarations(SyntaxTree tree)
    {
        return Descendants(tree.Root)
            .OfType<FunctionDeclarationSyntax>()
            .OrderBy(d => d.Span.Start)
            .ToList();
    }

    private static List<StructDeclarationSyntax> CollectStructDeclarations(SyntaxTree tree)
    {
        return Descendants(tree.Root)
            .OfType<StructDeclarationSyntax>()
            .OrderBy(d => d.Span.Start)
            .ToList();
    }

    private static string BuildSkeleton(SourceText text, List<FunctionDeclarationSyntax> functions)
    {
        var builder = new StringBuilder();
        var position = 0;
        foreach (var function in functions)
        {
            var body = function.Body;
            if (body == null)
            {
                continue;
            }

            var span = body.Span;
            if (span.Start < position)
            {
                // Defensive: function bodies never nest, so spans should be
                // disjoint and ascending. If they are not, give up.
                return null;
            }

            builder.Append(text.ToString(TextSpan.FromBounds(position, span.Start)));
            builder.Append(BodyPlaceholder);
            position = span.End;
        }

        builder.Append(text.ToString(TextSpan.FromBounds(position, text.Length)));
        return builder.ToString();
    }

    private static IEnumerable<SyntaxNode> Descendants(SyntaxNode root)
    {
        var stack = new Stack<SyntaxNode>();
        stack.Push(root);
        while (stack.Count > 0)
        {
            var node = stack.Pop();
            yield return node;
            foreach (var child in node.GetChildren())
            {
                if (child != null)
                {
                    stack.Push(child);
                }
            }
        }
    }
}
