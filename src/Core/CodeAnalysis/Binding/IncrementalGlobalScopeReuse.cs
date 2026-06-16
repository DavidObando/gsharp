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
/// edit (package, imports, type aliases, fields, enum members, delegate
/// signatures, and every declaration signature are byte-identical; only the
/// statement blocks of body-bearing members differ), the new compilation reuses
/// the prior <see cref="BoundGlobalScope"/> wholesale. Every symbol instance
/// therefore survives the edit, which is exactly the identity the
/// <see cref="BoundBodyCache"/>'s soundness gate and the emitter (which keys
/// members by reference) require.
/// </para>
/// <para>
/// The edited file's reused symbols are <em>re-pointed</em> at the freshly
/// parsed syntax tree so that re-binding their bodies binds the new text and
/// reports diagnostics at the new spans, and so language-server navigation
/// resolves to current source. This covers every body-bearing member kind:
/// top-level functions, struct/class instance and static methods, interface
/// default / static-virtual / private helper methods
/// (<see cref="FunctionSymbol.RepointDeclaration"/>), constructors
/// (<see cref="ConstructorSymbol.RepointDeclaration"/>), destructors
/// (<see cref="DeinitSymbol.RepointDeclaration"/>), computed-property accessor
/// bodies (<see cref="PropertySymbol.RepointDeclaration"/>), and explicit event
/// accessor bodies (<see cref="EventSymbol.RepointDeclaration"/>). The owning
/// struct and interface type symbols are re-pointed too
/// (<see cref="StructSymbol.RepointDeclaration"/>,
/// <see cref="InterfaceSymbol.RepointDeclaration"/>). Re-binding of every
/// re-pointed body is forced by passing the edited tree as a <c>dirtyTree</c> to
/// <see cref="Binder.BindProgram(BoundGlobalScope, ReferenceResolver, BoundBodyCache, System.Collections.Immutable.ImmutableHashSet{SyntaxTree})"/>;
/// because each body's backing syntax now belongs to the dirty tree, the
/// per-body cache read is bypassed and the body binds fresh.
/// </para>
/// <para>
/// Structural identity is proven by a <em>skeleton diff</em>: blanking the body
/// blocks of <em>every</em> body-bearing member and requiring the remaining text
/// to be byte-identical guarantees that the only change is inside bodies and
/// that the set and order of every declaration is unchanged — so each reused
/// member can be re-pointed by positional mapping. Anything that is <em>not</em>
/// a member body — a field initializer, an auto-property, an enum member, a
/// delegate signature, any member signature, an import, a type alias, the
/// package clause — stays in the skeleton, so any change to it makes the
/// skeletons differ and forces a full rebuild (correctness-preserving
/// over-invalidation).
/// </para>
/// <para>
/// The single remaining outright bail is a file containing top-level statements
/// (the synthesized <c>&lt;Main&gt;$</c> entry-point body): that body is bound
/// from <see cref="BoundGlobalScope.Statements"/> rather than from a
/// member-declaration node, so it is not member-addressable for re-pointing.
/// Such a file falls back to a full rebuild.
/// </para>
/// </remarks>
public static class IncrementalGlobalScopeReuse
{
    private const string BodyPlaceholder = "\u0000\u0000GS_BODY\u0000\u0000";

    private enum EventAccessorKind
    {
        Add,
        Remove,
        Raise,
    }

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
        // re-point soundly (top-level statements only — see remarks). Reject on
        // either side.
        if (ContainsUnsupportedConstruct(previousTree) || ContainsUnsupportedConstruct(updatedTree))
        {
            return false;
        }

        // Blank out every body-bearing member body and require everything else —
        // package, imports, type aliases, every declaration signature, fields,
        // enum members, delegate signatures, struct/interface headers — to be
        // byte-identical. A signature edit, added/removed member, or any
        // non-body change makes the skeletons differ.
        var previousSkeleton = BuildSkeleton(previousText, CollectBodySpans(previousTree));
        var updatedSkeleton = BuildSkeleton(updatedText, CollectBodySpans(updatedTree));
        if (previousSkeleton == null || updatedSkeleton == null)
        {
            return false;
        }

        if (!string.Equals(previousSkeleton, updatedSkeleton, System.StringComparison.Ordinal))
        {
            return false;
        }

