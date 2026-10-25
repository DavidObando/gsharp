// <copyright file="SemanticModel.Scopes.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Runtime.CompilerServices
import System.Threading

/// Position-based queries of (cref:SemanticModel) (ADR-0212 section 7b): the
/// symbol that encloses a position and the symbols a simple name resolves to
/// there.
/// @remarks The bound bodies the model indexes are lowered, so their block
/// structure does not hold the source regions. The shape of each scope comes
/// from the syntax; the identity of each symbol comes from the model's index of
/// declared symbols, so a query answers with the symbols the binder created.
partial class SemanticModel {
    /// Returns the innermost declaration that contains [`position`](paramref):
    /// a function (including a method), a constructor (its function), a property
    /// accessor (its getter or setter function, else the property), a struct or
    /// interface, or a top-level variable. Returns null at top level outside a
    /// declaration, and for a position inside a local function literal's own
    /// declaration (a literal is not a declaration; its enclosing declaration
    /// answers).
    /// @remarks Contract, one row per construct that contains the position:
    /// function or method declaration answers its function; constructor
    /// declaration answers the constructor's function; accessor answers the
    /// accessor function; property header answers the property; struct or
    /// interface answers the type; a top-level `let` answers the global.
    /// @param position A character offset into this model's tree.
    /// @param cancellationToken Cancels index construction on first use.
    /// @returns The enclosing symbol, or null.
    func GetEnclosingSymbol(position int32, cancellationToken CancellationToken = default(CancellationToken)) Symbol? {
        cancellationToken.ThrowIfCancellationRequested()
        return EnclosingSymbolOf(FindInnermostNode(position), cancellationToken)
    }

    private func EnclosingSymbolOf(innermost SyntaxNode, cancellationToken CancellationToken) Symbol? {
        var node SyntaxNode? = innermost
        while node is {} current {
            let symbol = DeclarationSymbolOf(current, cancellationToken)
            if symbol != nil {
                return symbol
            }
            node = current.Parent
        }
        return nil
    }

    /// Returns the symbols a simple name resolves to at [`position`](paramref)
    /// in this tree, one symbol per name: the innermost declaration shadows.
    /// @remarks Contract, tiers from innermost to outermost; a tier only
    /// answers a name no inner tier answered.
    /// <list type="table">
    /// <item>Locals (tier 1): a `let` or `var` is visible from the end of its
    /// declaration (from the start of its initializer when that is a function
    /// literal, so it can call itself) to the end of the nearest enclosing block or
    /// block expression; an `if`, `for` or `if let` header initializer to the end of
    /// its statement; an `if let` binding from the end of its clause to the end
    /// of the then-region (never the else branch); a `while let` binding from
    /// the end of its clause to the end of the body; a `guard let` binding to
    /// the end of the enclosing block; a `for`, `await for` or tuple `for`
    /// variable through its body; a catch variable through its `when` filter and
    /// body; a parameter (also a destructured, lambda or function-literal
    /// parameter) through its function, constructor, lambda, literal or accessor;
    /// the pattern variable of a `switch` case or arm through that case or arm; any
    /// other pattern variable from its declaration to the end of the enclosing
    /// block.</item>
    /// <item>The implicit `this` parameter of the enclosing instance method,
    /// constructor or accessor follows the locals.</item>
    /// <item>Members (tier 2): inside an instance method, constructor or
    /// accessor of a struct or class, the members of that type reachable without
    /// a receiver, inherited ones included; inside a `shared` member, the
    /// static ones.</item>
    /// <item>Globals (tier 3): the compilation's functions, variables, structs,
    /// interfaces, enums and delegates, then those of the prior submissions,
    /// newest first, when the compilation is a submission. A type alias is found
    /// by its name and answers the type it names; the enumeration does not list it
    /// (the symbol would carry the target's name).</item>
    /// </list>
    /// Order: scope depth innermost first, then declaration order, so the result
    /// is deterministic. Imported (CLR) types are not listed.
    /// @param position A character offset into this model's tree.
    /// @param name When given, only the symbol of this name.
    /// @param cancellationToken Cancels index construction on first use.
    /// @returns The symbols, empty when none resolves.
    func LookupSymbols(
        position int32,
        name string? = nil,
        cancellationToken CancellationToken = default(CancellationToken)
    ) ImmutableArray[Symbol] {
        cancellationToken.ThrowIfCancellationRequested()
        let result = ImmutableArray.CreateBuilder[Symbol]()
        let seen = HashSet[string](StringComparer.Ordinal)
        AddScopedLocals(position, name, result, seen)
        if name != nil && result.Count > 0 {
            return result.ToImmutable()
        }
        // The declaration walk below is shared by the implicit `this` and the members.
        let innermost = FindInnermostNode(position)
        AddImplicitThis(innermost, name, result, seen, cancellationToken)
        if name != nil && result.Count > 0 {
            return result.ToImmutable()
        }
        AddReceiverlessMembers(innermost, name, result, seen)
        if name != nil && result.Count > 0 {
            return result.ToImmutable()
        }
        AddGlobals(compilation.GlobalScope, name, result, seen)
        if compilation.Submission is {Imports: {} imports} && !imports.NewestFirst.IsDefaultOrEmpty {
            for reference in imports.NewestFirst {
                if name != nil && result.Count > 0 {
                    break
                }
                AddGlobals(reference.GlobalScope, name, result, seen)
            }
        }
        return result.ToImmutable()
    }

