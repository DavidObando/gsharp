// <copyright file="SemanticLookup.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.LanguageServer.Protocol
import System
import System.Collections
import System.Collections.Concurrent
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import System.Runtime.CompilerServices
import System.Threading
import System.Threading.Tasks
import SystemObject = System.Object

shared class SemanticLookup {
    /// Describes the hovered call's receiver syntax so the same-named imported
    /// method scan can be disambiguated by dispatch shape (issue #906).
    enum CallReceiverGate {
        None,
        Value,
        TypeName
    }

    /// ADR-0106: per-tree collected syntax nodes that the model build and
    /// reference index need. Memoized by (cref:SyntaxTree) instance so an
    /// edit only recollects the changed file's nodes (see `GetNodeBuckets`).
    internal class NodeBuckets {
        init() {
            Functions = List[FunctionDeclarationSyntax]()
            Constructors = List[ConstructorDeclarationSyntax]()
            Structs = List[StructDeclarationSyntax]()
            Accessors = List[AccessorExpressionSyntax]()
            FieldAssignments = List[FieldAssignmentExpressionSyntax]()
            ForRanges = List[ForRangeStatementSyntax]()
            AwaitForRanges = List[AwaitForRangeStatementSyntax]()
            WhileLets = List[WhileLetStatementSyntax]()
            IfLets = List[SyntaxNode]()
            VariableDeclarations = List[VariableDeclarationSyntax]()
            TypeAliasDeclarations = List[TypeAliasDeclarationSyntax]()
        }

        prop Functions List[FunctionDeclarationSyntax] {
            get;
        }

        prop Constructors List[ConstructorDeclarationSyntax] {
            get;
        }

        prop Structs List[StructDeclarationSyntax] {
            get;
        }

        prop Accessors List[AccessorExpressionSyntax] {
            get;
        }

        prop FieldAssignments List[FieldAssignmentExpressionSyntax] {
            get;
        }

        prop ForRanges List[ForRangeStatementSyntax] {
            get;
        }

        prop AwaitForRanges List[AwaitForRangeStatementSyntax] {
            get;
        }

        prop WhileLets List[WhileLetStatementSyntax] {
            get;
        }

        /// Issue #4961 / ADR-0201: the `if let` statements and expressions
        /// ((cref:IfLetStatementSyntax) / (cref:IfLetExpressionSyntax)).
        prop IfLets List[SyntaxNode] {
            get;
        }

        prop VariableDeclarations List[VariableDeclarationSyntax] {
            get;
        }

        prop TypeAliasDeclarations List[TypeAliasDeclarationSyntax] {
            get;
        }
    }

    internal class SemanticModel {
        private let compilation Compilation
        private let declarations Dictionary[SyntaxToken, Symbol]
        private let declarationsBySpan Dictionary[(FileName string, SpanStart int32, SpanEnd int32), Symbol]
        private let globals Dictionary[string, Symbol]
        private let localDeclarations Dictionary[SyntaxNode, Dictionary[string, Symbol]]
        private let referencesLock object = SystemObject()
        private var referencesIndex Dictionary[Symbol, List[SyntaxToken]]?
        private let canonicalMembers ConcurrentDictionary[SyntaxNode, Symbol] = ConcurrentDictionary[
            SyntaxNode,
            Symbol
        ](ReferenceEqualityComparer.Instance)

        // Cached tree-walk results. Resolve's fallback path used to call
        // FindNodes<FunctionDeclarationSyntax> and FindNodes<StructDeclarationSyntax>
        // for *every* unresolved token, re-walking every tree on each call. With
        // many tokens (and FindReferences calling Resolve per token, per member,
        // per CodeLens request) this dominated request latency. Precomputing the
        // per-tree node lists in BuildModelUncached makes those fallback paths
        // O(number of decls), not O(number of nodes across the workspace).
        // Per-file views keyed by file name. The Resolve fallback runs FindContainingFunction /
        // ResolveImplicitThisMember for *every* identifier token in *every* tree when the reference
        // index is built (CodeLens / FindReferences). Iterating a whole-workspace flat list per
        // token is O(tokens x decls) and took ~145s to build the index on a 54-file project.
        // Bucketing by file makes each token scan only its own file's declarations. Keyed by file
        // name (not tree instance) so interpolation-hole tokens — whose re-parsed sub-tree shares
        // the file name and uses absolute spans — land in the right bucket.
        private var cachedFunctionsByFile Dictionary[string, []FunctionDeclarationSyntax]

        private var cachedConstructorsByFile Dictionary[string, []ConstructorDeclarationSyntax]
        private var cachedStructsByFile Dictionary[string, []StructDeclarationSyntax]
        private var cachedWhileLetsByFile Dictionary[string, []WhileLetStatementSyntax]
        private var cachedIfLetsByFile Dictionary[string, []SyntaxNode]
        // (file, identifier text) → that file's same-named local declarations,
        // for the region-scoped shadowing check.
        private var cachedVariableDeclarationsByName Dictionary[(string, string), []VariableDeclarationSyntax]
        private var cachedAccessorsByTree Dictionary[SyntaxTree, []AccessorExpressionSyntax]
        private var cachedFieldAssignmentsByTree Dictionary[SyntaxTree, []FieldAssignmentExpressionSyntax]
        private var cachedForRangesByTree Dictionary[SyntaxTree, []ForRangeStatementSyntax]
        private var cachedAwaitForRangesByTree Dictionary[SyntaxTree, []AwaitForRangeStatementSyntax]

        // (file, span) of every member-access identifier and field-assignment identifier. Resolve
        // runs ResolveAsMemberAccess + IsRightOfMemberAccess for *every* token; without this set
        // each non-member token (the vast majority) still scanned its file's accessors twice. An
        // O(1) span lookup lets non-member tokens bail out immediately, which is the dominant cost
        // of the reference-index build.
        private var memberAccessTokenSpans HashSet[(string, int32, int32)]

        private var fieldAssignmentTokenSpans HashSet[(string, int32, int32)]

        internal init(
            compilation Compilation,
            declarations Dictionary[SyntaxToken, Symbol],
            globals Dictionary[string, Symbol],
            localDeclarations Dictionary[SyntaxNode, Dictionary[string, Symbol]],
            bucketsByTree IReadOnlyDictionary[SyntaxTree, NodeBuckets]
        ) {
            this.compilation = compilation
            this.declarations = declarations
            this.globals = globals
            this.localDeclarations = localDeclarations
            // Build a (file, span) → Symbol index in parallel with the reference-equality map.
            // When a caller passes a SyntaxToken from a tree the compilation no longer holds
            // (e.g. the project has since been reparsed by a diagnostic pull while a cached
            // DocumentContent still references the prior tree), token identity diverges but
            // the file path and span are stable across re-parses of identical source — so a
            // span-based fallback recovers the correct symbol.
            this.declarationsBySpan = Dictionary[(string, int32, int32), Symbol](declarations.Count)
            for pair in declarations {
                let key = SpanKey(pair.Key)
                if (key != nil) {
                    this.declarationsBySpan[key] = pair.Value
                }
            }
            // Per-tree node lists. Resolve's fallback chain and the reference index need
            // function/struct/accessor/field-assignment/for-range nodes. ADR-0106: these are
            // computed once per SyntaxTree instance and memoized (see GetNodeBuckets), so an
            // edit only re-walks the changed file's tree; here we just project the supplied
            // (already-cached) per-tree buckets into the lookup tables.
            let treeArray = this.compilation.SyntaxTrees.ToArray()
            let buckets = [treeArray.Length]NodeBuckets
            for var i = 0; i < treeArray.Length; i++ {
                buckets[i] = if bucketsByTree.TryGetValue(treeArray[i], out var b) {
                    b
                } else {
                    SemanticLookup.GetNodeBuckets(treeArray[i], useCache: false)
                }
            }
            this.cachedAccessorsByTree = Dictionary[SyntaxTree, []AccessorExpressionSyntax](treeArray.Length)
            this.cachedFieldAssignmentsByTree = Dictionary[SyntaxTree, []FieldAssignmentExpressionSyntax](
                treeArray.Length
            )
            this.cachedForRangesByTree = Dictionary[SyntaxTree, []ForRangeStatementSyntax](treeArray.Length)
            this.cachedAwaitForRangesByTree = Dictionary[SyntaxTree, []AwaitForRangeStatementSyntax](treeArray.Length)
            let functionsByFile = Dictionary[string, List[FunctionDeclarationSyntax]]()
            let constructorsByFile = Dictionary[string, List[ConstructorDeclarationSyntax]]()
            let structsByFile = Dictionary[string, List[StructDeclarationSyntax]]()
            let whileLetsByFile = Dictionary[string, List[WhileLetStatementSyntax]]()
            let ifLetsByFile = Dictionary[string, List[SyntaxNode]]()
            let variableDeclarationsByName = Dictionary[(string, string), List[VariableDeclarationSyntax]]()
            this.memberAccessTokenSpans = HashSet[(string, int32, int32)]()
            this.fieldAssignmentTokenSpans = HashSet[(string, int32, int32)]()
            for var i = 0; i < treeArray.Length; i++ {
                let tree = treeArray[i]
                let bucket = buckets[i]
                this.cachedAccessorsByTree[tree] = bucket.Accessors.ToArray()
                this.cachedFieldAssignmentsByTree[tree] = bucket.FieldAssignments.ToArray()
                this.cachedForRangesByTree[tree] = bucket.ForRanges.ToArray()
                this.cachedAwaitForRangesByTree[tree] = bucket.AwaitForRanges.ToArray()
                let fileName = tree.Text?.FileName ?? string.Empty
                if bucket.Functions.Count > 0 {
                    if !functionsByFile.TryGetValue(fileName, out var fns) {
                        fns = List[FunctionDeclarationSyntax]()
                        functionsByFile[fileName] = fns
                    }
                    fns.AddRange(bucket.Functions)
                }
                if bucket.Constructors.Count > 0 {
                    if !constructorsByFile.TryGetValue(fileName, out var ctors) {
                        ctors = List[ConstructorDeclarationSyntax]()
                        constructorsByFile[fileName] = ctors
                    }
                    ctors.AddRange(bucket.Constructors)
                }
                if bucket.Structs.Count > 0 {
                    if !structsByFile.TryGetValue(fileName, out var sts) {
                        sts = List[StructDeclarationSyntax]()
                        structsByFile[fileName] = sts
                    }
                    sts.AddRange(bucket.Structs)
                }
                if bucket.WhileLets.Count > 0 {
                    if !whileLetsByFile.TryGetValue(fileName, out var whileLets) {
                        whileLets = List[WhileLetStatementSyntax]()
                        whileLetsByFile[fileName] = whileLets
                    }
                    whileLets.AddRange(bucket.WhileLets)
                }
                // Only files with region-scoped bindings need the shadowing check.
                if bucket.IfLets.Count > 0 || bucket.WhileLets.Count > 0 {
                    for declaration in bucket.VariableDeclarations {
                        if declaration.Identifier == nil {
                            continue
                        }
                        let nameKey = (fileName, declaration.Identifier.Text)
                        if !variableDeclarationsByName.TryGetValue(nameKey, out var sameNamed) {
                            sameNamed = List[VariableDeclarationSyntax]()
                            variableDeclarationsByName[nameKey] = sameNamed
                        }
                        sameNamed.Add(declaration)
                    }
                }
                if bucket.IfLets.Count > 0 {
                    if !ifLetsByFile.TryGetValue(fileName, out var ifLets) {
                        ifLets = List[SyntaxNode]()
                        ifLetsByFile[fileName] = ifLets
                    }
                    ifLets.AddRange(bucket.IfLets)
                }
                for accessor in bucket.Accessors {
                    for memberToken in EnumerateAccessorMemberTokens(accessor.RightPart) {
                        let key = SpanKey(memberToken)
                        if (key != nil) {
                            this.memberAccessTokenSpans.Add(key)
                        }
                    }
                }
                for assign in bucket.FieldAssignments {
                    let key = SpanKey(assign.FieldIdentifier)
                    if (key != nil) {
                        this.fieldAssignmentTokenSpans.Add(key)
                    }
                }
            }
            this.cachedFunctionsByFile = functionsByFile.ToDictionary(
                (kvp KeyValuePair[string, List[FunctionDeclarationSyntax]]) -> kvp.Key,
                (kvp KeyValuePair[string, List[FunctionDeclarationSyntax]]) -> kvp.Value.ToArray()
            )
            this.cachedConstructorsByFile = constructorsByFile.ToDictionary(
                (kvp KeyValuePair[string, List[ConstructorDeclarationSyntax]]) -> kvp.Key,
                (kvp KeyValuePair[string, List[ConstructorDeclarationSyntax]]) -> kvp.Value.ToArray()
            )
            this.cachedStructsByFile = structsByFile.ToDictionary(
                (kvp KeyValuePair[string, List[StructDeclarationSyntax]]) -> kvp.Key,
                (kvp KeyValuePair[string, List[StructDeclarationSyntax]]) -> kvp.Value.ToArray()
            )
            this.cachedWhileLetsByFile = whileLetsByFile.ToDictionary(
                (kvp KeyValuePair[string, List[WhileLetStatementSyntax]]) -> kvp.Key,
                (kvp KeyValuePair[string, List[WhileLetStatementSyntax]]) -> kvp.Value.ToArray()
            )
            this.cachedVariableDeclarationsByName = variableDeclarationsByName.ToDictionary(
                (kvp KeyValuePair[(string, string), List[VariableDeclarationSyntax]]) -> kvp.Key,
                (kvp KeyValuePair[(string, string), List[VariableDeclarationSyntax]]) -> kvp.Value.ToArray()
            )
            this.cachedIfLetsByFile = ifLetsByFile.ToDictionary(
                (kvp KeyValuePair[string, List[SyntaxNode]]) -> kvp.Key,
                (kvp KeyValuePair[string, List[SyntaxNode]]) -> kvp.Value.ToArray()
            )
        }

        /// Gets a snapshot of the global name → symbol map. ADR-0106 test hook.
        internal prop GlobalsSnapshot IReadOnlyDictionary[string, Symbol] -> this.globals

        func Resolve(token SyntaxToken) Symbol? {
            if this.declarations.TryGetValue(token, out var declared) {
                return declared
            }
            let spanKey = SpanKey(token)
            if (spanKey != nil) && this.declarationsBySpan.TryGetValue(spanKey!!, out var bySpan) {
                return bySpan
            }
            if token.IsMissing {
                return nil
            }
            // Issue #4989: what the binder bound the token to wins over every
            // syntactic fallback below. Those recompute a receiver's type from its
            // declaration, so they miss flow narrowing, interface members, and any
            // binding form they do not enumerate.
            let bound Symbol? = BoundSemantics.GetSymbol(this.compilation, token)
            if bound != nil {
                return bound
            }
            // Instance/static member access: when the token is the member identifier on the right
            // side of `receiver.Member` (AccessorExpressionSyntax) or the field identifier of
            // `receiver.Field = value` (FieldAssignmentExpressionSyntax), resolve the receiver's
            // type and look the member up on it. This runs *before* the by-name local/global
            // fallbacks so a member access never accidentally binds to a same-named local or
            // global (e.g. `person.Name` must never resolve to a top-level `Name`).
            let asMember Symbol? = this.ResolveAsMemberAccess(token)
            if asMember != nil {
                return asMember
            }
            if IsRightOfMemberAccess(token) {
                // Token is clearly a member name; do not fall through to by-name lookups.
                return nil
            }
            let scopedLocal Symbol? = this.ResolveRegionScopedLocal(token)
            if scopedLocal != nil {
                return scopedLocal
            }
            let function FunctionDeclarationSyntax? = this.FindContainingFunction(token)
            if function != nil && this.localDeclarations.TryGetValue(function, out var locals) && locals.TryGetValue(
                token.Text,
                out var local
            ) {
                return local
            }
            // Issue #894: a token inside an `init(...)` constructor body resolves
            // its parameters and body locals against the constructor's local
            // scope, mirroring the method-body path above.
            let constructor ConstructorDeclarationSyntax? = this.FindContainingConstructor(token)
            if constructor != nil && this.localDeclarations.TryGetValue(constructor, out var ctorLocals) &&
                ctorLocals.TryGetValue(token.Text, out var ctorLocal) {
                return ctorLocal
            }
            let loopLocal Symbol? = this.ResolveForRangeLoopLocal(token)
            if loopLocal != nil {
                return loopLocal
            }
            // Implicit-this member access: inside a class/struct method body, a bare identifier
            // like `Name` is bound by the binder as `this.Name` (see Binder + ImplicitProperty/
            // FieldVariableSymbol). Mirror that here so FindReferences, go-to-definition, rename,
            // and the CodeLens reference count include the implicit-this use sites — not just
            // explicit `this.Name` accesses.
            let implicitThis Symbol? = this.ResolveImplicitThisMember(token)
            if implicitThis != nil {
                return implicitThis
            }
            return if this.globals.TryGetValue(token.Text, out var global) {
                global
            } else {
                ResolvePrimitiveOrImportedType(token.Text)
            }
        }

        /// Returns one instance per member declaration, so references compare a
        /// member reached through a constructed generic type (a substituted
        /// copy that keeps the declaration) with the declaration itself.
        private func CanonicalMember(symbol Symbol?) Symbol? {
            if symbol == nil || symbol is not(FunctionSymbol or FieldSymbol or PropertySymbol or EventSymbol) {
                return symbol
            }
            let member Symbol = symbol
            let declarations = member.DeclaringSyntaxNodes
            return if declarations.IsDefaultOrEmpty {
                member
            } else {
                this.canonicalMembers.GetOrAdd(declarations[0], member)
            }
        }

        func GetLocals(declaration FunctionDeclarationSyntax?) IReadOnlyList[VariableSymbol] {
            if declaration != nil && this.localDeclarations.TryGetValue(declaration, out var locals) {
                return locals.Values.OfType[VariableSymbol]().ToList()
            }
            return Array.Empty[VariableSymbol]()
        }

        func GetReferences(target Symbol?, ct CancellationToken = default(CancellationToken)) IReadOnlyList[
            SyntaxToken
        ] {
            if target == nil {
                return Array.Empty[SyntaxToken]()
            }
            // Build the reverse `Symbol → List<SyntaxToken>` index lazily, on the
            // first call. Walking every identifier in every syntax tree (and
            // invoking the multi-tree-walk Resolve fallback chain on each) is
            // expensive; doing it once per compilation amortizes that cost across
            // every member's FindReferences call from CodeLensComputer.
            var index Dictionary[Symbol, List[SyntaxToken]]? = this.referencesIndex
            if index == nil {
                lock this.referencesLock {
                    if this.referencesIndex == nil {
                        this.referencesIndex = this.BuildReferencesIndex(ct)
                    }
                    index = this.referencesIndex
                }
            }
            let normalizedTarget Symbol? = this.CanonicalMember(NormalizeForReferences(target))
            if normalizedTarget == nil {
                return Array.Empty[SyntaxToken]()
            }
            return if index!!.TryGetValue(normalizedTarget, out var tokens) {
                cast[IReadOnlyList[SyntaxToken]](tokens)
            } else {
                cast[IReadOnlyList[SyntaxToken]](Array.Empty[SyntaxToken]())
            }
        }

        private func BuildReferencesIndex(ct CancellationToken = default(CancellationToken)) Dictionary[
            Symbol,
            List[SyntaxToken]
        ] {
            // Resolving every identifier token in the workspace is the dominant cost of the index
            // build (the only thing that touches the model is read-only — all lookup tables are
            // built once in the constructor — so the per-tree walks are independent). Resolve them
            // in parallel across trees, then merge the per-tree partials in tree order to preserve
            // a stable reference ordering.
            let trees = this.compilation.SyntaxTrees
            let partials = [trees.Length]Dictionary[Symbol, List[SyntaxToken]]
            // Parallel.For observes ct itself (aborting in-flight iterations with
            // OperationCanceledException) so a superseded hover/definition/references/
            // rename request aborts the cold whole-workspace index build instead of
            // running it to completion (issue #1662).
            Parallel.For(
                0,
                trees.Length,
                ParallelOptions{CancellationToken: ct},
                (i int32) -> {
                    let local = Dictionary[Symbol, List[SyntaxToken]]()
                    for token in SemanticLookup.EnumerateTokens(trees[i].Root) {
                        if token.IsMissing || token.Kind != SyntaxKind.IdentifierToken {
                            continue
                        }
                        let symbol Symbol? = this.CanonicalMember(NormalizeForReferences(this.Resolve(token)))
                        if symbol == nil {
                            continue
                        }
                        if !local.TryGetValue(symbol, out var list) {
                            list = List[SyntaxToken]()
                            local[symbol] = list
                        }
                        list.Add(token)
                    }
                    partials[i] = local
                }
            )
            let index = Dictionary[Symbol, List[SyntaxToken]]()
            for partial in partials {
                for pair in partial {
                    if !index.TryGetValue(pair.Key, out var list) {
                        list = List[SyntaxToken]()
                        index[pair.Key] = list
                    }
                    list.AddRange(pair.Value)
                }
            }
            return index
        }

        private func ResolveImplicitThisMember(token SyntaxToken) Symbol? {
            // Find the innermost struct method body that contains the token. We deliberately do
            // NOT pre-filter by StructDeclarationSyntax.Span: the parser sometimes reports a
            // struct's span as ending at an internal closing brace (e.g. the `}` of a `shared {}`
            // block) rather than the type's own `}`, so a span-containment check would wrongly
            // skip methods that live below that point. The method body span is what actually
            // matters for "is this token inside an instance method of a class".
            //
            // Shared-block methods are intentionally excluded — they're static and have no
            // implicit `this` receiver.
            var enclosing StructDeclarationSyntax? = nil
            var enclosingBodyLength = int32.MaxValue
            let fileName = token.SyntaxTree?.Text?.FileName ?? string.Empty
            if !this.cachedStructsByFile.TryGetValue(fileName, out var structs) {
                return nil
            }
            for decl in structs {
                for method in decl.Methods {
                    if method.Body == nil {
                        continue
                    }
                    if method.Body!!
                        .Span
                        .Start <= token
                        .Span
                        .Start &&
                        token
                        .Span
                        .End <= method.Body!!
                        .Span
                        .End &&
                        method.Body!!
                        .Span
                        .Length < enclosingBodyLength {
                        enclosing = decl
                        enclosingBodyLength = method.Body!!.Span.Length
                    }
                }
                // Issue #894: `init(...)` constructor bodies also have an implicit
                // `this` receiver, so a bare member reference (e.g. `Area = ...`)
                // inside a constructor must resolve to the class member just like
                // it does inside a method body.
                for constructor in decl.Constructors {
                    if constructor.Body == nil {
                        continue
                    }
                    if constructor
                        .Body
                        .Span
                        .Start <= token
                        .Span
                        .Start &&
                        token
                        .Span
                        .End <= constructor
                        .Body
                        .Span
                        .End &&
                        constructor
                        .Body
                        .Span
                        .Length < enclosingBodyLength {
                        enclosing = decl
                        enclosingBodyLength = constructor.Body.Span.Length
                    }
                }
            }
            if enclosing == nil {
                return nil
            }
            // Resolve the struct declaration to its symbol (this goes through the same
            // declarations/declarationsBySpan/globals chain, so it survives tree-reparse desyncs).
            if !(this.Resolve(enclosing.Identifier) is StructSymbol structSymbol) {
                return nil
            }
            return LookupMember(structSymbol, token.Text)
        }

        private func IsRightOfMemberAccess(token SyntaxToken) bool {
            // Cheap text-free check used to suppress fallback lookups. A token whose span is the
            // member identifier of an AccessorExpressionSyntax or the field identifier of a
            // FieldAssignmentExpressionSyntax is treated as a member name, and must not be
            // resolved by name as a local or global. Backed by the precomputed O(1) span sets.
            let spanKey = SpanKey(token)
            if !(spanKey != nil) {
                return false
            }
            return this.memberAccessTokenSpans.Contains(spanKey) || this.fieldAssignmentTokenSpans.Contains(spanKey)
        }

        private func ResolveAsMemberAccess(token SyntaxToken) Symbol? {
            if token?.SyntaxTree == nil || token.Kind != SyntaxKind.IdentifierToken {
                return nil
            }
            // A token physically lives in exactly one file, so its enclosing member-access
            // expression is in that same tree (or, for an interpolation hole, the hole's
            // re-parsed sub-tree which the token already points at). Scanning every compilation
            // tree here was both wrong (spans are per-file offsets) and O(tokens x all-accessors)
            // — it made the reference-index build take ~145s on a 54-file project.
            let tree = token.SyntaxTree
            // Fast path: the vast majority of tokens are not member-access targets. An O(1) span
            // check lets them bail out before scanning the file's accessors/assignments.
            let spanKey = SpanKey(token)
            if !(spanKey != nil) ||
                (
                !this.memberAccessTokenSpans.Contains(spanKey!!) && !this.fieldAssignmentTokenSpans.Contains(spanKey!!)
            ) {
                return nil
            }
            for accessor in this
                .GetAccessorsForTree(tree)
                .Where(
                (a AccessorExpressionSyntax) -> a
                    .RightPart
                    .Span
                    .Start <= token
                    .Span
                    .Start &&
                    token
                    .Span
                    .End <= a
                    .RightPart
                    .Span
                    .End
            )
                .OrderBy((a AccessorExpressionSyntax) -> a.Span.Length) {
                if TryDriveAccessorTarget(
                    tree,
                    accessor.RightPart,
                    accessor.LeftPart,
                    token,
                    out var receiverExpr,
                    out var memberName
                ) &&
                    receiverExpr != nil &&
                    memberName != nil {
                    let receiverType = this.ResolveReceiverTypeSymbol(tree, receiverExpr)
                    let member Symbol? = LookupTypeMember(receiverType, memberName)
                    if member != nil {
                        return member
                    }
                }
            }
            for assign in this.GetFieldAssignmentsForTree(tree) {
                if !TokenMatches(assign.FieldIdentifier, token) {
                    continue
                }
                let receiverType = AsTypeSymbol(this.Resolve(assign.Receiver))
                let member Symbol? = LookupTypeMember(receiverType, assign.FieldIdentifier.Text)
                if member != nil {
                    return member
                }
            }
            return nil
        }

        private func GetAccessorsForTree(tree SyntaxTree)[]AccessorExpressionSyntax {
            // The cache covers every tree currently in the compilation; trees that arrive
            // here from outside the compilation (a stale DocumentContent) fall back to a
            // one-off walk.
            return if this.cachedAccessorsByTree.TryGetValue(tree, out var cached) {
                cached
            } else {
                FindNodes[AccessorExpressionSyntax](tree.Root).ToArray()
            }
        }

        private func GetFieldAssignmentsForTree(tree SyntaxTree)[]FieldAssignmentExpressionSyntax {
            return if this.cachedFieldAssignmentsByTree.TryGetValue(tree, out var cached) {
                cached
            } else {
                FindNodes[FieldAssignmentExpressionSyntax](tree.Root).ToArray()
            }
        }

        private func ResolveReceiverTypeSymbol(tree SyntaxTree, expression ExpressionSyntax) TypeSymbol? {
            // Issue #4989: the receiver's bound (flow) type first.
            let boundType = BoundSemantics.GetExpressionType(this.compilation, expression)
            if boundType != nil {
                return boundType
            }
            switch expression {
                case name is NameExpressionSyntax {
                    return AsTypeSymbol(this.Resolve(name.IdentifierToken))
                }
                case call is CallExpressionSyntax {
                    return AsTypeSymbol(this.Resolve(call.Identifier))
                }
                case nested is AccessorExpressionSyntax {
                    let outerType TypeSymbol? = this.ResolveReceiverTypeSymbol(tree, nested.LeftPart)
                    if outerType == nil {
                        return nil
                    }
                    if !TryGetMemberName(nested.RightPart, out var intermediateName) {
                        return nil
                    }
                    if intermediateName == nil {
                        return nil
                    }
                    let member = LookupTypeMember(outerType, intermediateName)
                    return switch member {
                        case property is PropertySymbol: property.Type as TypeSymbol
                        case field is FieldSymbol: field.Type as TypeSymbol
                        case fn is FunctionSymbol: fn.Type as TypeSymbol
                        default: default(TypeSymbol?)
                    }
                }
                default {
                    return nil
                }
            }
        }

        private func FindContainingFunction(token SyntaxToken) FunctionDeclarationSyntax? {
            var best FunctionDeclarationSyntax? = nil
            var bestLength = int32.MaxValue
            let fileName = token.SyntaxTree?.Text?.FileName ?? string.Empty
            if !this.cachedFunctionsByFile.TryGetValue(fileName, out var functions) {
                return nil
            }
            for f in functions {
                if f.Span.Start <= token.Span.Start && token.Span.End <= f.Span.End && f.Span.Length < bestLength {
                    best = f
                    bestLength = f.Span.Length
                }
            }
            return best
        }

        private func FindContainingConstructor(token SyntaxToken) ConstructorDeclarationSyntax? {
            var best ConstructorDeclarationSyntax? = nil
            var bestLength = int32.MaxValue
            let fileName = token.SyntaxTree?.Text?.FileName ?? string.Empty
            if !this.cachedConstructorsByFile.TryGetValue(fileName, out var constructors) {
                return nil
            }
            for c in constructors {
                if c.Span.Start <= token.Span.Start && token.Span.End <= c.Span.End && c.Span.Length < bestLength {
                    best = c
                    bestLength = c.Span.Length
                }
            }
            return best
        }

        /// Issue #4961 / ADR-0201: resolves a use of an `if let` binding (either
        /// form). A binding is in scope from the end of its own clause — so in
        /// later initializers and the guard — through the end of the
        /// then-region, never in the else branch. The innermost such region
        /// wins, which also makes a later same-named binding shadow an earlier
        /// one.
        private func ResolveIfLetLocal(token SyntaxToken)(Symbol Symbol?, RegionStart int32, RegionLength int32) {
            var best Symbol? = nil
            var bestRegionStart = 0
            var bestRegionLength = int32.MaxValue
            if token?.SyntaxTree == nil {
                return (nil, 0, bestRegionLength)
            }
            let fileName = token.SyntaxTree.Text?.FileName ?? string.Empty
            if !this.cachedIfLetsByFile.TryGetValue(fileName, out var ifLets) {
                return (nil, 0, bestRegionLength)
            }
            for node in ifLets {
                var thenEnd = 0
                if node is IfLetStatementSyntax statement {
                    thenEnd = statement.ThenStatement.Span.End
                } else if node is IfLetExpressionSyntax expression {
                    thenEnd = expression.ThenBlock.Span.End
                } else {
                    continue
                }
                for binding in GetIfLetBindings(node) {
                    let regionStart = binding.Span.End
                    if token
                        .Span
                        .Start < regionStart ||
                        thenEnd < token
                        .Span
                        .End ||
                        thenEnd - regionStart >= bestRegionLength {
                        continue
                    }
                    if binding.Identifier == nil || !string.Equals(
                        binding.Identifier.Text,
                        token.Text,
                        StringComparison.Ordinal
                    ) {
                        continue
                    }
                    let symbol Symbol? = this.Resolve(binding.Identifier)
                    if symbol != nil {
                        best = symbol
                        bestRegionStart = regionStart
                        bestRegionLength = thenEnd - regionStart
                    }
                }
            }
            return (best, bestRegionStart, bestRegionLength)
        }

        /// Issue #4961 / ADR-0201: resolves a use of a region-scoped binding
        /// (`if let` in either form, or `while let`), choosing the innermost
        /// region across both kinds so `if let v … { while let v … { v } }`
        /// and the opposite nesting both pick the inner binding. An ordinary
        /// local of the same name declared inside that region, earlier, in a
        /// block that encloses the use shadows the binding; the lookup then
        /// defers to the by-name local path, which resolves that local.
        private func ResolveRegionScopedLocal(token SyntaxToken) Symbol? {
            let ifLet = this.ResolveIfLetLocal(token)
            let whileLet = this.ResolveWhileLetLoopLocal(token)
            let (symbol, regionStart, regionLength) = if whileLet.Symbol != nil &&
                (ifLet.Symbol == nil || whileLet.RegionLength < ifLet.RegionLength) {
                (whileLet.Symbol, whileLet.RegionStart, whileLet.RegionLength)
            } else {
                (ifLet.Symbol, ifLet.RegionStart, ifLet.RegionLength)
            }
            if symbol == nil {
                return nil
            }
            // A `for … in` / `await for` loop variable of the same name in a
            // narrower region is the binding in effect; defer to the existing
            // lookup path, which resolves loop variables.
            let forRange = this.ResolveForRangeLoopLocalRegion(token)
            if forRange.Symbol != nil && forRange.RegionLength < regionLength {
                return nil
            }
            if this.IsShadowedByNestedLocal(token, regionStart) {
                return nil
            }
            return symbol
        }

        /// The node whose span is the lexical scope of a local declaration: an
        /// `if` / `for` header initializer is scoped to its whole statement
        /// (or if-expression), and any other declaration to its nearest
        /// enclosing statement block or block expression.
        private func DeclarationScope(declaration VariableDeclarationSyntax) SyntaxNode? {
            var child SyntaxNode = declaration
            var node SyntaxNode? = declaration.Parent
            while node is SyntaxNode current {
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
                    case ifExpression is IfExpressionSyntax when object.ReferenceEquals(
                        ifExpression.Initializer,
                        child
                    ) {
                        return ifExpression
                    }
                    case forClause is ForClauseStatementSyntax when object.ReferenceEquals(
                        forClause.Initializer,
                        child
                    ) {
                        return forClause
                    }
                    default { }
                }
                child = current
                node = current.Parent
            }
            return nil
        }

        private func IsShadowedByNestedLocal(token SyntaxToken, regionStart int32) bool {
            let fileName = token.SyntaxTree?.Text?.FileName ?? string.Empty
            if !this.cachedVariableDeclarationsByName.TryGetValue((fileName, token.Text), out var declarations) {
                return false
            }
            for declaration in declarations {
                if declaration.Span.Start < regionStart || token.Span.Start < declaration.Span.End {
                    continue
                }
                let declarationScope SyntaxNode? = DeclarationScope(declaration)
                if declarationScope != nil &&
                    declarationScope
                    .Span
                    .Start <= token
                    .Span
                    .Start &&
                    token
                    .Span
                    .End <= declarationScope
                    .Span
                    .End {
                    return true
                }
            }
            return false
        }

        private func ResolveWhileLetLoopLocal(token SyntaxToken)(
            Symbol Symbol?,
            RegionStart int32,
            RegionLength int32
        ) {
            var best Symbol? = nil
            var bestRegionStart = 0
            var bestSpanLength = int32.MaxValue
            if token?.SyntaxTree == nil {
                return (nil, 0, bestSpanLength)
            }
            for statement in this.GetWhileLetsForToken(token) {
                if statement.Body == nil ||
                    token
                    .Span
                    .Start < statement
                    .Body
                    .Span
                    .Start ||
                    statement
                    .Body
                    .Span
                    .End < token
                    .Span
                    .End ||
                    statement
                    .Body
                    .Span
                    .Length >= bestSpanLength {
                    continue
                }
                for binding in statement.Bindings {
                    if !string.Equals(binding.Identifier?.Text, token.Text, StringComparison.Ordinal) {
                        continue
                    }
                    let symbol Symbol? = if binding.Identifier == nil {
                        default(Symbol?)
                    } else {
                        this.Resolve(binding.Identifier)
                    }
                    if symbol != nil {
                        best = symbol
                        bestRegionStart = statement.Body.Span.Start
                        bestSpanLength = statement.Body.Span.Length
                    }
                }
            }
            return (best, bestRegionStart, bestSpanLength)
        }

        private func ResolveForRangeLoopLocal(token SyntaxToken) Symbol? -> this.ResolveForRangeLoopLocalRegion(token)
            .Symbol

        private func ResolveForRangeLoopLocalRegion(token SyntaxToken)(
            Symbol Symbol?,
            RegionStart int32,
            RegionLength int32
        ) {
            var best Symbol? = nil
            var bestRegionStart = 0
            var bestSpanLength = int32.MaxValue
            if token?.SyntaxTree == nil {
                return (nil, 0, bestSpanLength)
            }
            for statement in this.GetForRangesForTree(token.SyntaxTree) {
                if statement.Body == nil ||
                    token
                    .Span
                    .Start < statement
                    .Body
                    .Span
                    .Start ||
                    statement
                    .Body
                    .Span
                    .End < token
                    .Span
                    .End {
                    continue
                }
                if statement.SecondIdentifier != nil && string.Equals(
                    statement.FirstIdentifier?.Text,
                    token.Text,
                    StringComparison.Ordinal
                ) {
                    let keySymbol Symbol? = if statement.FirstIdentifier == nil {
                        default(Symbol?)
                    } else {
                        this.Resolve(statement.FirstIdentifier)
                    }
                    if keySymbol != nil && statement.Body.Span.Length < bestSpanLength {
                        best = keySymbol
                        bestRegionStart = statement.Body.Span.Start
                        bestSpanLength = statement.Body.Span.Length
                    }
                }
                let valueIdentifier SyntaxToken? = statement.SecondIdentifier ?? statement.FirstIdentifier
                if !string.Equals(valueIdentifier?.Text, token.Text, StringComparison.Ordinal) {
                    continue
                }
                let valueSymbol Symbol? = if valueIdentifier == nil {
                    default(Symbol?)
                } else {
                    this.Resolve(valueIdentifier)
                }
                if valueSymbol != nil && statement.Body.Span.Length < bestSpanLength {
                    best = valueSymbol
                    bestRegionStart = statement.Body.Span.Start
                    bestSpanLength = statement.Body.Span.Length
                }
            }
            for statement in this.GetAwaitForRangesForTree(token.SyntaxTree) {
                if statement.Body == nil ||
                    token
                    .Span
                    .Start < statement
                    .Body
                    .Span
                    .Start ||
                    statement
                    .Body
                    .Span
                    .End < token
                    .Span
                    .End ||
                    !string.Equals(statement.Identifier?.Text, token.Text, StringComparison.Ordinal) {
                    continue
                }
                let valueSymbol Symbol? = if statement.Identifier == nil {
                    default(Symbol?)
                } else {
                    this.Resolve(statement.Identifier)
                }
                if valueSymbol != nil && statement.Body.Span.Length < bestSpanLength {
                    best = valueSymbol
                    bestRegionStart = statement.Body.Span.Start
                    bestSpanLength = statement.Body.Span.Length
                }
            }
            return (best, bestRegionStart, bestSpanLength)
        }

        private func GetForRangesForTree(tree SyntaxTree)[]ForRangeStatementSyntax {
            return if this.cachedForRangesByTree.TryGetValue(tree, out var cached) {
                cached
            } else {
                FindNodes[ForRangeStatementSyntax](tree.Root).ToArray()
            }
        }

        private func GetAwaitForRangesForTree(tree SyntaxTree)[]AwaitForRangeStatementSyntax {
            return if this.cachedAwaitForRangesByTree.TryGetValue(tree, out var cached) {
                cached
            } else {
                FindNodes[AwaitForRangeStatementSyntax](tree.Root).ToArray()
            }
        }

        private func GetWhileLetsForToken(token SyntaxToken)[]WhileLetStatementSyntax {
            let fileName = token.SyntaxTree?.Text?.FileName ?? string.Empty
            return if this.cachedWhileLetsByFile.TryGetValue(fileName, out var cached) {
                cached
            } else {
                Array.Empty[WhileLetStatementSyntax]()
            }
        }

        private func ResolvePrimitiveOrImportedType(text string) Symbol? {
            return switch text {
                case "bool": TypeSymbol.Bool
                case "int32": TypeSymbol.Int32
                case "string": TypeSymbol.String
                case "void": TypeSymbol.Void
                default: default(TypeSymbol?)
            }
        }

        shared {
            private func NormalizeForReferences(symbol Symbol?) Symbol? -> switch symbol {
                case s is StructSymbol: cast[Symbol](s.Definition ?? s)
                case e is EnumSymbol: cast[Symbol](e.Definition ?? e)
                case i is InterfaceSymbol: cast[Symbol](i.Definition ?? i)
                default: symbol
            }

            private func SpanKey(token SyntaxToken?)(FileName string, SpanStart int32, SpanEnd int32)? {
                if token == nil || token.SyntaxTree?.Text == nil {
                    return nil
                }
                return (token.SyntaxTree.Text.FileName ?? string.Empty, token.Span.Start, token.Span.End)
            }

            private func EnumerateAccessorMemberTokens(rightPart ExpressionSyntax) sequence[SyntaxToken] {
                switch rightPart {
                    case name is NameExpressionSyntax {
                        yield name.IdentifierToken
                    }
                    case call is CallExpressionSyntax {
                        yield call.Identifier
                    }
                    case index is IndexExpressionSyntax {
                        for t in EnumerateAccessorMemberTokens(index.Target) {
                            yield t
                        }
                    }
                    case nested is AccessorExpressionSyntax {
                        for t in EnumerateAccessorMemberTokens(nested.LeftPart) {
                            yield t
                        }
                        for t in EnumerateAccessorMemberTokens(nested.RightPart) {
                            yield t
                        }
                    }
                }
            }

            private func LookupMember(structSymbol StructSymbol, memberName string) Symbol? {
                // ADR-0112: shared canonical member lookup (see TypeMemberModel).
                return TypeMemberModel.LookupMember(structSymbol, memberName, MemberQuery.All)
            }

            private func TokenMatches(candidate SyntaxToken?, token SyntaxToken?) bool {
                if object.ReferenceEquals(candidate, token) {
                    return true
                }
                return candidate != nil &&
                    token != nil &&
                    candidate
                    .Span
                    .Start == token
                    .Span
                    .Start &&
                    candidate
                    .Span
                    .End == token
                    .Span
                    .End &&
                    string.Equals(candidate.Text, token.Text, StringComparison.Ordinal)
            }

            private func AccessorRightContainsMemberToken(rightPart ExpressionSyntax, token SyntaxToken) bool {
                switch rightPart {
                    case name is NameExpressionSyntax {
                        return TokenMatches(name.IdentifierToken, token)
                    }
                    case call is CallExpressionSyntax {
                        return TokenMatches(call.Identifier, token)
                    }
                    case nested is AccessorExpressionSyntax {
                        return AccessorRightContainsMemberToken(nested.LeftPart, token) ||
                            AccessorRightContainsMemberToken(nested.RightPart, token)
                    }
                    default {
                        return false
                    }
                }
            }

            private func TryDriveAccessorTarget(
                tree SyntaxTree,
                expression ExpressionSyntax,
                receiver ExpressionSyntax,
                token SyntaxToken,
                out receiverExpression ExpressionSyntax?,
                out memberName string?
            ) bool {
                receiverExpression = nil
                memberName = nil
                switch expression {
                    case name is NameExpressionSyntax when TokenMatches(name.IdentifierToken, token) {
                        receiverExpression = receiver
                        memberName = name.IdentifierToken.Text
                        return true
                    }
                    case call is CallExpressionSyntax when TokenMatches(call.Identifier, token) {
                        receiverExpression = receiver
                        memberName = call.Identifier.Text
                        return true
                    }
                    case nested is AccessorExpressionSyntax {
                        if TryDriveAccessorTarget(
                            tree,
                            nested.LeftPart,
                            receiver,
                            token,
                            out receiverExpression,
                            out memberName
                        ) {
                            return true
                        }
                        let nestedReceiver = AccessorExpressionSyntax(tree, receiver, nested.DotToken, nested.LeftPart)
                        return TryDriveAccessorTarget(
                            tree,
                            nested.RightPart,
                            nestedReceiver,
                            token,
                            out receiverExpression,
                            out memberName
                        )
                    }
                    default {
                        return false
                    }
                }
            }

            private func TryGetMemberName(expression ExpressionSyntax, out memberName string?) bool {
                memberName = switch expression {
                    case name is NameExpressionSyntax: name.IdentifierToken.Text
                    case call is CallExpressionSyntax: call.Identifier.Text
                    default: default(string?)
                }
                return memberName != nil
            }

            private func AsTypeSymbol(symbol Symbol?) TypeSymbol? {
                return switch symbol {
                    case t is TypeSymbol: t
                    case v is VariableSymbol: v.Type
                    case f is FunctionSymbol: f.Type
                    case p is PropertySymbol: p.Type
                    case fld is FieldSymbol: fld.Type
                    default: default(TypeSymbol?)
                }
            }

            private func LookupTypeMember(receiverType TypeSymbol?, memberName string) Symbol? {
                switch receiverType {
                    case structSymbol is StructSymbol {
                        return LookupMember(structSymbol, memberName)
                    }
                    case enumSymbol is EnumSymbol {
                        return enumSymbol.Members.FirstOrDefault((m EnumMemberSymbol) -> m.Name == memberName)
                    }
                    default {
                        return nil
                    }
                }
            }
        }
    }

    // Cache the SemanticModel per Compilation. BuildModel iterates every global
    // symbol and re-binds every function/method body (via Compilation.BoundProgram),
    // which is expensive — hundreds of milliseconds on projects with large reference
    // graphs. Every LSP request that needs symbol info (hover, definition, references,
    // semantic tokens, code lens, inlay hints) routes through here, so without this
    // cache the user pays that cost per request. The cache key is the Compilation
    // itself; because each file edit constructs a fresh Compilation (see
    // ProjectState.GetCompilation), invalidation is automatic and the old entry
    // becomes unreachable so the ConditionalWeakTable frees it.
    private let ModelCache ConditionalWeakTable[Compilation, SemanticModel] = ConditionalWeakTable[
        Compilation,
        SemanticModel
    ]()

    // ADR-0106 — incremental SemanticModel build. The per-edit cost of building
    // the model was dominated by two whole-project walks: collecting syntax
    // nodes from every tree (SemanticModel constructor) and matching bound
    // locals to syntax identifiers for every body (MapLocalVariables, a
    // reflection-based FindBoundNodes walk). Both are pure functions of an
    // instance-stable input — a SyntaxTree for the former, a lowered
    // BoundBlockStatement for the latter — so memoize them by that instance.
    //
    // On a single-file edit, ProjectState.UpdateFile replaces only the edited
    // file's SyntaxTree (every other tree keeps its instance), and ADR-0105's
    // BoundBodyCache serves every unchanged file's body as the same instance.
    // Keying on instance identity therefore yields automatic cache hits for all
    // 53 unchanged files and a miss (recompute) only for the edited file, with
    // no need to thread the previous model: a changed file gets fresh instances
    // and so naturally recomputes. ConditionalWeakTable frees entries once the
    // old trees/bodies become unreachable after the edit.
    private let NodeBucketCache ConditionalWeakTable[SyntaxTree, NodeBuckets] = ConditionalWeakTable[
        SyntaxTree,
        NodeBuckets
    ]()

    private let FunctionLocalsCache ConditionalWeakTable[
        BoundBlockStatement,
        IReadOnlyList[(Identifier SyntaxToken, Variable Symbol)]
    ] = ConditionalWeakTable[BoundBlockStatement, IReadOnlyList[(Identifier SyntaxToken, Variable Symbol)]]()
    private let LocalFunctionReferencesCache ConditionalWeakTable[
        BoundNode,
        IReadOnlyList[(Identifier SyntaxToken, Function Symbol)]
    ] = ConditionalWeakTable[BoundNode, IReadOnlyList[(Identifier SyntaxToken, Function Symbol)]]()

    // Diagnostics counters (used by tests to assert the incremental path reuses
    // unchanged files rather than re-walking them).
    private var nodeBucketCacheHits int64

    private var nodeBucketCacheMisses int64
    private var functionLocalsCacheHits int64
    private var functionLocalsCacheMisses int64

    /// Gets the node-bucket memo (hit, miss) counts. Test hook for ADR-0106.
    internal prop NodeBucketCacheStats(Hits int64, Misses int64) {
        get -> (Interlocked.Read(&nodeBucketCacheHits), Interlocked.Read(&nodeBucketCacheMisses))
    }

    /// Gets the per-body local memo (hit, miss) counts. Test hook for ADR-0106.
    internal prop FunctionLocalsCacheStats(Hits int64, Misses int64) {
        get -> (Interlocked.Read(&functionLocalsCacheHits), Interlocked.Read(&functionLocalsCacheMisses))
    }

    func FindTokenAt(tree SyntaxTree, position int32) SyntaxToken? {
        var best SyntaxToken? = nil
        for token in EnumerateTokens(tree.Root) {
            // Issue #5277: a synthesized token is not written in source. It has a zero-width span at
            // the end of the token before it, so it must not win the caret there.
            if token.IsMissing || token.IsSynthesized {
                continue
            }
            if token.Span.Start <= position && position <= token.Span.End {
                if best == nil {
                    best = token
                    continue
                }
                // At a boundary the position is both the end of one token and the
                // start of the next. Editors bind the caret to the token that starts
                // there (right-biased, like Roslyn's FindToken), so prefer it; only
                // then fall back to the smallest enclosing token.
                let tokenStartsHere = token.Span.Start == position
                let bestStartsHere = best!!.Span.Start == position
                if tokenStartsHere && !bestStartsHere {
                    best = token
                } else if tokenStartsHere == bestStartsHere && token.Span.Length < best!!.Span.Length {
                    best = token
                }
            }
        }
        return best
    }

    func ResolveSymbol(
        compilation Compilation,
        identifierToken SyntaxToken?,
        ct CancellationToken = default(CancellationToken)
    ) Symbol? {
        if identifierToken == nil || identifierToken.IsMissing || identifierToken.Kind != SyntaxKind.IdentifierToken {
            return nil
        }
        let model = BuildModel(compilation, ct)
        return model.Resolve(identifierToken)
    }

    /// Issue #891 / #906: resolves the imported CLR method that an invoked call
    /// expression bound to. The lowered call nodes do not retain their
    /// originating syntax, so the match is by method name and arity (the
    /// extension-method form carries one extra leading parameter for the
    /// receiver). This returns the exact overload chosen by overload
    /// resolution — including generic extension methods such as LINQ
    /// `Single<TSource>` — so hover can show the invoked method rather
    /// than an unrelated type that merely shares its name (e.g.
    /// `System.Single`).
    ///
    /// Because the scan is program-wide (the call nodes carry no syntax to match
    /// on), two different calls that merely share a method name and argument
    /// count would otherwise be indistinguishable — e.g. the LINQ extension
    /// `report.Checks.Single(pred)` and an unrelated static
    /// `Assert.Single(collection)` elsewhere. The [`gate`](paramref)
    /// (derived from the hovered call's receiver syntax) and optional
    /// [`receiverClrType`](paramref) restrict the match to candidates whose
    /// dispatch shape and receiver type are consistent with the hovered call.
    /// @param compilation The compilation whose bound program is searched.
    /// @param methodName The invoked method's simple name.
    /// @param argumentCount The number of arguments at the call site.
    /// @param gate The hovered call's receiver dispatch shape.
    /// @param receiverClrType The hovered receiver's CLR type when known; used as a tie-breaker.
    /// @param method On success, the resolved CLR method.
    /// @param overloadCount On success, the number of same-named overloads on the declaring type.
    /// @returns `true` when an invoked imported method was found.
    func TryResolveInvokedImportedMethod(
        compilation Compilation?,
        methodName string,
        argumentCount int32,
        gate CallReceiverGate,
        receiverClrType Type?,
        out method MethodInfo?,
        out overloadCount int32
    ) bool {
        method = nil
        overloadCount = 0
        if compilation == nil || string.IsNullOrEmpty(methodName) {
            return false
        }
        var program BoundProgram
        try {
            program = compilation.BoundProgram
        } catch (InvalidOperationException) {
            return false
        }
        var firstGated MethodInfo? = nil
        for root in EnumerateBoundRoots(program) {
            if root == nil {
                continue
            }
            for node in FindBoundNodes[BoundNode](root) {
                let isInstance = node is BoundImportedInstanceCallExpression
                let candidate MethodInfo? = switch node {
                    case instanceCall is BoundImportedInstanceCallExpression: instanceCall.Method
                    case staticCall is BoundImportedCallExpression: staticCall.Function?.Method
                    default: default(MethodInfo?)
                }
                if candidate == nil || !string.Equals(candidate.Name, methodName, StringComparison.Ordinal) {
                    continue
                }
                // An instance/static call has one parameter per argument; an
                // imported extension method dispatched with receiver syntax has
                // one extra leading parameter (the receiver).
                let parameterCount = candidate.GetParameters().Length
                let isExtensionDispatched = !isInstance && parameterCount == argumentCount + 1
                let isExactArity = parameterCount == argumentCount
                if !isExactArity && !isExtensionDispatched {
                    continue
                }
                // Reject candidates whose dispatch shape is inconsistent with the
                // hovered call's receiver syntax (issue #906).
                switch gate {
                    case CallReceiverGate.Value when !(isInstance || isExtensionDispatched) {
                        // A value receiver (`x.M(...)`) cannot bind to a plain static method.
                        continue
                    }
                    case CallReceiverGate.TypeName when isInstance || isExtensionDispatched {
                        // A type-name receiver (`T.M(...)`) cannot bind to an instance or
                        // receiver-dispatched extension method.
                        continue
                    }
                    default { }
                }
                firstGated ??= candidate
                // When the receiver's CLR type is known, prefer the candidate whose
                // effective receiver type matches it. This disambiguates same-shaped
                // collisions (e.g. `.Single(...)` over two different element types).
                if receiverClrType != nil &&
                    IsReceiverTypeCompatible(candidate, isInstance, isExtensionDispatched, receiverClrType) {
                    method = candidate
                    overloadCount = CountSameNamedMethods(candidate)
                    return true
                }
            }
        }
        if firstGated != nil {
            method = firstGated
            overloadCount = CountSameNamedMethods(firstGated)
            return true
        }
        return false
    }

    /// Pre-builds the per-compilation `SemanticModel` and its references
    /// index. Intended for the workspace warm-up path so that the first
    /// user-facing CodeLens / hover / definition request returns from cache
    /// instead of paying the SemanticModel build cost.
    /// @param compilation The compilation to warm up.
    func WarmUp(compilation Compilation?) {
        if compilation == nil {
            return
        }
        let model = BuildModel(compilation)
        // Force the references index to be built. We don't care about the
        // result, only the side effect of populating the cache. Use a sentinel
        // global symbol so the call short-circuits on Symbol.null without
        // walking trees needlessly when the index is already built.
        for function in compilation.GlobalScope.Functions {
            let _ = model.GetReferences(function)
            break
        }
        // If the project has no functions at all, fall back to any struct so
        // the index gets built. (BuildReferencesIndex is invoked on the first
        // GetReferences call regardless of which symbol is queried.)
        if compilation.GlobalScope.Functions.Length == 0 {
            for s in compilation.GlobalScope.Structs {
                let _ = model.GetReferences(s)
                break
            }
        }
    }

    /// Computes the binding context for an expression at [`offset`](paramref):
    /// the enclosing function (or `null` at top level) and the
    /// locals/parameters in scope there. Used to speculatively infer receiver
    /// types for member completions on arbitrary expressions.
    /// @param compilation The compilation to inspect.
    /// @param tree The syntax tree the offset belongs to; scopes the function search to that file.
    /// @param offset The source offset of the expression.
    /// @returns The enclosing function symbol and the in-scope local symbols.
    func GetExpressionBindingContext(compilation Compilation, tree SyntaxTree?, offset int32)(
        Function FunctionSymbol?,
        Locals IReadOnlyList[VariableSymbol]
    ) {
        // Spans are per-file offsets; restrict the search to the supplied tree so a function
        // in another file can't be chosen by offset overlap in a multi-file compilation.
        let roots = if tree != nil {
            cast[IEnumerable[CompilationUnitSyntax]]([]CompilationUnitSyntax{tree.Root})
        } else {
            compilation.SyntaxTrees.Select((t SyntaxTree) -> t.Root)
        }
        let funcDecl FunctionDeclarationSyntax? = FindNodes[FunctionDeclarationSyntax](roots)
            .Where((f FunctionDeclarationSyntax) -> f.Span.Start <= offset && offset <= f.Span.End)
            .OrderBy((f FunctionDeclarationSyntax) -> f.Span.Length)
            .FirstOrDefault()
        if funcDecl == nil {
            // Top-level statements: globals are reachable through the parent scope.
            return (nil, Array.Empty[VariableSymbol]())
        }
        let function = FindFunctionSymbol(compilation, funcDecl)
        let locals = BuildModel(compilation).GetLocals(funcDecl)
        return (function, locals)
    }

    /// Resolves a bare type name (e.g. `Console`) to a CLR (cref:Type)
    /// reachable through the document's `import` declarations, the implicit
    /// `System` namespace, or a fully-qualified name.
    /// @param tree The syntax tree providing import context.
    /// @param compilation The compilation supplying the reference resolver.
    /// @param name The simple or aliased type name to resolve.
    /// @param includeAttributeSuffixFallback When `true`, also tries the C#-style
    /// `<name>Attribute` fallback (used for annotation hover, e.g. `@Obsolete`).
    /// @returns The resolved CLR type, or `null` when no match is found.
    func ResolveImportedClrType(
        tree SyntaxTree,
        compilation Compilation,
        name string,
        includeAttributeSuffixFallback bool = false
    ) Type? {
        if string.IsNullOrEmpty(name) {
            return nil
        }
        let resolver = compilation.References ?? ReferenceResolver.Default()
        for candidate in GetCandidateTypeNames(tree, name) {
            if resolver.TryResolveType(candidate, out var type) {
                return type
            }
        }
        if includeAttributeSuffixFallback && !name.EndsWith("Attribute", StringComparison.Ordinal) {
            for candidate in GetCandidateTypeNames(tree, name + "Attribute") {
                if resolver.TryResolveType(candidate, out var type) {
                    return type
                }
            }
        }
        return nil
    }

    func FindReferences(
        compilation Compilation,
        target Symbol?,
        ct CancellationToken = default(CancellationToken)
    ) IEnumerable[SyntaxToken] {
        if target == nil {
            return Array.Empty[SyntaxToken]()
        }
        // FindReferences is called once per member by CodeLensComputer. Without a
        // cache, every call walks every token in every syntax tree and re-resolves
        // each one — and each Resolve for a non-declaration token re-walks the
        // entire compilation looking for the containing function / enclosing
        // struct method (see SemanticModel.FindContainingFunction and
        // ResolveImplicitThisMember). On a small project with a handful of files
        // this still adds up to many seconds. Caching the reverse index on the
        // SemanticModel collapses N FindReferences calls into one walk.
        return BuildModel(compilation, ct).GetReferences(target, ct)
    }

    func IsValidIdentifier(text string) bool {
        if string.IsNullOrEmpty(text) || SyntaxFacts.GetKeywordKind(text) != SyntaxKind.IdentifierToken {
            return false
        }
        if !IsIdentifierStart(text[0]) {
            return false
        }
        for var i = 1; i < text.Length; i++ {
            if !IsIdentifierPart(text[i]) {
                return false
            }
        }
        return true
    }

    func CanRename(symbol Symbol?) bool {
        return symbol != nil &&
            !(symbol is ImportedTypeSymbol) &&
            !(symbol is ImportedClassSymbol) &&
            !(symbol is ImportedFunctionSymbol) &&
            !(symbol is TypeParameterSymbol) &&
            !object.ReferenceEquals(symbol, TypeSymbol.Bool) && !object.ReferenceEquals(symbol, TypeSymbol.Int32) &&
            !object.ReferenceEquals(symbol, TypeSymbol.String) && !object.ReferenceEquals(symbol, TypeSymbol.Void) &&
            !object.ReferenceEquals(symbol, TypeSymbol.Null)
    }

    func EnumerateIdentifierTokens(tree SyntaxTree) IEnumerable[SyntaxToken] {
        return EnumerateTokens(tree.Root).Where((t SyntaxToken) -> t.Kind == SyntaxKind.IdentifierToken)
    }

    func ToOffset(content DocumentContent, position Position) int32 {
        if position.Line < 0 || position.Line >= content.SyntaxTree.Text.Lines.Length {
            return content.SyntaxTree.Text.Length
        }
        return Math.Min(
            content.SyntaxTree.Text.Lines[position.Line].Start + position.Character,
            content.SyntaxTree.Text.Length
        )
    }

    func ToRange(token SyntaxToken) GSharp.LanguageServer.Protocol.Range {
        return ToRange(token.SyntaxTree.Text, token.Span)
    }

    func ToRange(text SourceText, span TextSpan) GSharp.LanguageServer.Protocol.Range {
        var span = span
        let startLine = text.GetLineIndex(span.Start)
        let endPosition = Math.Max(span.Start, span.End)
        var endLine = text.GetLineIndex(Math.Min(endPosition, Math.Max(0, text.Length - 1)))
        if span.End == text.Length && text.Length > 0 && text[text.Length - 1] == '\n' {
            endLine = text.Lines.Length - 1
        }
        return GSharp
            .LanguageServer
            .Protocol
            .Range(
            Position(startLine, span.Start - text.Lines[startLine].Start),
            Position(endLine, span.End - text.Lines[endLine].Start)
        )
    }

    /// ADR-0106 test hook: builds a (cref:SemanticModel) for
    /// [`compilation`](paramref), optionally bypassing the incremental memo
    /// caches so the result is a from-scratch oracle. Used by the equivalence
    /// tests to compare the incremental build against a full rebuild.
    /// @param compilation The compilation to build a model for.
    /// @param useIncrementalCaches Whether the instance-keyed memo caches are used.
    /// @returns The semantic model.
    internal func BuildModelForTest(compilation Compilation, useIncrementalCaches bool) SemanticModel {
        return BuildModelUncached(compilation, useIncrementalCaches)
    }

    /// Resets the ADR-0106 incremental-build memo counters. Test hook.
    internal func ResetIncrementalCacheCounters() {
        Interlocked.Exchange(&nodeBucketCacheHits, 0)
        Interlocked.Exchange(&nodeBucketCacheMisses, 0)
        Interlocked.Exchange(&functionLocalsCacheHits, 0)
        Interlocked.Exchange(&functionLocalsCacheMisses, 0)
    }

    internal func GetInitializerTarget(initializer CollectionInitializerExpressionSyntax) ExpressionSyntax? {
        var target ExpressionSyntax? = initializer.Target
        if target == nil {
            if initializer.Parent is FieldInitializerSyntax member &&
                member.Parent is MemberCollectionElementSyntax{
                Parent: CollectionInitializerExpressionSyntax owner
            } designator &&
                GetInitializerTarget(owner) is {} ownerTarget {
                return AccessorExpressionSyntax(
                    initializer.SyntaxTree,
                    ownerTarget,
                    designator.DotToken,
                    NameExpressionSyntax(initializer.SyntaxTree, member.FieldIdentifier)
                )
            }
            return nil
        }
        // Qualification lives outside the initializer in right-nested access
        // syntax. Keep that prefix, but not accesses on the initialized result.
        var current SyntaxNode = initializer
        while current.Parent is AccessorExpressionSyntax accessor {
            if object.ReferenceEquals(accessor.RightPart, current) {
                target = AccessorExpressionSyntax(initializer.SyntaxTree, accessor.LeftPart, accessor.DotToken, target)
            }
            current = accessor
        }
        return target!!
    }

    private func FindFunctionSymbol(compilation Compilation, declaration FunctionDeclarationSyntax) FunctionSymbol? {
        for function in compilation.GlobalScope.Functions {
            if object.ReferenceEquals(function.Declaration, declaration) {
                return function
            }
        }
        for structSym in compilation.GlobalScope.Structs {
            for method in structSym.Methods {
                if object.ReferenceEquals(method.Declaration, declaration) {
                    return method
                }
            }
            for method in structSym.StaticMethods {
                if object.ReferenceEquals(method.Declaration, declaration) {
                    return method
                }
            }
        }
        return nil
    }

    private func GetCandidateTypeNames(tree SyntaxTree, name string) sequence[string] {
        let seen = HashSet[string](StringComparer.Ordinal)
        for import_ in tree.Root.Members.OfType[ImportSyntax]() {
            // `import alias = System.Console` makes `alias` refer to the dotted path.
            if import_.AliasIdentifier != nil && import_.AliasIdentifier!!.Text == name {
                let aliased = string.Join(".", import_.Identifiers.Select((i SyntaxToken) -> i.Text))
                if !string.IsNullOrEmpty(aliased) && seen.Add(aliased) {
                    yield aliased
                }
                continue
            }
            // `import System` makes namespace `System` types reachable by simple name.
            let ns = string.Join(".", import_.Identifiers.Select((i SyntaxToken) -> i.Text))
            if !string.IsNullOrEmpty(ns) {
                let qualified = ns + "." + name
                if seen.Add(qualified) {
                    yield qualified
                }
            }
        }
        // Implicit System import and fully-qualified fallbacks.
        for candidate in[]string{"System." + name, name} {
            if seen.Add(candidate) {
                yield candidate
            }
        }
    }

    private func BuildModel(compilation Compilation, ct CancellationToken = default(CancellationToken)) SemanticModel {
        return ModelCache.GetValue(
            compilation,
            (c Compilation) -> BuildModelUncached(c, useIncrementalCaches: true, ct)
        )
    }

    /// ADR-0106: builds the per-compilation (cref:SemanticModel). When
    /// [`useIncrementalCaches`](paramref) is `true` the
    /// expensive per-file work (syntax-node collection and per-body local
    /// matching) is memoized by syntax-tree / bound-body <em>instance</em>, so a
    /// single-file edit only recomputes the changed file's buckets while every
    /// unchanged file is served from the memo. When `false` every
    /// file is recomputed from scratch; that path is the correctness oracle the
    /// equivalence tests compare against. Both paths are identical by
    /// construction because the memoized helpers are pure functions of their
    /// instance-stable inputs.
    /// @param compilation The compilation to build a model for.
    /// @param useIncrementalCaches Whether to read/write the instance-keyed memo caches.
    /// @param ct Token observed between per-file/per-struct build steps.
    /// @returns The semantic model.
    private func BuildModelUncached(
        compilation Compilation,
        useIncrementalCaches bool,
        ct CancellationToken = default(CancellationToken)
    ) SemanticModel {
        let trees = compilation.SyntaxTrees
        let bucketsByTree = Dictionary[SyntaxTree, NodeBuckets](trees.Length)
        for tree in trees {
            // Bucketing walks every node in the tree; check between files so a
            // superseded request (fast typing) aborts instead of running the
            // whole cold multi-file build to completion (issue #1662).
            ct.ThrowIfCancellationRequested()
            bucketsByTree[tree] = GetNodeBuckets(tree, useIncrementalCaches)
        }
        let declarations = Dictionary[SyntaxToken, Symbol]()
        let globals = Dictionary[string, Symbol](StringComparer.Ordinal)
        let localDeclarations = Dictionary[SyntaxNode, Dictionary[string, Symbol]]()
        for variable in compilation.GlobalScope.Variables {
            globals[variable.Name] = variable
        }
        for function in compilation.GlobalScope.Functions {
            globals[function.Name] = function
            if function.Declaration != nil {
                declarations[function.Declaration!!.Identifier] = function
                MapParameters(function.Declaration!!, function.Parameters, declarations, localDeclarations)
                MapTypeClauseReference(function.Declaration!!.Type, function.Type, declarations)
                // ADR-0182: an extension function's receiver clause is
                // source-visible too, but ExplicitReceiverParameter is only
                // populated for a true instance method (it also drives the
                // emitter's by-ref `this` handling, which does not apply to
                // an extension's by-value parameter zero) — fall back to the
                // always-present Parameters[0] so `r` in `func (r T) M()`
                // resolves for an extension exactly as it does for a method.
                let receiverParameter ParameterSymbol? = function.ExplicitReceiverParameter ??
                    (
                    if function.Declaration!!.Receiver != nil && function.Parameters.Length > 0 {
                        function.Parameters[0]
                    } else {
                        default(ParameterSymbol?)
                    }
                )
                if receiverParameter != nil && function.Declaration!!.Receiver != nil {
                    // ADR-0185: a receiver clause never comes from the
                    // destructured arrow-lambda path.
                    declarations[function.Declaration!!.Receiver!!.Identifier!!] = receiverParameter
                    GetLocals(localDeclarations, function.Declaration!!)[receiverParameter.Name] = receiverParameter
                }
            }
        }
        for variable in compilation.GlobalScope.Variables {
            for declaration in bucketsByTree
                .Values
                .SelectMany(
                func (b NodeBuckets) IEnumerable[VariableDeclarationSyntax] {
                    return b.VariableDeclarations
                }
            )
                .Where((v VariableDeclarationSyntax) -> v.Identifier.Text == variable.Name) {
                declarations[declaration.Identifier] = variable
            }
        }
        for aggregate in compilation.GlobalScope.Structs {
            // Per-struct member mapping below is O(members); check between structs
            // so cancellation lands within one cold build instead of after it.
            ct.ThrowIfCancellationRequested()
            globals[aggregate.Name] = aggregate
            if aggregate.Declaration != nil {
                declarations[aggregate.Declaration!!.Identifier] = aggregate
                for var i = 0; i < aggregate.Declaration!!.Fields.Length && i < aggregate.Fields.Length; i++ {
                    declarations[aggregate.Declaration!!.Fields[i].Identifier] = aggregate.Fields[i]
                    MapTypeClauseReference(
                        aggregate.Declaration!!.Fields[i].Type,
                        aggregate.Fields[i].Type,
                        declarations
                    )
                }
                var allPropertyIdentifiers = aggregate.Declaration!!.Properties.Select(
                    (p PropertyDeclarationSyntax) -> p.Identifier
                )
                var allEventIdentifiers = aggregate.Declaration!!.Events.Select(
                    (e EventDeclarationSyntax) -> e.Identifier
                )
                var allMethodIdentifiers = aggregate.Declaration!!.Methods.Select(
                    (m FunctionDeclarationSyntax) -> m.Identifier
                )
                if aggregate.Declaration!!.SharedBlock != nil {
                    allPropertyIdentifiers = allPropertyIdentifiers.Concat(
                        aggregate.Declaration!!.SharedBlock!!.Properties.Select(
                            (p PropertyDeclarationSyntax) -> p.Identifier
                        )
                    )
                    allEventIdentifiers = allEventIdentifiers.Concat(
                        aggregate.Declaration!!.SharedBlock!!.Events.Select((e EventDeclarationSyntax) -> e.Identifier)
                    )
                    allMethodIdentifiers = allMethodIdentifiers.Concat(
                        aggregate.Declaration!!.SharedBlock!!.Methods.Select(
                            (m FunctionDeclarationSyntax) -> m.Identifier
                        )
                    )
                    if !aggregate.StaticFields.IsDefaultOrEmpty {
                        for var si = 0;
                            si < aggregate.Declaration!!.SharedBlock!!
                            .Fields
                            .Length &&
                            si < aggregate
                            .StaticFields
                            .Length;
                            si++ {
                            let fieldId SyntaxToken? = aggregate.Declaration!!.SharedBlock!!.Fields[si].Identifier
                            if fieldId != nil {
                                declarations[fieldId] = aggregate.StaticFields[si]
                            }
                        }
                    }
                }
                MapMembersByName(
                    declarations,
                    allPropertyIdentifiers,
                    aggregate.Properties.Concat(aggregate.StaticProperties)
                )
                MapMembersByName(declarations, allEventIdentifiers, aggregate.Events.Concat(aggregate.StaticEvents))
                MapMembersByName(declarations, allMethodIdentifiers, aggregate.Methods.Concat(aggregate.StaticMethods))
                // Register parameters and implicit 'this' for struct/class methods
                // so that hover, go-to-definition, etc. work inside method bodies.
                for method in aggregate.Methods.Concat(aggregate.StaticMethods) {
                    if method.Declaration != nil {
                        MapParameters(method.Declaration!!, method.Parameters, declarations, localDeclarations)
                        MapTypeClauseReference(method.Declaration!!.Type, method.Type, declarations)
                        if method.ThisParameter != nil {
                            GetLocals(localDeclarations, method.Declaration!!)[
                                method.ThisParameter!!.Name
                            ] = method.ThisParameter!!
                        }
                    }
                }
                // Issue #894: register parameters and implicit 'this' for
                // user-defined `init(...)` constructors so that hover,
                // go-to-definition, etc. work inside constructor bodies exactly
                // as they do inside method bodies. The constructor body locals
                // themselves are matched in MapLocalVariables.
                for constructor in aggregate.ExplicitConstructors {
                    if constructor.Declaration != nil {
                        MapParameters(
                            constructor.Declaration!!,
                            constructor.Parameters,
                            declarations,
                            localDeclarations
                        )
                        if constructor.Function.ThisParameter != nil {
                            GetLocals(localDeclarations, constructor.Declaration!!)[
                                constructor.Function.ThisParameter!!.Name
                            ] = constructor
                                .Function
                                .ThisParameter!!
                        }
                    }
                }
            }
        }
        for iface in compilation.GlobalScope.Interfaces {
            globals[iface.Name] = iface
            if iface.Declaration != nil {
                declarations[iface.Declaration.Identifier] = iface
                MapMembersByName(
                    declarations,
                    iface.Declaration.Methods.Select((m FunctionDeclarationSyntax) -> m.Identifier),
                    iface.Methods
                )
                MapMembersByName(
                    declarations,
                    iface.Declaration.Properties.Select((p PropertyDeclarationSyntax) -> p.Identifier),
                    iface.Properties
                )
                MapMembersByName(
                    declarations,
                    iface.Declaration.Events.Select((e EventDeclarationSyntax) -> e.Identifier),
                    iface.Events
                )
            }
        }
        for import_ in compilation.GlobalScope.GetCumulativeImports() {
            if import_.Declaration?.AliasIdentifier is {} aliasIdentifier {
                declarations[aliasIdentifier] = import_
            }
        }
        for package_ in compilation.GlobalScope.Packages {
            if package_.Declaration == nil {
                continue
            }
            for identifier in package_.Declaration!!.Identifiers {
                declarations[identifier] = package_
            }
        }
        for pair in compilation.GlobalScope.TypeAliases {
            globals[pair.Key] = pair.Value
            if pair.Value is EnumSymbol enumSymbol {
                declarations[enumSymbol.Declaration.Identifier] = enumSymbol
                let members = enumSymbol.Declaration.Members.ToArray()
                for var i = 0; i < members.Length && i < enumSymbol.Members.Length; i++ {
                    declarations[members[i].Identifier] = enumSymbol.Members[i]
                    globals[members[i].Identifier.Text] = enumSymbol.Members[i]
                }
            }
        }
        // Register type alias declaration identifiers so code lenses can resolve them.
        for typeAliasSyntax in bucketsByTree.Values.SelectMany(
            func (b NodeBuckets) IEnumerable[TypeAliasDeclarationSyntax] {
                return b.TypeAliasDeclarations
            }
        ) {
            let aliasId SyntaxToken? = typeAliasSyntax.Identifier
            if aliasId != nil &&
                !aliasId.IsMissing &&
                compilation
                .GlobalScope
                .TypeAliases
                .TryGetValue(aliasId.Text, out var aliasedType) {
                declarations[aliasId] = aliasedType
            }
        }
        MapLocalVariables(compilation, declarations, localDeclarations, bucketsByTree, useIncrementalCaches)
        return SemanticModel(compilation, declarations, globals, localDeclarations, bucketsByTree)
    }

    private func MapMembersByName(
        declarations Dictionary[SyntaxToken, Symbol],
        identifiers IEnumerable[SyntaxToken],
        symbols IEnumerable[Symbol]
    ) {
        let byName = Dictionary[string, Symbol](StringComparer.Ordinal)
        for symbol in symbols {
            if symbol?.Name != nil {
                byName[symbol.Name] = symbol
            }
        }
        for identifier in identifiers {
            if identifier != nil && !identifier.IsMissing && byName.TryGetValue(identifier.Text, out var symbol) {
                declarations[identifier] = symbol
            }
        }
    }

    private func MapParameters(
        declaration FunctionDeclarationSyntax,
        parameters ImmutableArray[ParameterSymbol],
        declarations Dictionary[SyntaxToken, Symbol],
        localDeclarations Dictionary[SyntaxNode, Dictionary[string, Symbol]]
    ) {
        MapParametersCore(declaration, declaration.Parameters.ToArray(), parameters, declarations, localDeclarations)
    }

    private func MapParameters(
        declaration ConstructorDeclarationSyntax,
        parameters ImmutableArray[ParameterSymbol],
        declarations Dictionary[SyntaxToken, Symbol],
        localDeclarations Dictionary[SyntaxNode, Dictionary[string, Symbol]]
    ) {
        MapParametersCore(declaration, declaration.Parameters.ToArray(), parameters, declarations, localDeclarations)
    }

    private func MapParametersCore(
        $scope SyntaxNode,
        syntaxParameters[]ParameterSyntax,
        parameters ImmutableArray[ParameterSymbol],
        declarations Dictionary[SyntaxToken, Symbol],
        localDeclarations Dictionary[SyntaxNode, Dictionary[string, Symbol]]
    ) {
        let symbolIndex = parameters.Length - syntaxParameters.Length
        for var i = 0; i < syntaxParameters.Length && symbolIndex + i < parameters.Length; i++ {
            let symbol = parameters[symbolIndex + i]
            // ADR-0185: every MapParameters caller passes a named function's,
            // method's, or constructor's syntax parameters, never a
            // (possibly destructured) arrow-lambda's.
            declarations[syntaxParameters[i].Identifier!!] = symbol
            MapTypeClauseReference(syntaxParameters[i].Type, symbol.Type, declarations)
            GetLocals(localDeclarations, $scope)[symbol.Name] = symbol
        }
    }

    private func MapTypeClauseReference(
        typeClause TypeClauseSyntax?,
        type TypeSymbol?,
        declarations Dictionary[SyntaxToken, Symbol]
    ) {
        if typeClause == nil || type == nil {
            return
        }
        let wrappedTypes = if type is ImportedTypeSymbol {
            Array.Empty[TypeSymbol]()
        } else {
            TypeSymbol.GetWrappedTypes(type).ToArray()
        }
        if wrappedTypes.Length > 0 {
            let wrappedClauses = typeClause.GetChildren().OfType[TypeClauseSyntax]().ToArray()
            if typeClause.Identifier != nil || (wrappedTypes.Length == 1 && wrappedClauses.Length != 1) {
                MapTypeClauseReference(typeClause, wrappedTypes[0], declarations)
                return
            }
            for var i = 0; i < Math.Min(wrappedTypes.Length, wrappedClauses.Length); i++ {
                MapTypeClauseReference(wrappedClauses[i], wrappedTypes[i], declarations)
            }
            return
        }
        let identifier SyntaxToken? = if !typeClause.QualifierIdentifierTokens.IsDefaultOrEmpty {
            typeClause.QualifierIdentifierTokens[^1]
        } else {
            typeClause.Identifier
        }
        if identifier != nil {
            declarations[identifier] = type
        }
    }

    private func MapLocalVariables(
        compilation Compilation,
        declarations Dictionary[SyntaxToken, Symbol],
        localDeclarations Dictionary[SyntaxNode, Dictionary[string, Symbol]],
        bucketsByTree Dictionary[SyntaxTree, NodeBuckets],
        useIncrementalCaches bool
    ) {
        // Region-scoped bindings (`while let`, and since issue #4961 both
        // `if let` forms) resolve through their own region lookups, so they
        // must not enter the function-wide by-name local map.
        let whileLetIdentifiers = HashSet[SyntaxToken](
            bucketsByTree
                .Values
                .SelectMany(
                func (bucket NodeBuckets) IEnumerable[WhileLetStatementSyntax] {
                    return bucket.WhileLets
                }
            )
                .SelectMany(
                func (statement WhileLetStatementSyntax) IEnumerable[IfLetBindingClauseSyntax] {
                    return statement.Bindings
                }
            )
                .Concat(
                bucketsByTree.Values.SelectMany((bucket NodeBuckets) -> bucket.IfLets.SelectMany(GetIfLetBindings))
            )
                .Select((binding IfLetBindingClauseSyntax) -> binding.Identifier)
        )
        var program BoundProgram
        try {
            program = compilation.BoundProgram
        } catch (InvalidOperationException) {
            return
        }
        for root in EnumerateBoundRoots(program) {
            let references = if useIncrementalCaches {
                LocalFunctionReferencesCache.GetValue(root, MatchBoundLocalFunctions)
            } else {
                MatchBoundLocalFunctions(root)
            }
            for (identifier, function) in references {
                declarations[identifier] = function
            }
        }
        // Issue #894: constructor (`init`) bodies are keyed in
        // BoundProgram.Functions by a synthesized instance-method-shaped
        // FunctionSymbol whose Declaration is null (the declaring syntax is a
        // ConstructorDeclarationSyntax). Build a reverse map so we can resolve
        // constructor body locals against the constructor's body syntax exactly
        // like a method body.
        let constructorByFunction = Dictionary[FunctionSymbol, ConstructorDeclarationSyntax]()
        for aggregate in compilation.GlobalScope.Structs {
            for constructor in aggregate.ExplicitConstructors {
                if constructor.Declaration != nil && constructor.Function != nil {
                    constructorByFunction[constructor.Function] = constructor.Declaration!!
                }
            }
        }
        for pair in program.Functions {
            var scope_ SyntaxNode? = pair.Key.Declaration
            var bodySyntax BlockStatementSyntax? = pair.Key.Declaration?.Body
            if scope_ == nil && constructorByFunction.TryGetValue(pair.Key, out var constructorDeclaration) {
                scope_ = constructorDeclaration
                bodySyntax = constructorDeclaration.Body
            }
            if scope_ == nil || bodySyntax == nil {
                continue
            }
            // ADR-0106: matching bound locals to syntax identifiers walks the
            // lowered body (FindBoundNodes, reflection-based) and the body
            // syntax — the dominant per-edit cost across a whole project. The
            // result is a pure function of the lowered body instance (and its
            // backing syntax), which the BoundBodyCache reuses by reference for
            // unchanged files, so memoize it by that instance.
            let entries = GetFunctionLocals(bodySyntax, pair.Value, useIncrementalCaches)
            for (identifier, variable) in entries {
                declarations[identifier] = variable
                if !whileLetIdentifiers.Contains(identifier) {
                    GetLocals(localDeclarations, scope_)[variable.Name] = variable
                }
            }
        }
        if program.Statement != nil {
            // Top-level statements have no containing function entry in localDeclarations.
            // We still need loop-variable declaration mappings for for-range hover/reference
            // support in scripts. There is a single synthesized top-level body per
            // compilation; recompute it directly (the for-range syntax comes from the
            // cached per-tree buckets, so this stays cheap on large workspaces).
            let topLevelLoopIdentifiers = bucketsByTree
                .Values
                .SelectMany(
                func (b NodeBuckets) IEnumerable[ForRangeStatementSyntax] {
                    return b.ForRanges
                }
            )
                .SelectMany((f ForRangeStatementSyntax) -> EnumerateForRangeIdentifiers(f))
                .Concat(
                bucketsByTree
                    .Values
                    .SelectMany(
                    func (b NodeBuckets) IEnumerable[AwaitForRangeStatementSyntax] {
                        return b.AwaitForRanges
                    }
                )
                    .Select((f AwaitForRangeStatementSyntax) -> f.Identifier)
            )
                .Concat(
                bucketsByTree
                    .Values
                    .SelectMany(
                    func (b NodeBuckets) IEnumerable[WhileLetStatementSyntax] {
                        return b.WhileLets
                    }
                )
                    .SelectMany(
                    (statement WhileLetStatementSyntax) -> statement.Bindings.Select(
                        (binding IfLetBindingClauseSyntax) -> binding.Identifier
                    )
                )
            )
                .Concat(
                bucketsByTree
                    .Values
                    .SelectMany((b NodeBuckets) -> b.IfLets.SelectMany(GetIfLetBindings))
                    .Select((binding IfLetBindingClauseSyntax) -> binding.Identifier)
            )
            // Function-body identifiers must not consume a script local through
            // the matcher's by-name fallback, or replace their own exact mapping.
            for (identifier, variable) in MatchBoundLocals(
                program.Statement,
                topLevelLoopIdentifiers.Where((identifier SyntaxToken) -> !declarations.ContainsKey(identifier))
            ) {
                declarations[identifier] = variable
            }
        }
    }

    private func MatchBoundLocalFunctions(root BoundNode) IReadOnlyList[(Identifier SyntaxToken, Function Symbol)] {
        let result = List[(Identifier SyntaxToken, Function Symbol)]()
        // Use the binder's selected symbol, not a by-name approximation:
        // nested regions, overloads and calls before a region must agree.
        for node in FindBoundNodes[BoundNode](root) {
            if node is BoundLocalFunctionDeclaration local &&
                local
                .Literal
                .Function
                .LocalDeclaration is {} declaration {
                result.Add((declaration.Identifier, local.Literal.Function))
            } else if node is BoundCallExpression call &&
                call
                .Function
                .LocalDeclaration != nil &&
                call.Syntax is CallExpressionSyntax syntax {
                result.Add((syntax.Identifier, call.Function))
            }
        }
        return result
    }

    /// ADR-0106: returns the (syntax identifier → local variable symbol) pairs
    /// for a single member body, memoized by the lowered-body instance when
    /// [`useIncrementalCaches`](paramref) is set. Unchanged files reuse the
    /// same lowered body (served from the `BoundBodyCache`), so this is a
    /// memo hit; the edited file's body is a fresh instance, so it recomputes.
    private func GetFunctionLocals(
        bodySyntax BlockStatementSyntax,
        body BoundBlockStatement,
        useIncrementalCaches bool
    ) IReadOnlyList[(Identifier SyntaxToken, Variable Symbol)] {
        if !useIncrementalCaches {
            return ComputeFunctionLocals(bodySyntax, body)
        }
        if FunctionLocalsCache.TryGetValue(body, out var cached) {
            Interlocked.Increment(&functionLocalsCacheHits)
            return cached
        }
        Interlocked.Increment(&functionLocalsCacheMisses)
        return FunctionLocalsCache.GetValue(body, (_ BoundBlockStatement) -> ComputeFunctionLocals(bodySyntax, body))
    }

    private func ComputeFunctionLocals(bodySyntax BlockStatementSyntax, body BoundBlockStatement) IReadOnlyList[
        (Identifier SyntaxToken, Variable Symbol)
    ] {
        let syntaxLocalIdentifiers = FindNodes[VariableDeclarationSyntax]([]BlockStatementSyntax{bodySyntax})
            .Where((v VariableDeclarationSyntax) -> v.TypeParameterList == nil)
            .Select((v VariableDeclarationSyntax) -> v.Identifier)
            .Concat(
            FindNodes[ForRangeStatementSyntax]([]BlockStatementSyntax{bodySyntax}).SelectMany(
                (f ForRangeStatementSyntax) -> EnumerateForRangeIdentifiers(f)
            )
        )
            .Concat(
            FindNodes[AwaitForRangeStatementSyntax]([]BlockStatementSyntax{bodySyntax}).Select(
                (f AwaitForRangeStatementSyntax) -> f.Identifier
            )
        )
            .Concat(
            FindNodes[WhileLetStatementSyntax]([]BlockStatementSyntax{bodySyntax}).SelectMany(
                (statement WhileLetStatementSyntax) -> statement.Bindings.Select(
                    (binding IfLetBindingClauseSyntax) -> binding.Identifier
                )
            )
        )
            .Concat(
            FindNodes[IfLetStatementSyntax]([]BlockStatementSyntax{bodySyntax})
                .SelectMany(GetIfLetBindings)
                .Concat(
                FindNodes[IfLetExpressionSyntax]([]BlockStatementSyntax{bodySyntax}).SelectMany(GetIfLetBindings)
            )
                .Select((binding IfLetBindingClauseSyntax) -> binding.Identifier)
        )
            .Concat(
            FindNodes[TypePatternSyntax]([]BlockStatementSyntax{bodySyntax}).Select(
                (pattern TypePatternSyntax) -> pattern.BindingIdentifier
            )
        )
            .Concat(
            FindNodes[PropertyPatternSyntax]([]BlockStatementSyntax{bodySyntax}).Select(
                (pattern PropertyPatternSyntax) -> pattern.Designation
            )
        )
            .Concat(
            FindNodes[VarPatternSyntax]([]BlockStatementSyntax{bodySyntax}).Select(
                (pattern VarPatternSyntax) -> pattern.Designation
            )
        )
            .Concat(
            FindNodes[SlicePatternSyntax]([]BlockStatementSyntax{bodySyntax}).Select(
                (pattern SlicePatternSyntax) -> pattern.CaptureIdentifier
            )
        )
            .Concat(
            FindNodes[ForTupleRangeStatementSyntax]([]BlockStatementSyntax{bodySyntax}).SelectMany(
                func (f ForTupleRangeStatementSyntax) IEnumerable[SyntaxToken] {
                    return f.Identifiers
                }
            )
        )
            .Concat(
            FindNodes[LambdaExpressionSyntax]([]BlockStatementSyntax{bodySyntax}).SelectMany(
                EnumerateDestructuredLambdaParameterIdentifiers
            )
        )
            .OfType[SyntaxToken]()
        return MatchBoundLocals(body, syntaxLocalIdentifiers)
    }

    /// Issue #4961: the binding clauses of an `if let` statement or expression.
    private func GetIfLetBindings(node SyntaxNode) IEnumerable[IfLetBindingClauseSyntax] {
        return switch node {
            case statement is IfLetStatementSyntax: statement.Bindings
            case expression is IfLetExpressionSyntax: expression.Bindings
            default: Enumerable.Empty[IfLetBindingClauseSyntax]()
        }
    }

    private func EnumerateDestructuredLambdaParameterIdentifiers(lambda LambdaExpressionSyntax) sequence[SyntaxToken] {
        for parameter in lambda.Parameters {
            if parameter.DeconstructionPattern is not{} pattern {
                continue
            }
            for element in pattern.Elements {
                if element.Identifier is {} identifier {
                    yield identifier
                }
            }
        }
    }

    private func EnumerateForRangeIdentifiers(syntax ForRangeStatementSyntax) sequence[SyntaxToken] {
        if syntax.FirstIdentifier != nil {
            yield syntax.FirstIdentifier
        }
        if syntax.SecondIdentifier != nil {
            yield syntax.SecondIdentifier!!
        }
    }

    private func MatchBoundLocals(boundRoot BoundNode, syntaxLocalIdentifiers IEnumerable[SyntaxToken]) IReadOnlyList[
        (Identifier SyntaxToken, Variable Symbol)
    ] {
        let boundDeclarations = FindBoundNodes[BoundVariableDeclaration](boundRoot)
            .Where((d BoundVariableDeclaration) -> !d.Variable.Name.StartsWith("<", StringComparison.Ordinal))
            .Select(
            (declaration BoundVariableDeclaration) -> (
                Variable: cast[Symbol](declaration.Variable),
                Syntax: cast[SyntaxNode?](declaration.Syntax)
            )
        )
            .Concat(FindBoundNodes[BoundPattern](boundRoot).SelectMany(GetPatternBindings))
            .ToList()
        let result = List[(Identifier SyntaxToken, Variable Symbol)]()
        let used = HashSet[int32]()
        for syntaxIdentifier in syntaxLocalIdentifiers.Where((id SyntaxToken) -> id != nil).OrderBy(
            (id SyntaxToken) -> id.Span.Start
        ) {
            let exactBindingIndex = boundDeclarations.FindIndex(
                (declaration(Variable Symbol, Syntax SyntaxNode?)) -> object.ReferenceEquals(
                    declaration.Item2,
                    syntaxIdentifier
                ) ||
                    (
                    declaration.Item2 is IfLetBindingClauseSyntax binding && object.ReferenceEquals(
                        binding.Identifier,
                        syntaxIdentifier
                    )
                )
            )
            if exactBindingIndex >= 0 && !used.Contains(exactBindingIndex) {
                used.Add(exactBindingIndex)
                result.Add((syntaxIdentifier, boundDeclarations[exactBindingIndex].Item1))
                continue
            }
            if syntaxIdentifier.Parent is IfLetBindingClauseSyntax {
                // A binding's name does not identify its region.
                continue
            }
            for var i = 0; i < boundDeclarations.Count; i++ {
                if used.Contains(i) || boundDeclarations[i].Item1.Name != syntaxIdentifier.Text {
                    continue
                }
                used.Add(i)
                result.Add((syntaxIdentifier, boundDeclarations[i].Item1))
                break
            }
        }
        return result
    }

    private func GetPatternBindings(pattern BoundPattern) sequence[(Variable Symbol, Syntax SyntaxNode?)] {
        switch pattern {
            case BoundDiscardPattern{Variable: not nil} varPattern {
                yield(varPattern.Variable!!, varPattern.Variable!!.DeclaringSyntax)
            }
            case BoundTypePattern{HasBinding: true} typePattern {
                yield(typePattern.Variable, typePattern.Variable.DeclaringSyntax)
            }
            case BoundSlicePattern{
                Variable: not nil,
                Syntax: SlicePatternSyntax{CaptureIdentifier: not nil}
            } slicePattern {
                yield(slicePattern.Variable!!, slicePattern.Variable!!.DeclaringSyntax)
            }
        }
    }

    private func GetLocals(
        locals Dictionary[SyntaxNode, Dictionary[string, Symbol]],
        declaration SyntaxNode
    ) Dictionary[string, Symbol] {
        if !locals.TryGetValue(declaration, out var functionLocals) {
            functionLocals = Dictionary[string, Symbol](StringComparer.Ordinal)
            locals[declaration] = functionLocals
        }
        return functionLocals
    }

    /// ADR-0106: returns the collected syntax-node buckets for
    /// [`tree`](paramref), memoized by the tree <em>instance</em> when
    /// [`useCache`](paramref) is set. Because `ProjectState.UpdateFile`
    /// only replaces the edited file's tree, every unchanged file keeps its
    /// instance and so hits this memo, turning the whole-project syntax walk
    /// into a single-file walk on a typical edit.
    /// @param tree The syntax tree to collect nodes for.
    /// @param useCache Whether to read/write the per-tree memo.
    /// @returns The collected node buckets.
    private func GetNodeBuckets(tree SyntaxTree, useCache bool) NodeBuckets {
        if !useCache {
            return CollectNodes(tree.Root)
        }
        if NodeBucketCache.TryGetValue(tree, out var cached) {
            Interlocked.Increment(&nodeBucketCacheHits)
            return cached
        }
        Interlocked.Increment(&nodeBucketCacheMisses)
        return NodeBucketCache.GetValue(tree, (t SyntaxTree) -> CollectNodes(t.Root))
    }

    private func CollectNodes(root SyntaxNode) NodeBuckets {
        let buckets = NodeBuckets()
        CollectNodes(root, buckets)
        return buckets
    }

    private func CollectNodes(node SyntaxNode, buckets NodeBuckets) {
        switch node {
            case f is FunctionDeclarationSyntax {
                buckets.Functions.Add(f)
            }
            case c is ConstructorDeclarationSyntax {
                buckets.Constructors.Add(c)
            }
            case s is StructDeclarationSyntax {
                buckets.Structs.Add(s)
            }
            case a is AccessorExpressionSyntax {
                buckets.Accessors.Add(a)
            }
            case fa is FieldAssignmentExpressionSyntax {
                buckets.FieldAssignments.Add(fa)
            }
            case fr is ForRangeStatementSyntax {
                buckets.ForRanges.Add(fr)
            }
            case afr is AwaitForRangeStatementSyntax {
                buckets.AwaitForRanges.Add(afr)
            }
            case whileLet is WhileLetStatementSyntax {
                buckets.WhileLets.Add(whileLet)
            }
            case ifLetStatement is IfLetStatementSyntax {
                buckets.IfLets.Add(ifLetStatement)
            }
            case ifLetExpression is IfLetExpressionSyntax {
                buckets.IfLets.Add(ifLetExpression)
            }
            case vd is VariableDeclarationSyntax {
                buckets.VariableDeclarations.Add(vd)
            }
            case ta is TypeAliasDeclarationSyntax {
                buckets.TypeAliasDeclarations.Add(ta)
            }
        }
        for child in node.GetChildren() {
            CollectNodes(child, buckets)
        }
    }

    private func EnumerateTokens(node SyntaxNode) sequence[SyntaxToken] {
        if node is SyntaxToken token {
            yield token
            yield break
        }
        for child in node.GetChildren() {
            for childToken in EnumerateTokens(child) {
                yield childToken
            }
        }
    }

    private func FindNodes[T SyntaxNode](roots IEnumerable[SyntaxNode]) sequence[T] {
        for root in roots {
            for node in FindNodes[T](root) {
                yield node
            }
        }
    }

    private func FindNodes[T SyntaxNode](root SyntaxNode) sequence[T] {
        if root is T matched {
            yield matched
        }
        for child in root.GetChildren() {
            for descendant in FindNodes[T](child) {
                yield descendant
            }
        }
    }

    private func FindBoundNodes[T BoundNode](root BoundNode) sequence[T] {
        if root is T matched {
            yield matched
        }
        for property in root.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance) {
            let value = property.GetValue(root)
            if value is BoundNode child {
                for descendant in FindBoundNodes[T](child) {
                    yield descendant
                }
            } else if (value is IEnumerable sequence_ and not string) {
                if IsDefaultImmutableArray(value) {
                    continue
                }
                for item in sequence_ {
                    if item is BoundNode sequenceChild {
                        for descendant in FindBoundNodes[T](sequenceChild) {
                            yield descendant
                        }
                    }
                }
            }
        }
    }

    private func IsDefaultImmutableArray(value object) bool {
        let type = value.GetType()
        if type.IsGenericType && type.GetGenericTypeDefinition().IsSameAs(
            typeof(System.Collections.Immutable.ImmutableArray[_])
        ) {
            let isDefault PropertyInfo? = type.GetProperty("IsDefault")
            return isDefault != nil && bool(isDefault.GetValue(value)!!)
        }
        return false
    }

    private func IsIdentifierStart(c char) bool {
        return c == '_' || char.IsLetter(c)
    }

    private func EnumerateBoundRoots(program BoundProgram?) sequence[BoundNode] {
        if program == nil {
            yield break
        }
        if program.Statement != nil {
            yield program.Statement
        }
        for body in program.Functions.Values {
            if body != nil {
                yield body
            }
        }
    }

    private func IsReceiverTypeCompatible(
        candidate MethodInfo,
        isInstance bool,
        isExtensionDispatched bool,
        receiverClrType Type
    ) bool {
        let effectiveReceiverType Type? = if isExtensionDispatched {
            candidate.GetParameters().FirstOrDefault()?.ParameterType
        } else {
            candidate.DeclaringType
        }
        if effectiveReceiverType == nil {
            return false
        }
        try {
            // Issue #4989: only a member the receiver's type can reach is a
            // match. A method declared on a SUBTYPE of the receiver's type is
            // never what the call bound to, so the reverse test is not made.
            if effectiveReceiverType.IsAssignableFrom(receiverClrType) {
                return true
            }
        } catch (NotSupportedException) {
            // MetadataLoadContext can throw for some open generic comparisons; fall back to name match.

        }
        // Generic/variance comparisons across a MetadataLoadContext are not always
        // resolvable via IsAssignableFrom; fall back to comparing the open generic
        // type identities so `IEnumerable<T>` matches `List<int>` etc.
        let receiverDefinition = if receiverClrType.IsGenericType {
            receiverClrType.GetGenericTypeDefinition()
        } else {
            receiverClrType
        }
        let candidateDefinition = if effectiveReceiverType.IsGenericType {
            effectiveReceiverType.GetGenericTypeDefinition()
        } else {
            effectiveReceiverType
        }
        return string.Equals(receiverDefinition.FullName, candidateDefinition.FullName, StringComparison.Ordinal)
    }

    internal func CountSameNamedMethods(method MethodInfo) int32 {
        let declaringType Type? = method.DeclaringType
        if declaringType == nil {
            return 1
        }
        let count = ClrTypeUtilities.SafeGetMethods(
            declaringType,
            BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance
        )
            .Count((m MethodInfo) -> string.Equals(m.Name, method.Name, StringComparison.Ordinal) && !m.IsSpecialName)
        return if count > 0 {
            count
        } else {
            1
        }
    }

    private func IsIdentifierPart(c char) bool {
        return c == '_' || char.IsLetterOrDigit(c)
    }
}