        // Skeleton equality guarantees identical structure, hence identical
        // per-kind declaration counts and ordering. Build a positional map for
        // each declaration kind; defensively assert matching counts.
        if (!TryBuildPositionalMap<FunctionDeclarationSyntax>(previousTree, updatedTree, out var functionMap)
            || !TryBuildPositionalMap<StructDeclarationSyntax>(previousTree, updatedTree, out var structMap)
            || !TryBuildPositionalMap<InterfaceDeclarationSyntax>(previousTree, updatedTree, out var interfaceMap)
            || !TryBuildPositionalMap<ConstructorDeclarationSyntax>(previousTree, updatedTree, out var constructorMap)
            || !TryBuildPositionalMap<DeinitDeclarationSyntax>(previousTree, updatedTree, out var deinitMap)
            || !TryBuildPositionalMap<PropertyDeclarationSyntax>(previousTree, updatedTree, out var propertyMap)
            || !TryBuildPositionalMap<EventDeclarationSyntax>(previousTree, updatedTree, out var eventMap))
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

        // ---- Phase 1: gather every reused member whose backing syntax belongs
        // to the edited file, validating that each maps to a positional
        // counterpart. Nothing is mutated yet; on any unmapped member we bail.
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

        var interfacesToRepoint = new List<(InterfaceSymbol Symbol, InterfaceDeclarationSyntax Updated)>();
        foreach (var interfaceSymbol in scope.Interfaces)
        {
            var declaration = interfaceSymbol.Declaration;
            if (declaration == null || declaration.SyntaxTree != previousTree)
            {
                continue;
            }

            if (!interfaceMap.TryGetValue(declaration, out var updated))
            {
                return false;
            }

            interfacesToRepoint.Add((interfaceSymbol, updated));
        }

        var constructorsToRepoint = new List<(ConstructorSymbol Symbol, ConstructorDeclarationSyntax Updated)>();
        var deinitsToRepoint = new List<(DeinitSymbol Symbol, DeinitDeclarationSyntax Updated)>();
        var propertiesToRepoint = new List<(PropertySymbol Symbol, PropertyDeclarationSyntax Updated, BlockStatementSyntax Getter, BlockStatementSyntax Setter)>();
        var eventsToRepoint = new List<(EventSymbol Symbol, EventDeclarationSyntax Updated, BlockStatementSyntax Add, BlockStatementSyntax Remove, BlockStatementSyntax Raise)>();

        foreach (var structSymbol in scope.Structs)
        {
            // Constructors (ADR-0063 §9). Synthesized primary constructors carry
            // no declaration node and have no rebindable body — skip them.
            if (!structSymbol.ExplicitConstructors.IsDefaultOrEmpty)
            {
                foreach (var ctor in structSymbol.ExplicitConstructors)
                {
                    var declaration = ctor.Declaration;
                    if (declaration == null || declaration.SyntaxTree != previousTree)
                    {
                        continue;
                    }

                    if (!constructorMap.TryGetValue(declaration, out var updated))
                    {
                        return false;
                    }

                    constructorsToRepoint.Add((ctor, updated));
                }
            }

            // Destructor (ADR-0068 / issue #698).
            var deinit = structSymbol.Deinitializer;
            if (deinit?.Declaration != null && deinit.Declaration.SyntaxTree == previousTree)
            {
                if (!deinitMap.TryGetValue(deinit.Declaration, out var updated))
                {
                    return false;
                }

                deinitsToRepoint.Add((deinit, updated));
            }

            // Computed-property accessor bodies (ADR-0051), instance + static.
            foreach (var prop in EnumerateProperties(structSymbol))
            {
                var declaration = prop.Declaration;
                if (declaration == null || declaration.SyntaxTree != previousTree)
                {
                    continue;
                }

                if (!propertyMap.TryGetValue(declaration, out var updated))
                {
                    return false;
                }

                var newGetter = GetAccessorBody(updated, isGetter: true);
                var newSetter = GetAccessorBody(updated, isGetter: false);

                // The accessor shape must match (skeleton equality guarantees
                // it); refuse rather than risk dropping or inventing a body.
                if ((prop.GetterBodySyntax != null) != (newGetter != null)
                    || (prop.SetterBodySyntax != null) != (newSetter != null))
                {
                    return false;
                }

                propertiesToRepoint.Add((prop, updated, newGetter, newSetter));
            }

            // Explicit event accessor bodies (ADR-0052 / issue #257), instance + static.
            foreach (var ev in EnumerateEvents(structSymbol))
            {
                var declaration = ev.Declaration;
                if (declaration == null || declaration.SyntaxTree != previousTree)
                {
                    continue;
                }

                if (!eventMap.TryGetValue(declaration, out var updated))
                {
                    return false;
                }

                var newAdd = GetEventAccessorBody(updated, EventAccessorKind.Add);
                var newRemove = GetEventAccessorBody(updated, EventAccessorKind.Remove);
                var newRaise = GetEventAccessorBody(updated, EventAccessorKind.Raise);

                if ((ev.AddBodySyntax != null) != (newAdd != null)
                    || (ev.RemoveBodySyntax != null) != (newRemove != null)
                    || (ev.RaiseBodySyntax != null) != (newRaise != null))
                {
                    return false;
                }

                eventsToRepoint.Add((ev, updated, newAdd, newRemove, newRaise));
            }
        }