    private data class ScopedLocal(Local Symbol, Depth int32, Start int32) : IEquatable[ScopedLocal] { }

    private func AddScopedLocals(
        position int32,
        name string?,
        result ImmutableArray[Symbol].Builder,
        seen HashSet[string]
    ) {
        let candidates = List[ScopedLocal]()
        var named ImmutableArray[(Anchor SyntaxNode, Local Symbol)] = index.Value.LocalDeclarations
        if name != nil {
            // The name map is only looked up, never enumerated.
            if !index.Value.LocalDeclarationsByName.TryGetValue(name, out named) {
                named = ImmutableArray[(Anchor SyntaxNode, Local Symbol)].Empty
            }
        }
        for (anchor, local) in named {
            // A local function is visible in its whole block, so that local functions can
            // call themselves and each other; every other local follows its declaration.
            let hoisted = local is FunctionSymbol
            let region = RegionOf(anchor)
            if region == nil || IsInGuardElse(anchor, position) {
                continue
            }
            // The one declaration-order rule: a local is visible from the end of its own
            // declaration, or from where its region starts when that is later.
            let start = if hoisted {
                region.Owner.Span.Start
            } else {
                Math.Max(region.Start, anchor.Span.End)
            }
            if !RegionContains(start, region.End, position) {
                continue
            }
            candidates.Add(ScopedLocal(local, Depth(region.Owner), anchor.Span.Start))
        }
        // The innermost, then the latest, declaration of a name shadows the others.
        let winners = List[ScopedLocal]()
        for candidate in candidates.OrderByDescending((c ScopedLocal) -> c.Depth).ThenByDescending(
            (c ScopedLocal) -> c.Start
        ) {
            if seen.Add(candidate.Local.Name) {
                winners.Add(candidate)
            }
        }
        for winner in winners.OrderByDescending((c ScopedLocal) -> c.Depth).ThenBy((c ScopedLocal) -> c.Start) {
            result.Add(winner.Local)
        }
    }

    /// Adds the implicit `this` parameter of the enclosing instance method, constructor or
    /// accessor, and the parameters the binder made without syntax (a setter's `value`),
    /// after the declared locals and parameters.
    private func AddImplicitThis(
        innermost SyntaxNode,
        name string?,
        result ImmutableArray[Symbol].Builder,
        seen HashSet[string],
        cancellationToken CancellationToken
    ) {
        if EnclosingSymbolOf(innermost, cancellationToken) is not FunctionSymbol function {
            return
        }
        if function.ThisParameter is {} thisParameter &&
            (name == nil || string.Equals(thisParameter.Name, name, StringComparison.Ordinal)) &&
            seen.Add(thisParameter.Name) {
            result.Add(thisParameter)
        }
        for parameter in function.Parameters {
            if parameter
                .DeclaringSyntaxNodes
                .IsDefaultOrEmpty &&
                IsListable(parameter.Name) &&
                (name == nil || string.Equals(parameter.Name, name, StringComparison.Ordinal)) &&
                seen.Add(parameter.Name) {
                result.Add(parameter)
            }
        }
    }

