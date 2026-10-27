// <copyright file="IncrementalGlobalScopeReuse.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System.Collections.Generic
import System.Linq
import System.Text
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis
import System

/// ADR-0105 Phase 2 — establishes <em>stable symbol identity</em> across a
/// language-server edit so a body-only change to a single file re-binds only
/// that file's member bodies while every unchanged file's bodies are served
/// from the (cref:BoundBodyCache).
/// @remarks The reuse vehicle is the previous compilation's (cref:BoundGlobalScope)
/// itself: when exactly one file changed and that change is a <em>body-only</em>
/// edit (package, imports, type aliases, fields, enum members, delegate
/// signatures, and every declaration signature are byte-identical; only the
/// statement blocks of body-bearing members differ), the new compilation reuses
/// the prior (cref:BoundGlobalScope) wholesale. Every symbol instance
/// therefore survives the edit, which is exactly the identity the
/// (cref:BoundBodyCache)'s soundness gate and the emitter (which keys
/// members by reference) require.
///
/// The edited file's reused symbols are <em>re-pointed</em> at the freshly
/// parsed syntax tree so that re-binding their bodies binds the new text and
/// reports diagnostics at the new spans, and so language-server navigation
/// resolves to current source. This covers every body-bearing member kind:
/// top-level functions, struct/class instance and static methods, interface
/// default / static-virtual / private helper methods
/// ((cref:FunctionSymbol.RepointDeclaration)), constructors
/// ((cref:ConstructorSymbol.RepointDeclaration)), destructors
/// ((cref:DeinitSymbol.RepointDeclaration)), computed-property accessor
/// bodies ((cref:PropertySymbol.RepointDeclaration)), and explicit event
/// accessor bodies ((cref:EventSymbol.RepointDeclaration)). The owning
/// struct and interface type symbols are re-pointed too
/// ((cref:StructSymbol.RepointDeclaration),
/// (cref:InterfaceSymbol.RepointDeclaration)), as are source field
/// declarations ((cref:FieldSymbol.RepointDeclaration)), enums
/// ((cref:EnumSymbol.RepointDeclaration)), and delegates
/// ((cref:DelegateTypeSymbol.RepointDeclaration)). Re-binding of every
/// re-pointed body is forced by passing the edited tree as a `dirtyTree` to
/// (cref:Binder.BindProgram(BoundGlobalScope, ReferenceResolver, BoundBodyCache,
/// System.Collections.Immutable.ImmutableHashSet{SyntaxTree}));
/// because each body's backing syntax now belongs to the dirty tree, the
/// per-body cache read is bypassed and the body binds fresh.
/// Explicit imports and aliases are also re-pointed, so the binder's per-file
/// import filter sees the edited tree ((cref:ImportSymbol.RepointDeclaration)).
///
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
///
/// The single remaining outright bail is a file containing top-level statements
/// (the synthesized `<Main>$` entry-point body): that body is bound
/// from (cref:BoundGlobalScope.Statements) rather than from a
/// member-declaration node, so it is not member-addressable for re-pointing.
/// Such a file falls back to a full rebuild.
internal shared class IncrementalGlobalScopeReuse {
    private enum EventAccessorKind {
        Add,
        Remove,
        Raise
    }
    private const BodyPlaceholder string = "\u0000\u0000GS_BODY\u0000\u0000"

    /// Attempts to turn [`scope`](paramref) (the previous compilation's
    /// global scope) into the global scope for an edit that replaced
    /// [`previousTree`](paramref) with [`updatedTree`](paramref),
    /// when that edit is a supported body-only change. On success the edited
    /// file's reused symbols are re-pointed at [`updatedTree`](paramref)
    /// and the method returns `true`; the caller then builds a
    /// new compilation that reuses [`scope`](paramref) and marks
    /// [`updatedTree`](paramref) dirty. On any failure the method returns
    /// `false` <em>without mutating anything</em>, and the
    /// caller must perform a full rebuild.
    /// @param scope The previous compilation's bound global scope.
    /// @param previousTree The file's syntax tree before the edit.
    /// @param updatedTree The file's freshly parsed syntax tree after the edit.
    /// @returns `true` when the edit was a supported body-only change and reuse was applied.
    func TryRepointBodyOnlyEdit($scope BoundGlobalScope?, previousTree SyntaxTree?, updatedTree SyntaxTree?) bool {
        if $scope == nil || previousTree == nil || updatedTree == nil {
            return false
        }
        // Chained (REPL) scopes are not produced by the language server; reuse
        // only the single-link shape the LSP builds.
        if $scope.Previous != nil || $scope.HasNativeProtocols {
            return false
        }
        let previousText SourceText? = previousTree.Text
        let updatedText SourceText? = updatedTree.Text
        if previousText == nil || updatedText == nil {
            return false
        }
        // The edited file must not contain any construct this phase cannot
        // re-point soundly (top-level statements only — see remarks). Reject on
        // either side.
        if ContainsUnsupportedConstruct(previousTree) || ContainsUnsupportedConstruct(updatedTree) {
            return false
        }
        // Blank out every body-bearing member body and require everything else —
        // package, imports, type aliases, every declaration signature, fields,
        // enum members, delegate signatures, struct/interface headers — to be
        // byte-identical. A signature edit, added/removed member, or any
        // non-body change makes the skeletons differ.
        let previousSkeleton string? = BuildSkeleton(previousText, CollectBodySpans(previousTree))
        let updatedSkeleton string? = BuildSkeleton(updatedText, CollectBodySpans(updatedTree))
        if previousSkeleton == nil || updatedSkeleton == nil {
            return false
        }
        if !string.Equals(previousSkeleton, updatedSkeleton, StringComparison.Ordinal) {
            return false
        }
        // Skeleton equality guarantees identical structure, hence identical
        // per-kind declaration counts and ordering. Build a positional map for
        // each declaration kind; defensively assert matching counts.
        if !TryBuildPositionalMap[ImportSyntax](previousTree, updatedTree, out var importMap) ||
            !TryBuildPositionalMap[FunctionDeclarationSyntax](previousTree, updatedTree, out var functionMap) ||
            !TryBuildPositionalMap[StructDeclarationSyntax](previousTree, updatedTree, out var structMap) ||
            !TryBuildPositionalMap[InterfaceDeclarationSyntax](previousTree, updatedTree, out var interfaceMap) ||
            !TryBuildPositionalMap[ConstructorDeclarationSyntax](previousTree, updatedTree, out var constructorMap) ||
            !TryBuildPositionalMap[DeinitDeclarationSyntax](previousTree, updatedTree, out var deinitMap) ||
            !TryBuildPositionalMap[FieldDeclarationSyntax](previousTree, updatedTree, out var fieldMap) ||
            !TryBuildPositionalMap[PropertyDeclarationSyntax](previousTree, updatedTree, out var propertyMap) ||
            !TryBuildPositionalMap[EventDeclarationSyntax](previousTree, updatedTree, out var eventMap) ||
            !TryBuildPositionalMap[EnumDeclarationSyntax](previousTree, updatedTree, out var enumMap) ||
            !TryBuildPositionalMap[DelegateDeclarationSyntax](previousTree, updatedTree, out var delegateMap) {
            return false
        }
        // Reusing the prior scope keeps the prior (signature-level) diagnostics
        // verbatim. For unchanged files their spans are still correct, but the
        // edited file's spans may have shifted — so refuse the fast path when
        // the edited file contributed any global-scope diagnostic, to keep
        // diagnostics bit-for-bit identical to a full rebuild.
        // A diagnostic belongs to the edited tree when it points into that tree's text; an unnamed
        // tree has no file name to compare, so the text identity decides first.
        let editedFile = previousText.FileName
        for diagnostic in $scope.Diagnostics {
            let diagnosticText = diagnostic.Location.Text
            if object.ReferenceEquals(diagnosticText, previousText) {
                return false
            }
            if SourcePathIdentity.AreSame(diagnosticText?.FileName, editedFile) {
                return false
            }
        }
        // ---- Phase 1: gather every reused member whose backing syntax belongs
        // to the edited file, validating that each maps to a positional
        // counterpart. Nothing is mutated yet; on any unmapped member we bail.
        let importsToRepoint = List[(Symbol ImportSymbol, Updated ImportSyntax)]()
        for import_ in $scope.Imports {
            let declaration = import_.Declaration
            if declaration == nil || declaration.SyntaxTree != previousTree {
                continue
            }
            if !importMap.TryGetValue(declaration, out var updated) {
                return false
            }
            importsToRepoint.Add((import_, updated))
        }
        let functionsToRepoint = List[(Symbol FunctionSymbol, Updated FunctionDeclarationSyntax)]()
        for function in EnumerateFunctionSymbols($scope) {
            let declaration FunctionDeclarationSyntax? = function.Declaration
            if declaration == nil || declaration.SyntaxTree != previousTree {
                continue
            }
            if !functionMap.TryGetValue(declaration, out var updated) {
                return false
            }
            functionsToRepoint.Add((function, updated))
        }
        let structsToRepoint = List[(Symbol StructSymbol, Updated StructDeclarationSyntax)]()
        for structSymbol in $scope.Structs {
            let declaration StructDeclarationSyntax? = structSymbol.Declaration
            if declaration == nil || declaration.SyntaxTree != previousTree {
                continue
            }
            if !TryMapStruct(declaration, structMap, out var updated) {
                return false
            }
            structsToRepoint.Add((structSymbol, updated))
        }
        let interfacesToRepoint = List[(Symbol InterfaceSymbol, Updated InterfaceDeclarationSyntax)]()
        for interfaceSymbol in $scope.Interfaces {
            let declaration InterfaceDeclarationSyntax? = interfaceSymbol.Declaration
            if declaration == nil || declaration.SyntaxTree != previousTree {
                continue
            }
            if !interfaceMap.TryGetValue(declaration, out var updated) {
                return false
            }
            interfacesToRepoint.Add((interfaceSymbol, updated))
        }
        let enumsToRepoint = List[(Symbol EnumSymbol, Updated EnumDeclarationSyntax)]()
        for enumSymbol in $scope.Enums {
            let declaration EnumDeclarationSyntax? = enumSymbol.Declaration
            if declaration == nil || declaration.SyntaxTree != previousTree {
                continue
            }
            if !enumMap.TryGetValue(declaration, out var updated) {
                return false
            }
            enumsToRepoint.Add((enumSymbol, updated))
        }
        let delegatesToRepoint = List[(Symbol DelegateTypeSymbol, Updated DelegateDeclarationSyntax)]()
        for delegateSymbol in $scope.Delegates {
            let declaration DelegateDeclarationSyntax? = delegateSymbol.Declaration
            if declaration == nil || declaration.SyntaxTree != previousTree {
                continue
            }
            if !delegateMap.TryGetValue(declaration, out var updated) {
                return false
            }
            delegatesToRepoint.Add((delegateSymbol, updated))
        }
        let constructorsToRepoint = List[(Symbol ConstructorSymbol, Updated ConstructorDeclarationSyntax)]()
        let deinitsToRepoint = List[(Symbol DeinitSymbol, Updated DeinitDeclarationSyntax)]()
        let fieldsToRepoint = List[(Symbol FieldSymbol, Updated SyntaxNode)]()
        let propertiesToRepoint = List[
            (
                Symbol PropertySymbol,
                Updated PropertyDeclarationSyntax,
                Getter BlockStatementSyntax?,
                Setter BlockStatementSyntax?
            )
        ]()
        let eventsToRepoint = List[
            (
                Symbol EventSymbol,
                Updated EventDeclarationSyntax,
                Add BlockStatementSyntax?,
                Remove BlockStatementSyntax?,
                Raise BlockStatementSyntax?
            )
        ]()
        for structSymbol in $scope.Structs {
            for field in structSymbol.Fields.Concat(structSymbol.StaticFields).Concat(structSymbol.ConstFields) {
                let declaration SyntaxNode? = field.Declaration
                if declaration == nil || declaration.SyntaxTree != previousTree {
                    continue
                }
                let updated SyntaxNode? = switch declaration {
                    case fieldDeclaration is FieldDeclarationSyntax when fieldMap.TryGetValue(
                        fieldDeclaration,
                        out var updatedField
                    ): cast[SyntaxNode](updatedField)
                    case _ is ParameterSyntax when structSymbol.Declaration is {} structDeclaration &&
                        TryMapStruct(structDeclaration, structMap, out var updatedStruct): (
                        updatedStruct.PrimaryConstructorParameters?.FirstOrDefault(
                            (parameter ParameterSyntax) -> parameter.Identifier!!.ValueText == field.Name
                        ) as SyntaxNode?
                    )
                    default: nil
                }
                if updated == nil {
                    return false
                }
                fieldsToRepoint.Add((field, updated))
            }
            // Constructors (ADR-0063 §9). Synthesized primary constructors carry
            // no declaration node and have no rebindable body — skip them.
            if !structSymbol.ExplicitConstructors.IsDefaultOrEmpty {
                for ctor in structSymbol.ExplicitConstructors {
                    let declaration ConstructorDeclarationSyntax? = ctor.Declaration
                    if declaration == nil || declaration.SyntaxTree != previousTree {
                        continue
                    }
                    if !constructorMap.TryGetValue(declaration, out var updated) {
                        return false
                    }
                    constructorsToRepoint.Add((ctor, updated))
                }
            }
            // Destructor (ADR-0068 / issue #698).
            let deinit = structSymbol.Deinitializer
            if deinit?.Declaration != nil && deinit!!.Declaration.SyntaxTree == previousTree {
                if !deinitMap.TryGetValue(deinit!!.Declaration, out var updated) {
                    return false
                }
                deinitsToRepoint.Add((deinit!!, updated))
            }
            // Computed-property accessor bodies (ADR-0051), instance + static.
            for prop in EnumerateProperties(structSymbol) {
                let declaration PropertyDeclarationSyntax? = prop.Declaration
                if declaration == nil || declaration.SyntaxTree != previousTree {
                    continue
                }
                if !propertyMap.TryGetValue(declaration, out var updated) {
                    return false
                }
                let newGetter BlockStatementSyntax? = GetAccessorBody(updated, isGetter: true)
                let newSetter BlockStatementSyntax? = GetAccessorBody(updated, isGetter: false)
                // The accessor shape must match (skeleton equality guarantees
                // it); refuse rather than risk dropping or inventing a body.
                if (prop.GetterBodySyntax != nil) != (newGetter != nil) ||
                    (prop.SetterBodySyntax != nil) != (newSetter != nil) {
                    return false
                }
                propertiesToRepoint.Add((prop, updated, newGetter, newSetter))
            }
            // Explicit event accessor bodies (ADR-0052 / issue #257), instance + static.
            for ev in EnumerateEvents(structSymbol) {
                let declaration EventDeclarationSyntax? = ev.Declaration
                if declaration == nil || declaration.SyntaxTree != previousTree {
                    continue
                }
                if !eventMap.TryGetValue(declaration, out var updated) {
                    return false
                }
                let newAdd BlockStatementSyntax? = GetEventAccessorBody(updated, EventAccessorKind.Add)
                let newRemove BlockStatementSyntax? = GetEventAccessorBody(updated, EventAccessorKind.Remove)
                let newRaise BlockStatementSyntax? = GetEventAccessorBody(updated, EventAccessorKind.Raise)
                if (ev.AddBodySyntax != nil) != (newAdd != nil) ||
                    (ev.RemoveBodySyntax != nil) != (newRemove != nil) ||
                    (ev.RaiseBodySyntax != nil) != (newRaise != nil) {
                    return false
                }
                eventsToRepoint.Add((ev, updated, newAdd, newRemove, newRaise))
            }
        }
        for interfaceSymbol in $scope.Interfaces {
            for field in interfaceSymbol.StaticFields.Concat(interfaceSymbol.ConstFields) {
                let declaration SyntaxNode? = field.Declaration
                if declaration == nil || declaration.SyntaxTree != previousTree {
                    continue
                }
                if declaration is not FieldDeclarationSyntax fieldDeclaration || !fieldMap.TryGetValue(
                    fieldDeclaration,
                    out var updated
                ) {
                    return false
                }
                fieldsToRepoint.Add((field, updated))
            }
        }
        // ---- Phase 2: all validation passed — apply the re-point. This is the
        // only mutation, and it only swaps backing syntax (signatures and
        // accessor shapes are byte-identical).
        for (symbol, updated) in importsToRepoint {
            symbol.RepointDeclaration(updated)
        }
        for (symbol, updated) in functionsToRepoint {
            symbol.RepointDeclaration(updated)
        }
        for (symbol, updated) in structsToRepoint {
            symbol.RepointDeclaration(updated)
        }
        for (symbol, updated) in interfacesToRepoint {
            symbol.RepointDeclaration(updated)
        }
        for (symbol, updated) in enumsToRepoint {
            symbol.RepointDeclaration(updated)
        }
        for (symbol, updated) in delegatesToRepoint {
            symbol.RepointDeclaration(updated)
        }
        for (symbol, updated) in constructorsToRepoint {
            symbol.RepointDeclaration(updated)
        }
        for (symbol, updated) in deinitsToRepoint {
            symbol.RepointDeclaration(updated)
        }
        for (symbol, updated) in fieldsToRepoint {
            symbol.RepointDeclaration(updated)
        }
        for (symbol, updated, getter, setter) in propertiesToRepoint {
            symbol.RepointDeclaration(updated)
            symbol.GetterBodySyntax = getter
            symbol.SetterBodySyntax = setter
        }
        for (symbol, updated, add, remove, raise) in eventsToRepoint {
            symbol.RepointDeclaration(updated)
            symbol.AddBodySyntax = add
            symbol.RemoveBodySyntax = remove
            symbol.RaiseBodySyntax = raise
        }
        return true
    }

    private func EnumerateFunctionSymbols($scope BoundGlobalScope) sequence[FunctionSymbol] {
        for function in $scope.Functions {
            yield function
        }
        for structSymbol in $scope.Structs {
            if !structSymbol.Methods.IsDefaultOrEmpty {
                for method in structSymbol.Methods {
                    yield method
                }
            }
            if !structSymbol.StaticMethods.IsDefaultOrEmpty {
                for method in structSymbol.StaticMethods {
                    yield method
                }
            }
        }
        // Interface default / static-virtual / private helper methods carry
        // FunctionDeclarationSyntax declarations and rebindable bodies.
        for interfaceSymbol in $scope.Interfaces {
            for method in EnumerateInterfaceMethods(interfaceSymbol) {
                yield method
            }
        }
    }

    private func EnumerateInterfaceMethods(interfaceSymbol InterfaceSymbol) sequence[FunctionSymbol] {
        if !interfaceSymbol.Methods.IsDefaultOrEmpty {
            for method in interfaceSymbol.Methods {
                yield method
            }
        }
        if !interfaceSymbol.StaticMethods.IsDefaultOrEmpty {
            for method in interfaceSymbol.StaticMethods {
                yield method
            }
        }
        if !interfaceSymbol.PrivateMethods.IsDefaultOrEmpty {
            for method in interfaceSymbol.PrivateMethods {
                yield method
            }
        }
        if !interfaceSymbol.StaticPrivateMethods.IsDefaultOrEmpty {
            for method in interfaceSymbol.StaticPrivateMethods {
                yield method
            }
        }
    }

    private func EnumerateProperties(structSymbol StructSymbol) sequence[PropertySymbol] {
        if !structSymbol.Properties.IsDefaultOrEmpty {
            for prop in structSymbol.Properties {
                yield prop
            }
        }
        if !structSymbol.StaticProperties.IsDefaultOrEmpty {
            for prop in structSymbol.StaticProperties {
                yield prop
            }
        }
    }

    private func EnumerateEvents(structSymbol StructSymbol) sequence[EventSymbol] {
        if !structSymbol.Events.IsDefaultOrEmpty {
            for ev in structSymbol.Events {
                yield ev
            }
        }
        if !structSymbol.StaticEvents.IsDefaultOrEmpty {
            for ev in structSymbol.StaticEvents {
                yield ev
            }
        }
    }

    private func ContainsUnsupportedConstruct(tree SyntaxTree) bool {
        for node in Descendants(tree.Root) {
            // Top-level statements feed the synthesized <Main>$ entry-point body,
            // which is bound from BoundGlobalScope.Statements rather than from a
            // member-declaration node — so it cannot be re-pointed. Bail.
            if node is GlobalStatementSyntax {
                return true
            }
            // ADR-0144: a `partial` type's symbol is bound from ONE synthetic
            // declaration that PartialTypeMerger builds by merging every part
            // (across files) during the full bind. The body-only positional
            // re-point maps this file's raw declarations onto reused symbols, so
            // a raw partial part cannot be re-pointed onto the merged symbol
            // soundly (and the sibling parts in other files are not represented
            // here). Fall back to a full rebuild for any file containing a
            // partial part.
            if (
                node is StructDeclarationSyntax and
                    {IsPartial: true} or
                    InterfaceDeclarationSyntax and
                    {IsPartial: true}
            ) {
                return true
            }
        }
        return false
    }

    /// Maps a symbol's type declaration onto the edited tree's. A `shared class` (or a
    /// type nesting one) is bound from the copy (cref:SharedClassNormalizer) made of
    /// the parsed declaration, so the positional map, which is keyed by parsed
    /// declarations, is consulted through the copy's source and the edited declaration is
    /// normalized the same way. A copy that normalization alone does not reproduce (one
    /// made by another pre-pass) is not mapped, which falls back to a full bind.
    private func TryMapStruct(
        declaration StructDeclarationSyntax,
        structMap Dictionary[StructDeclarationSyntax, StructDeclarationSyntax],
        out updated StructDeclarationSyntax
    ) bool {
        let source = declaration.DocumentationSource ?? declaration
        if !structMap.TryGetValue(source, out var updatedSource) {
            updated = declaration
            return false
        }
        if object.ReferenceEquals(source, declaration) {
            updated = updatedSource
            return true
        }
        let scratch = DiagnosticBag()
        if !HasSameShape(SharedClassNormalizer.Normalize(source, scratch), declaration) {
            updated = declaration
            return false
        }
        updated = SharedClassNormalizer.Normalize(updatedSource, scratch)
        return true
    }

    private func HasSameShape(left StructDeclarationSyntax, right StructDeclarationSyntax) bool -> left
        .Fields
        .Length == right
        .Fields
        .Length &&
        left
        .Properties
        .Length == right
        .Properties
        .Length &&
        left
        .Events
        .Length == right
        .Events
        .Length &&
        left
        .Methods
        .Length == right
        .Methods
        .Length &&
        left
        .NestedTypes
        .Length == right
        .NestedTypes
        .Length &&
        left
        .SharedInitializers
        .Length == right
        .SharedInitializers
        .Length &&
        (left.SharedBlock?.Methods.Length ?? -1) == (right.SharedBlock?.Methods.Length ?? -1) &&
        (left.SharedBlock?.Fields.Length ?? -1) == (right.SharedBlock?.Fields.Length ?? -1)

    private func TryBuildPositionalMap[TNode SyntaxNode](
        previousTree SyntaxTree,
        updatedTree SyntaxTree,
        out $map Dictionary[TNode, TNode]
    ) bool {
        let previous = CollectDeclarations[TNode](previousTree)
        let updated = CollectDeclarations[TNode](updatedTree)
        if previous.Count != updated.Count {
            $map = Dictionary[TNode, TNode]()
            return false
        }
        $map = Dictionary[TNode, TNode](previous.Count)
        for var i = 0; i < previous.Count; i++ {
            $map[previous[i]] = updated[i]
        }
        return true
    }

    private func CollectDeclarations[TNode SyntaxNode](tree SyntaxTree) List[TNode] {
        return Descendants(tree.Root).OfType[TNode]().OrderBy((d TNode) -> d.Span.Start).ToList()
    }

    /// Collects, in ascending span order, the source spans of every body-bearing
    /// member body in the file: function/method bodies (top-level, struct,
    /// interface), constructor and destructor bodies, computed-property accessor
    /// bodies and explicit event accessor bodies. Bodies nested inside another
    /// collected body (e.g. a local function) are naturally subsumed by the
    /// outer span and skipped by (cref:BuildSkeleton).
    private func CollectBodySpans(tree SyntaxTree) List[TextSpan] {
        let spans = List[TextSpan]()
        for node in Descendants(tree.Root) {
            switch node {
                case function is FunctionDeclarationSyntax when function.Body != nil {
                    spans.Add(function.Body!!.Span)
                }
                case ctor is ConstructorDeclarationSyntax when ctor.Body != nil {
                    spans.Add(ctor.Body.Span)
                }
                case deinit is DeinitDeclarationSyntax when deinit.Body != nil {
                    spans.Add(deinit.Body.Span)
                }
                case propAccessor is PropertyAccessorSyntax when propAccessor.Body != nil {
                    spans.Add(propAccessor.Body!!.Span)
                }
                case eventAccessor is EventAccessorSyntax when eventAccessor.Body != nil {
                    spans.Add(eventAccessor.Body!!.Span)
                }
            }
        }
        spans.Sort((a TextSpan, b TextSpan) -> a.Start.CompareTo(b.Start))
        return spans
    }

    private func BuildSkeleton(text SourceText, bodySpans List[TextSpan]) string {
        let builder = StringBuilder()
        var position = 0
        for span in bodySpans {
            // A body whose start lies within the already-consumed prefix is
            // nested inside an outer body that has already been blanked — skip
            // it (its text is part of the placeholder for the enclosing body).
            if span.Start < position {
                continue
            }
            builder.Append(text.ToString(TextSpan.FromBounds(position, span.Start)))
            builder.Append(BodyPlaceholder)
            position = span.End
        }
        builder.Append(text.ToString(TextSpan.FromBounds(position, text.Length)))
        return builder.ToString()
    }

    private func GetAccessorBody(property PropertyDeclarationSyntax, isGetter bool) BlockStatementSyntax? {
        for accessor in property.Accessors {
            if if isGetter {
                accessor.IsGetter
            } else {
                accessor.IsSetter
            } {
                return accessor.Body
            }
        }
        return nil
    }

    private func GetEventAccessorBody(
        eventDeclaration EventDeclarationSyntax,
        kind EventAccessorKind
    ) BlockStatementSyntax? {
        for accessor in eventDeclaration.Accessors {
            let matches = switch kind {
                case EventAccessorKind.Add: accessor.IsAdd
                case EventAccessorKind.Remove: accessor.IsRemove
                case EventAccessorKind.Raise: accessor.IsRaise
                default: false
            }
            if matches {
                return accessor.Body
            }
        }
        return nil
    }

    private func Descendants(root SyntaxNode) sequence[SyntaxNode] {
        let stack = Stack[SyntaxNode]()
        stack.Push(root)
        while stack.Count > 0 {
            let node = stack.Pop()
            yield node
            for child in node.GetChildren() {
                if child != nil {
                    stack.Push(child)
                }
            }
        }
    }
}