        // ---- Phase 2: all validation passed — apply the re-point. This is the
        // only mutation, and it only swaps backing syntax (signatures and
        // accessor shapes are byte-identical).
        foreach (var (symbol, updated) in functionsToRepoint)
        {
            symbol.RepointDeclaration(updated);
        }

        foreach (var (symbol, updated) in structsToRepoint)
        {
            symbol.RepointDeclaration(updated);
        }

        foreach (var (symbol, updated) in interfacesToRepoint)
        {
            symbol.RepointDeclaration(updated);
        }

        foreach (var (symbol, updated) in constructorsToRepoint)
        {
            symbol.RepointDeclaration(updated);
        }

        foreach (var (symbol, updated) in deinitsToRepoint)
        {
            symbol.RepointDeclaration(updated);
        }

        foreach (var (symbol, updated, getter, setter) in propertiesToRepoint)
        {
            symbol.RepointDeclaration(updated);
            symbol.GetterBodySyntax = getter;
            symbol.SetterBodySyntax = setter;
        }

        foreach (var (symbol, updated, add, remove, raise) in eventsToRepoint)
        {
            symbol.RepointDeclaration(updated);
            symbol.AddBodySyntax = add;
            symbol.RemoveBodySyntax = remove;
            symbol.RaiseBodySyntax = raise;
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

        // Interface default / static-virtual / private helper methods carry
        // FunctionDeclarationSyntax declarations and rebindable bodies.
        foreach (var interfaceSymbol in scope.Interfaces)
        {
            foreach (var method in EnumerateInterfaceMethods(interfaceSymbol))
            {
                yield return method;
            }
        }
    }

    private static IEnumerable<FunctionSymbol> EnumerateInterfaceMethods(InterfaceSymbol interfaceSymbol)
    {
        if (!interfaceSymbol.Methods.IsDefaultOrEmpty)
        {
            foreach (var method in interfaceSymbol.Methods)
            {
                yield return method;
            }
        }

        if (!interfaceSymbol.StaticMethods.IsDefaultOrEmpty)
        {
            foreach (var method in interfaceSymbol.StaticMethods)
            {
                yield return method;
            }
        }

        if (!interfaceSymbol.PrivateMethods.IsDefaultOrEmpty)
        {
            foreach (var method in interfaceSymbol.PrivateMethods)
            {
                yield return method;
            }
        }

        if (!interfaceSymbol.StaticPrivateMethods.IsDefaultOrEmpty)
        {
            foreach (var method in interfaceSymbol.StaticPrivateMethods)
            {
                yield return method;
            }
        }
    }

    private static IEnumerable<PropertySymbol> EnumerateProperties(StructSymbol structSymbol)
    {
        if (!structSymbol.Properties.IsDefaultOrEmpty)
        {
            foreach (var prop in structSymbol.Properties)
            {
                yield return prop;
            }
        }

        if (!structSymbol.StaticProperties.IsDefaultOrEmpty)
        {
            foreach (var prop in structSymbol.StaticProperties)
            {
                yield return prop;
            }
        }
    }

    private static IEnumerable<EventSymbol> EnumerateEvents(StructSymbol structSymbol)
    {
        if (!structSymbol.Events.IsDefaultOrEmpty)
        {
            foreach (var ev in structSymbol.Events)
            {
                yield return ev;
            }
        }

        if (!structSymbol.StaticEvents.IsDefaultOrEmpty)
        {
            foreach (var ev in structSymbol.StaticEvents)
            {
                yield return ev;
            }
        }
    }