    private func AddReceiverlessMembers(
        innermost SyntaxNode,
        name string?,
        result ImmutableArray[Symbol].Builder,
        seen HashSet[string]
    ) {
        var node SyntaxNode? = innermost
        var insideMember = false
        var isShared = false
        var owner StructDeclarationSyntax? = nil
        while node is {} current {
            if current is FunctionDeclarationSyntax or ConstructorDeclarationSyntax or PropertyAccessorSyntax {
                insideMember = true
            } else if current is SharedBlockSyntax {
                isShared = true
            } else if current is StructDeclarationSyntax structDeclaration {
                if insideMember {
                    owner = structDeclaration
                }
                break
            }
            node = current.Parent
        }
        if owner == nil || StructSymbolOf(owner) is not{} structSymbol {
            return
        }
        let query = if isShared {
            MemberQuery.InheritedStatic()
        } else {
            MemberQuery.All
        }
        if name != nil {
            var member = TypeMemberModel.LookupMember(structSymbol, name, query)
            if member != nil && !IsReceiverlessMember(member, structSymbol) {
                member = nil
            }
            member ??= FindConstant(structSymbol, name)
            if member != nil && seen.Add(member.Name) {
                result.Add(member)
            }
            return
        }
        for member in TypeMemberModel.EnumerateMembers(structSymbol, query) {
            if IsReceiverlessMember(member, structSymbol) && IsListable(member.Name) && seen.Add(member.Name) {
                result.Add(member)
            }
        }
        // Constants are held apart from the other fields and are static.
        for type in structSymbol.GetHierarchy() {
            for constant in type.ConstFields {
                if IsReceiverlessMember(constant, structSymbol) && IsListable(constant.Name) && seen.Add(
                    constant.Name
                ) {
                    result.Add(constant)
                }
            }
        }
    }

    /// Whether a bare name can bind to [`member`](paramref) inside [`current`](paramref): not an
    /// indexer, not a field-like event's backing field, and not a private member of a base type.
    private func IsReceiverlessMember(member Symbol, current StructSymbol) bool {
        if member is PropertySymbol{IsIndexer: true} || member is FieldSymbol{IsEventBackingField: true} {
            return false
        }
        let accessibility Accessibility? = switch member {
            case field is FieldSymbol: field.Accessibility
            case property is PropertySymbol: property.Accessibility
            case function is FunctionSymbol: function.Accessibility
            case declaredEvent is EventSymbol: declaredEvent.Accessibility
            default: default(Accessibility?)
        }
        if accessibility == Accessibility.Private {
            let owner = member.ContainingType
            return owner == nil || object.ReferenceEquals(owner, current) ||
                (current.Definition != nil && object.ReferenceEquals(owner, current.Definition))
        }
        return true
    }

    private func FindConstant(current StructSymbol, name string) Symbol? {
        for type in current.GetHierarchy() {
            for constant in type.ConstFields {
                if string.Equals(constant.Name, name, StringComparison.Ordinal) &&
                    IsReceiverlessMember(constant, current) {
                    return constant
                }
            }
        }
        return nil
    }

    private func AddGlobals(
        globalScope BoundGlobalScope,
        name string?,
        result ImmutableArray[Symbol].Builder,
        seen HashSet[string]
    ) {
        let table = GlobalTables.GetValue(globalScope, (table BoundGlobalScope) -> BuildGlobalTable(table))
        if name != nil {
            if table.ByName.TryGetValue(name, out var found) && seen.Add(name) {
                result.Add(found)
            }
            return
        }
        for entry in table.Ordered {
            if seen.Add(entry.Name) {
                result.Add(entry.Symbol)
            }
        }
    }

    private func StructSymbolOf(
        declaration StructDeclarationSyntax,
        cancellationToken CancellationToken = default(CancellationToken)
    ) StructSymbol? {
        if GetDeclaredSymbol(declaration, cancellationToken) is StructSymbol declared {
            return declared
        }
        return if index.Value.TypesByIdentifier.TryGetValue(declaration.Identifier, out var byIdentifier) {
            byIdentifier as StructSymbol
        } else {
            default(StructSymbol?)
        }
    }

    private func DeclarationSymbolOf(node SyntaxNode, cancellationToken CancellationToken) Symbol? {
        if node is FunctionDeclarationSyntax or InterfaceDeclarationSyntax {
            return GetDeclaredSymbol(node, cancellationToken)
        }
        if node is StructDeclarationSyntax structDeclaration {
            return StructSymbolOf(structDeclaration, cancellationToken)
        }
        // A property is declared at its identifier, not at its declaration node.
        if node is PropertyDeclarationSyntax propertyDeclaration {
            return GetDeclaredSymbol(propertyDeclaration.Identifier, cancellationToken)
        }
        if node is ConstructorDeclarationSyntax constructor {
            if constructor.FirstAncestorOrSelf[StructDeclarationSyntax]() is {} owner &&
                StructSymbolOf(owner, cancellationToken) is {} structSymbol {
                for candidate in structSymbol.ExplicitConstructors {
                    if object.ReferenceEquals(candidate.Declaration, constructor) {
                        return candidate.Function
                    }
                }
            }
            return nil
        }
        if node is PropertyAccessorSyntax accessor {
            if accessor.FirstAncestorOrSelf[PropertyDeclarationSyntax]() is {} declaration &&
                GetDeclaredSymbol(declaration.Identifier, cancellationToken) is PropertySymbol property {
                let accessorFunction FunctionSymbol? = if accessor.IsGetter {
                    property.GetterSymbol
                } else {
                    property.SetterSymbol
                }
                return accessorFunction ?? property
            }
            return nil
        }
        if node is VariableDeclarationSyntax variable && GetDeclaredSymbol(variable.Identifier, cancellationToken) is
        GlobalVariableSymbol global {
            return global
        }
        return nil
    }

    /// Finds the innermost node whose span contains [`position`](paramref); a
    /// position at the boundary between two nodes belongs to the one that
    /// starts there, else to the one that ends there.
    private func FindInnermostNode(position int32) SyntaxNode {
        var current SyntaxNode = syntaxTree.Root
        while true {
            var next SyntaxNode? = nil
            var touching SyntaxNode? = nil
            for child in current.GetChildren() {
                let span = child.Span
                if span.Length == 0 {
                    continue
                }
                if span.Start <= position && position < span.End {
                    next = child
                    break
                }
                if span.End == position {
                    touching = child
                }
            }
            let chosen = next ?? touching
            if chosen == nil {
                return current
            }
            current = chosen
        }
    }

    private func Depth(node SyntaxNode) int32 {
        var depth = 0
        var current SyntaxNode? = node.Parent
        while current != nil {
            depth++
            current = current.Parent
        }
        return depth
    }

    private func RegionContains(start int32, end int32, position int32) bool {
        if position < start {
            return false
        }
        if position < end {
            return true
        }
        // A region that ends at a closing brace does not include the position after it.
        let text = syntaxTree.Text
        return position == end && !(text != nil && end > 0 && end <= text.Length && text[end - 1] == '}')
    }

    private data class Region(Owner SyntaxNode, Start int32, End int32) : IEquatable[Region] { }