    private static bool ContainsUnsupportedConstruct(SyntaxTree tree)
    {
        foreach (var node in Descendants(tree.Root))
        {
            // Top-level statements feed the synthesized <Main>$ entry-point body,
            // which is bound from BoundGlobalScope.Statements rather than from a
            // member-declaration node — so it cannot be re-pointed. Bail.
            if (node is GlobalStatementSyntax)
            {
                return true;
            }
        }

        return false;
    }

    private static bool TryBuildPositionalMap<TNode>(
        SyntaxTree previousTree,
        SyntaxTree updatedTree,
        out Dictionary<TNode, TNode> map)
        where TNode : SyntaxNode
    {
        var previous = CollectDeclarations<TNode>(previousTree);
        var updated = CollectDeclarations<TNode>(updatedTree);
        if (previous.Count != updated.Count)
        {
            map = null;
            return false;
        }

        map = new Dictionary<TNode, TNode>(previous.Count);
        for (var i = 0; i < previous.Count; i++)
        {
            map[previous[i]] = updated[i];
        }

        return true;
    }

    private static List<TNode> CollectDeclarations<TNode>(SyntaxTree tree)
        where TNode : SyntaxNode
    {
        return Descendants(tree.Root)
            .OfType<TNode>()
            .OrderBy(d => d.Span.Start)
            .ToList();
    }

    /// <summary>
    /// Collects, in ascending span order, the source spans of every body-bearing
    /// member body in the file: function/method bodies (top-level, struct,
    /// interface), constructor and destructor bodies, computed-property accessor
    /// bodies and explicit event accessor bodies. Bodies nested inside another
    /// collected body (e.g. a local function) are naturally subsumed by the
    /// outer span and skipped by <see cref="BuildSkeleton"/>.
    /// </summary>
    private static List<TextSpan> CollectBodySpans(SyntaxTree tree)
    {
        var spans = new List<TextSpan>();
        foreach (var node in Descendants(tree.Root))
        {
            switch (node)
            {
                case FunctionDeclarationSyntax function when function.Body != null:
                    spans.Add(function.Body.Span);
                    break;
                case ConstructorDeclarationSyntax ctor when ctor.Body != null:
                    spans.Add(ctor.Body.Span);
                    break;
                case DeinitDeclarationSyntax deinit when deinit.Body != null:
                    spans.Add(deinit.Body.Span);
                    break;
                case PropertyAccessorSyntax propAccessor when propAccessor.Body != null:
                    spans.Add(propAccessor.Body.Span);
                    break;
                case EventAccessorSyntax eventAccessor when eventAccessor.Body != null:
                    spans.Add(eventAccessor.Body.Span);
                    break;
            }
        }

        spans.Sort((a, b) => a.Start.CompareTo(b.Start));
        return spans;
    }

    private static string BuildSkeleton(SourceText text, List<TextSpan> bodySpans)
    {
        var builder = new StringBuilder();
        var position = 0;
        foreach (var span in bodySpans)
        {
            // A body whose start lies within the already-consumed prefix is
            // nested inside an outer body that has already been blanked — skip
            // it (its text is part of the placeholder for the enclosing body).
            if (span.Start < position)
            {
                continue;
            }

            builder.Append(text.ToString(TextSpan.FromBounds(position, span.Start)));
            builder.Append(BodyPlaceholder);
            position = span.End;
        }

        builder.Append(text.ToString(TextSpan.FromBounds(position, text.Length)));
        return builder.ToString();
    }

    private static BlockStatementSyntax GetAccessorBody(PropertyDeclarationSyntax property, bool isGetter)
    {
        foreach (var accessor in property.Accessors)
        {
            if (isGetter ? accessor.IsGetter : accessor.IsSetter)
            {
                return accessor.Body;
            }
        }

        return null;
    }

    private static BlockStatementSyntax GetEventAccessorBody(EventDeclarationSyntax eventDeclaration, EventAccessorKind kind)
    {
        foreach (var accessor in eventDeclaration.Accessors)
        {
            var matches = kind switch
            {
                EventAccessorKind.Add => accessor.IsAdd,
                EventAccessorKind.Remove => accessor.IsRemove,
                EventAccessorKind.Raise => accessor.IsRaise,
                _ => false,
            };

            if (matches)
            {
                return accessor.Body;
            }
        }

        return null;
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