    /// Gets the region in which the local declared at [`anchor`](paramref) is
    /// visible, and the node that owns the region.
    private func RegionOf(anchor SyntaxNode) Region? {
        let parent = anchor.Parent
        if parent is IfLetBindingClauseSyntax clause {
            var owner SyntaxNode? = clause.Parent
            while owner != nil &&
                owner is not(
                IfLetStatementSyntax or IfLetExpressionSyntax or WhileLetStatementSyntax or GuardLetStatementSyntax
            ) {
                owner = owner.Parent
            }
            if owner is IfLetStatementSyntax ifLet {
                return Region(ifLet, clause.Span.End, ifLet.ThenStatement.Span.End)
            }
            if owner is IfLetExpressionSyntax ifLetExpression {
                return Region(ifLetExpression, clause.Span.End, ifLetExpression.ThenBlock.Span.End)
            }
            if owner is WhileLetStatementSyntax whileLet {
                return Region(whileLet, clause.Span.End, whileLet.Body.Span.End)
            }
            if owner is GuardLetStatementSyntax guardLet {
                // A binding is visible to the clauses after it and, once the statement is done, to the rest
                // of the block, but not to the `else` body (see IsInGuardElse).
                let block = EnclosingBlock(guardLet)
                return Region(block, clause.Span.End, block.Span.End)
            }
        }
        if parent is ForRangeStatementSyntax forRange {
            return BodyRegion(forRange, forRange.Body)
        }
        if parent is AwaitForRangeStatementSyntax awaitFor {
            return BodyRegion(awaitFor, awaitFor.Body)
        }
        if parent is ForTupleRangeStatementSyntax tupleFor {
            return BodyRegion(tupleFor, tupleFor.Body)
        }
        if parent is CatchClauseSyntax catchClause {
            // The variable is declared before the `when` filter binds, so it is visible there too.
            return Region(catchClause, catchClause.Span.Start, catchClause.Span.End)
        }
        if parent is PropertyAccessorSyntax accessor {
            return Region(accessor, accessor.Span.Start, accessor.Span.End)
        }
        if anchor.FirstAncestorOrSelf[ParameterSyntax]() is {} parameter {
            var owner SyntaxNode? = parameter.Parent
            while owner != nil &&
                owner is not(
                FunctionDeclarationSyntax or
                    ConstructorDeclarationSyntax or
                    LambdaExpressionSyntax or
                    FunctionLiteralExpressionSyntax or
                    PropertyDeclarationSyntax or
                    DeinitDeclarationSyntax
            ) {
                owner = owner.Parent
            }
            if owner != nil {
                return Region(owner, owner.Span.Start, owner.Span.End)
            }
        }
        let declaration VariableDeclarationSyntax? = if anchor is VariableDeclarationSyntax self {
            self
        } else if parent is VariableDeclarationSyntax enclosing {
            enclosing
        } else {
            default(VariableDeclarationSyntax?)
        }
        if declaration != nil {
            let owner = DeclarationScope(declaration)
            // A `let`-bound function literal sees itself, so that it can recurse.
            let start = if declaration.Initializer is FunctionLiteralExpressionSyntax literal {
                literal.Span.Start
            } else {
                declaration.Span.End
            }
            return Region(owner, start, owner.Span.End)
        }
        // A pattern variable of a `switch` case or expression arm belongs to that arm alone.
        var ancestor SyntaxNode? = parent
        while ancestor != nil && ancestor is not(BlockStatementSyntax or BlockExpressionSyntax) {
            if ancestor is SwitchCaseSyntax or SwitchExpressionArmSyntax {
                return Region(ancestor, anchor.Span.End, ancestor.Span.End)
            }
            ancestor = ancestor.Parent
        }
        // A pattern variable of an `is` pattern is scoped to the statement that holds the test. The
        // binder also lets it leak past an early exit (`if !(x is T t) { return }`); that depends on
        // flow and is not modeled.
        if parent is TypePatternSyntax or VarPatternSyntax or PropertyPatternSyntax or SlicePatternSyntax {
            var statement SyntaxNode? = parent
            while statement != nil && statement is not StatementSyntax {
                statement = statement.Parent
            }
            if statement != nil {
                return Region(statement, anchor.Span.End, statement.Span.End)
            }
        }
        let block = EnclosingBlock(anchor)
        return Region(block, anchor.Span.End, block.Span.End)
    }

    /// Whether [`position`](paramref) is in the `else` body of the `guard let` that declares
    /// [`anchor`](paramref): the body runs when a binding failed.
    private func IsInGuardElse(anchor SyntaxNode, position int32) bool {
        if anchor.Parent is not IfLetBindingClauseSyntax clause {
            return false
        }
        var owner SyntaxNode? = clause.Parent
        while owner != nil && owner is not GuardLetStatementSyntax {
            owner = owner.Parent
        }
        return owner is GuardLetStatementSyntax guardLet &&
            position >= guardLet
            .ElseKeyword
            .Span
            .Start &&
            position < guardLet
            .Span
            .End
    }

    private func BodyRegion(owner SyntaxNode, body SyntaxNode?) Region? {
        if body == nil {
            return nil
        }
        return Region(owner, body.Span.Start, body.Span.End)
    }

    /// Gets the nearest enclosing block, block expression or the tree's root.
    private func EnclosingBlock(node SyntaxNode) SyntaxNode {
        var current SyntaxNode? = node.Parent
        while current != nil {
            if current is BlockStatementSyntax or BlockExpressionSyntax {
                return current
            }
            current = current.Parent
        }
        return syntaxTree.Root
    }

    /// Gets the node whose span is the lexical scope of a local declaration: an
    /// `if` / `for` header initializer is scoped to its whole statement (or
    /// if-expression), and any other declaration to its nearest enclosing
    /// block, block expression or the tree's root.
    private func DeclarationScope(declaration VariableDeclarationSyntax) SyntaxNode {
        var child SyntaxNode = declaration
        var node SyntaxNode? = declaration.Parent
        while node is {} current {
            switch current {
                case block is BlockStatementSyntax {
                    return block
                }
                case blockExpression is BlockExpressionSyntax {
                    return blockExpression
                }
                case ifStatement is IfStatementSyntax when object.ReferenceEquals(ifStatement.Initializer, child) {
                    return ifStatement
                }
                case ifExpression is IfExpressionSyntax when object.ReferenceEquals(ifExpression.Initializer, child) {
                    return ifExpression
                }
                case forClause is ForClauseStatementSyntax when object.ReferenceEquals(forClause.Initializer, child) {
                    return forClause
                }
                default { }
            }
            child = current
            node = current.Parent
        }
        return syntaxTree.Root
    }

    private data class GlobalTable(
        Ordered ImmutableArray[(Name string, Symbol Symbol)],
        ByName Dictionary[string, Symbol]
    ) : IEquatable[GlobalTable] { }

    shared {
        /// The global names of each scope, built once. The table is only looked up by name, and
        /// enumerated in its ordered form, never as the dictionary.
        private let GlobalTables ConditionalWeakTable[BoundGlobalScope, GlobalTable] = ConditionalWeakTable[
            BoundGlobalScope,
            GlobalTable
        ]()

        private func BuildGlobalTable(globalScope BoundGlobalScope) GlobalTable {
            let ordered = ImmutableArray.CreateBuilder[(Name string, Symbol Symbol)]()
            let byName = Dictionary[string, Symbol](StringComparer.Ordinal)
            for function in globalScope.Functions {
                AddGlobalEntry(ordered, byName, function.Name, function)
            }
            for variable in globalScope.Variables {
                AddGlobalEntry(ordered, byName, variable.Name, variable)
            }
            for aggregate in globalScope.Structs {
                AddGlobalEntry(ordered, byName, aggregate.Name, aggregate)
            }
            for declaredInterface in globalScope.Interfaces {
                AddGlobalEntry(ordered, byName, declaredInterface.Name, declaredInterface)
            }
            for declaredEnum in globalScope.Enums {
                AddGlobalEntry(ordered, byName, declaredEnum.Name, declaredEnum)
            }
            for declaredDelegate in globalScope.Delegates {
                AddGlobalEntry(ordered, byName, declaredDelegate.Name, declaredDelegate)
            }
            for alias in globalScope.TypeAliases.OrderBy(
                (pair KeyValuePair[string, TypeSymbol]) -> pair.Key,
                StringComparer.Ordinal
            ) {
                AddGlobalEntry(ordered, byName, alias.Key, alias.Value)
            }
            return GlobalTable(ordered.ToImmutable(), byName)
        }

        private func AddGlobalEntry(
            ordered ImmutableArray[(Name string, Symbol Symbol)].Builder,
            byName Dictionary[string, Symbol],
            globalName string,
            symbol Symbol
        ) {
            if IsListable(globalName) && byName.TryAdd(globalName, symbol) && string.Equals(
                globalName,
                symbol.Name,
                StringComparison.Ordinal
            ) {
                // An alias has no symbol of its own, so only its name finds it: listing the aliased
                // type under the alias would give two symbols one name.
                ordered.Add((globalName, symbol))
            }
        }

        /// Whether a name is one a user wrote, as opposed to a synthesized one.
        private func IsListable(name string?) bool {
            return !string.IsNullOrEmpty(name) && name!![0] != '<' && name!![0] != '$'
        }

        /// Collects the local variables, parameters and local functions declared in the tree, in
        /// source order. Globals are listed by (cref:LookupSymbols) from the
        /// global scope instead.
        private func CollectLocalDeclarations(declaredBySyntax Dictionary[SyntaxNode, Symbol]) ImmutableArray[
            (Anchor SyntaxNode, Local Symbol)
        ] {
            let locals = List[(Anchor SyntaxNode, Local Symbol)]()
            for pair in declaredBySyntax {
                let isLocal = pair.Value is FunctionSymbol{LocalDeclaration: not nil} ||
                    pair.Value is VariableSymbol and
                    not GlobalVariableSymbol
                if isLocal && IsListable(pair.Value.Name) {
                    locals.Add((pair.Key, pair.Value))
                }
            }
            return locals
                .OrderBy((entry(Anchor SyntaxNode, Local Symbol)) -> entry.Anchor.Span.Start)
                .ThenBy((entry(Anchor SyntaxNode, Local Symbol)) -> entry.Local.Name, StringComparer.Ordinal)
                .ToImmutableArray()
        }

        /// Groups the local declarations by name, each group in source order.
        private func GroupByName(locals ImmutableArray[(Anchor SyntaxNode, Local Symbol)]) Dictionary[
            string,
            ImmutableArray[(Anchor SyntaxNode, Local Symbol)]
        ] {
            let groups = Dictionary[string, List[(Anchor SyntaxNode, Local Symbol)]](StringComparer.Ordinal)
            for entry in locals {
                if !groups.TryGetValue(entry.Local.Name, out var group) {
                    group = List[(Anchor SyntaxNode, Local Symbol)]()
                    groups[entry.Local.Name] = group
                }
                group.Add(entry)
            }
            let result = Dictionary[string, ImmutableArray[(Anchor SyntaxNode, Local Symbol)]](
                groups.Count,
                StringComparer.Ordinal
            )
            for pair in groups {
                result[pair.Key] = pair.Value.ToImmutableArray()
            }
            return result
        }

        /// Pairs the type-clause identifiers of each declaration in [`tree`](paramref) with the
        /// types they name: function return and parameter types, struct field types, and the
        /// return and parameter types of methods and constructors.
        private func RecordTypeClauses(
            globalScope BoundGlobalScope,
            tree SyntaxTree,
            typeClauseTokens Dictionary[SyntaxToken, TypeSymbol]
        ) {
            for function in globalScope.Functions {
                RecordFunctionTypeClauses(function, tree, typeClauseTokens)
            }
            for aggregate in globalScope.Structs {
                if aggregate.Declaration is not{} declaration {
                    continue
                }
                for var i = 0; i < declaration.Fields.Length && i < aggregate.Fields.Length; i++ {
                    RecordTypeClause(declaration.Fields[i].Type, aggregate.Fields[i].Type, tree, typeClauseTokens)
                }
                for method in aggregate.Methods.Concat(aggregate.StaticMethods) {
                    RecordFunctionTypeClauses(method, tree, typeClauseTokens)
                }
                for constructor in aggregate.ExplicitConstructors {
                    if constructor.Declaration is {} constructorDeclaration {
                        RecordParameterTypeClauses(
                            constructorDeclaration.Parameters.ToArray(),
                            constructor.Parameters,
                            tree,
                            typeClauseTokens
                        )
                    }
                }
            }
        }

        private func RecordFunctionTypeClauses(
            function FunctionSymbol,
            tree SyntaxTree,
            typeClauseTokens Dictionary[SyntaxToken, TypeSymbol]
        ) {
            if function.Declaration is not{} declaration {
                return
            }
            RecordTypeClause(declaration.Type, function.Type, tree, typeClauseTokens)
            RecordParameterTypeClauses(declaration.Parameters.ToArray(), function.Parameters, tree, typeClauseTokens)
        }

        private func RecordParameterTypeClauses(
            syntaxParameters[]ParameterSyntax,
            parameters ImmutableArray[ParameterSymbol],
            tree SyntaxTree,
            typeClauseTokens Dictionary[SyntaxToken, TypeSymbol]
        ) {
            let symbolIndex = parameters.Length - syntaxParameters.Length
            for var i = 0; i < syntaxParameters.Length && symbolIndex + i < parameters.Length; i++ {
                RecordTypeClause(syntaxParameters[i].Type, parameters[symbolIndex + i].Type, tree, typeClauseTokens)
            }
        }

        private func RecordTypeClause(
            typeClause TypeClauseSyntax?,
            type TypeSymbol?,
            tree SyntaxTree,
            typeClauseTokens Dictionary[SyntaxToken, TypeSymbol]
        ) {
            for (identifier, named) in SemanticModel.GetTypeClauseSymbols(typeClause, type) {
                if object.ReferenceEquals(identifier.SyntaxTree, tree) {
                    typeClauseTokens[identifier] = named
                }
            }
        }
    }
}
