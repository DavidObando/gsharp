// <copyright file="DocumentTranslationState.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.Collections.Generic
import System.Runtime.CompilerServices

/// The per-document MUTABLE working state of
/// (cref:CSharpToGSharpTranslator.DeclarationVisitor) (#1361 Wave 2, T-1).
/// The visitor's ctor-injected collaborators/inputs (`context`,
/// `typeMapper`, `subclassedBases`, `partialTypeParts`,
/// `staticUsingTargets`, `entryType`, and the two partial-mode flags)
/// remain on the visitor; everything that mutates <i>during</i> a document's
/// translation — the memoization caches, the suppression / pending sets, the
/// per-context scalars set-and-restored around nested scopes, and the monotonic
/// name counters — lives here. One instance is created per `DeclarationVisitor`,
/// matching the previous per-document field lifetime exactly.
///
/// The save/restore semantics around nested-type recursion and per-body scopes
/// are unchanged: a call site that saved a field to a local, set it, ran work,
/// and restored it now does the same against the corresponding property here.
/// Collection fields keep their original element types and equality comparers.
internal class DocumentTranslationState {
    init() {
        PatternBindings = Dictionary[ISymbol, GExpression](SymbolEqualityComparer.Default)
        MaterializedConversionResults = Dictionary[GExpression, IMethodSymbol](ReferenceEqualityComparer.Instance)
        NativePatternConditionCache = Dictionary[SyntaxNode, bool]()
        NativePatternVariables = HashSet[ISymbol](SymbolEqualityComparer.Default)
        NativePatternVariableAliases = Dictionary[ISymbol, string](SymbolEqualityComparer.Default)
        HoistedNullableGuardLocals = HashSet[ISymbol](SymbolEqualityComparer.Default)
        NullableForEachBindings = HashSet[ISymbol](SymbolEqualityComparer.Default)
        ProjectedQueryBindingType = Dictionary[ISymbol, ITypeSymbol](SymbolEqualityComparer.Default)
        ManagedReferenceArrayNullable = ManagedReferenceArrayNullableState()
        ManagedReferenceArrayProjectedCallsInProgress = HashSet[ExpressionSyntax](ReferenceEqualityComparer.Instance)
        ManagedReferenceArrayProjectionParentByCall = Dictionary[ExpressionSyntax, ExpressionSyntax](
            ReferenceEqualityComparer.Instance
        )
        ManagedReferenceArrayProjectionChildrenByCall = Dictionary[ExpressionSyntax, HashSet[ExpressionSyntax]](
            ReferenceEqualityComparer.Instance
        )
        ProjectionConsumersByBody = Dictionary[SyntaxNode, Dictionary[ISymbol, List[SyntaxNode]]](
            ReferenceEqualityComparer.Instance
        )
        ManagedReferenceArrayProjectedLocalTypeInProgress = HashSet[ILocalSymbol](SymbolEqualityComparer.Default)
        ProjectedCallableParameterType = Dictionary[IParameterSymbol, ITypeSymbol](SymbolEqualityComparer.Default)
        SuppressedPostfix = HashSet[SyntaxNode]()
        SuppressedAssignments = HashSet[SyntaxNode]()
        AssignmentValues = Dictionary[AssignmentExpressionSyntax, GExpression]()
        TupleAssignmentValues = Dictionary[TupleExpressionSyntax, GExpression]()
        HoistedExpressionValues = Dictionary[ExpressionSyntax, GExpression]()
        GuardCapturedFieldReads = Dictionary[ExpressionSyntax, string]()
        StaticFieldInitializers = Dictionary[ISymbol, GExpression](SymbolEqualityComparer.Default)
        SynthesizedPropertyBackingFieldNames = Dictionary[IPropertySymbol, string](SymbolEqualityComparer.Default)
        SymbolReassignedCache = Dictionary[(ISymbol?, SyntaxNode?), bool](SymbolScopeKeyComparer.Instance)
        UsedAsNullableCache = Dictionary[(ISymbol?, SyntaxNode?), bool](SymbolScopeKeyComparer.Instance)
        PendingTopLevelDeclarations = List[GMember]()
        DeconstructionTempNamesByBody = Dictionary[SyntaxNode, HashSet[string]]()
        SynthesizedLocalOccupiedNamesByBody = Dictionary[SyntaxNode, HashSet[string]]()
        GSharpNullablePatternReceivers = HashSet[GExpression](ReferenceEqualityComparer.Instance)
        BareCollectionPatternReceivers = HashSet[GExpression](ReferenceEqualityComparer.Instance)
        StablePatternMemberReads = HashSet[GExpression](ReferenceEqualityComparer.Instance)
        CollectionElementSlots = Dictionary[SyntaxNode, ITypeSymbol]()
        StoredPatternCaptures = HashSet[GExpression](ReferenceEqualityComparer.Instance)
        EmittedLocalGSharpNullability = Dictionary[ILocalSymbol, bool](SymbolEqualityComparer.Default)
        InferredLocalDefaultTypedDeclarations = Dictionary[ILocalSymbol, bool](SymbolEqualityComparer.Default)
        ConditionalElementReceivers = Dictionary[ElementBindingExpressionSyntax, GExpression]()
        ConditionalElementBindingReplacements = Dictionary[ElementBindingExpressionSyntax, GExpression]()
        LiftedStaticLocalFunctions = Dictionary[IMethodSymbol, string](SymbolEqualityComparer.Default)
        EmittedLiftedStaticLocalFunctions = HashSet[IMethodSymbol](SymbolEqualityComparer.Default)
        SyntheticLabelNames = Dictionary[SyntaxNode, string]()
        SyntheticLabelCounters = Dictionary[(Scope SyntaxNode?, Prefix string), int32]()
        LiftedRecursiveLocalFunctions = Dictionary[IMethodSymbol, LiftedRecursiveLocalFunction](
            SymbolEqualityComparer.Default
        )
        EmittedLiftedRecursiveLocalFunctions = HashSet[IMethodSymbol](SymbolEqualityComparer.Default)
        UnsupportedTopLevelRecursiveLocalFunctions = HashSet[IMethodSymbol](SymbolEqualityComparer.Default)
        UnsupportedRecursiveEnclosingTypeParameterLocalFunctions = HashSet[IMethodSymbol](
            SymbolEqualityComparer.Default
        )
        UnsupportedSuspendingRefCaptureLocalFunctions = HashSet[IMethodSymbol](SymbolEqualityComparer.Default)
        RecursiveLocalFunctionGroups = Dictionary[IMethodSymbol, RecursiveLocalFunctionGroup](
            SymbolEqualityComparer.Default
        )
        EmittedRecursiveGroupMembers = HashSet[IMethodSymbol](SymbolEqualityComparer.Default)
    }

    // While translating a switch-expression arm whose C# pattern bound a
    // variable through a property subpattern (`Circle { Radius: var r }`), the
    // bound variable has no G# pattern equivalent; it is rewritten to a member
    // access on the arm's type-pattern designator (`circle.Radius`). The map
    // from the bound local symbol to its replacement expression is consulted
    // by reference-translation (ADR-0115 §B switch lowering).
    prop PatternBindings Dictionary[ISymbol, GExpression] {
        get;
    }

    // Distinguish a converted-result assertion from an operator-input assertion.
    prop MaterializedConversionResults Dictionary[GExpression, IMethodSymbol] {
        get;
    }

    // ADR-0166 / issue #3409: memoized answer to "does this boolean condition
    // root translate its `is` designations as native G# pattern variables?",
    // keyed by the condition root syntax node. The statement/expression
    // dispatchers and TranslateIsPattern must agree, so both consult this.
    prop NativePatternConditionCache Dictionary[SyntaxNode, bool] {
        get;
    }

    // ADR-0166: C# pattern locals emitted as native G# pattern variables. G#
    // types them non-nullable and scopes them to the regions the C# reads live
    // in, so no read ever needs a `!!` — including reads after the `if` whose
    // scoped PatternBindings entry TranslateIf has already dropped.
    prop NativePatternVariables HashSet[ISymbol] {
        get;
    }

    // Temporary designator overrides used when a mutable C# pattern local is
    // first captured by an immutable native G# pattern variable, then copied
    // into its author-named `var` after an exiting guard.
    prop NativePatternVariableAliases Dictionary[ISymbol, string] {
        get;
    }

    // Pattern variables (`x is T t`) that <see cref="TryBuildPositiveGuardHoist"/>
    // materialised as a *nullable* G# local (`var t T? = scrutinee as T`). gsc
    // flow-narrows such a local for reads inside the `if t != nil { … }` guard,
    // but NOT for an assignment-LHS receiver (`t.Member = v`), so those writes
    // need an explicit `t!!`. Tracked because the C# semantic model reports the
    // pattern variable as the non-null `T`, which the read-side null-forgiveness
    // predicate would otherwise treat as not needing an assertion.
    prop HoistedNullableGuardLocals HashSet[ISymbol] {
        get;
    }

    // Active foreach/query bindings treated as nullable in G# assertion
    // decisions, whether from translated array widening or Roslyn's element
    // annotation.
    prop NullableForEachBindings HashSet[ISymbol] {
        get;
    }

    // Effective source-level type of query bindings after managed-reference
    // projection. Query range symbols do not expose a Type through Roslyn.
    prop ProjectedQueryBindingType Dictionary[ISymbol, ITypeSymbol] {
        get;
    }

    prop ManagedReferenceArrayNullable ManagedReferenceArrayNullableState {
        get;
    }

    prop ManagedReferenceArrayProjectedCallsInProgress HashSet[ExpressionSyntax] {
        get;
    }

    // Speculative nested projections enabled by an in-progress receiver
    // projection. If the receiver projection fails, these cached child
    // projections must be discarded with it.
    prop ManagedReferenceArrayProjectionParentByCall Dictionary[ExpressionSyntax, ExpressionSyntax] {
        get;
    }

    prop ManagedReferenceArrayProjectionChildrenByCall Dictionary[ExpressionSyntax, HashSet[ExpressionSyntax]] {
        get;
    }

    // Built once per translated body. Each entry maps a symbol to value uses,
    // member calls, and writes that can constrain its projected constructed type.
    prop ProjectionConsumersByBody Dictionary[SyntaxNode, Dictionary[ISymbol, List[SyntaxNode]]] {
        get;
    }

    prop ManagedReferenceArrayProjectedLocalTypeInProgress HashSet[ILocalSymbol] {
        get;
    }

    // Active lambda parameters whose emitted type comes from a projected
    // delegate Invoke signature rather than Roslyn's original target.
    prop ProjectedCallableParameterType Dictionary[IParameterSymbol, ITypeSymbol] {
        get;
    }

    // C# post-increment/decrement (`i++`, `i--`) sub-expressions that the
    // surrounding statement seam has hoisted into trailing `i++` statements
    // (G# models inc/dec as statements, not expressions; spec §Statements).
    // While a node is in this set, `TranslateExpression` renders it as a bare
    // read of its operand (the pre-increment value).
    prop SuppressedPostfix HashSet[SyntaxNode] {
        get;
    }

    // Value-position deconstruction assignments whose statement fallback has
    // already run. Ordinary, compound, and coalescing assignments now retain
    // their native expression position (ADR-0161 / issue #3347).
    prop SuppressedAssignments HashSet[SyntaxNode] {
        get;
    }

    // Exact result captured while flattening a chain that contains a
    // value-position deconstruction assignment.
    prop AssignmentValues Dictionary[AssignmentExpressionSyntax, GExpression] {
        get;
    }

    // Caches the G# value expression a value-position deconstruction
    // assignment (`(a, b) = (1, 2)` used as a value, not a bare statement)
    // was lowered to, keyed by its LHS tuple-target syntax node. Populated
    // once by <see cref="LowerTupleAssignmentForValue"/> when the write is
    // hoisted (see <see cref="FlattenChainedAssignment"/>); read back when
    // `TranslateExpression` later revisits the (now suppressed) assignment
    // node in its original position (issue #1974).
    prop TupleAssignmentValues Dictionary[TupleExpressionSyntax, GExpression] {
        get;
    }

    // Values captured before a nested deconstruction assignment is hoisted.
    // TranslateExpression substitutes these temps at their original positions
    // so C# left-to-right operand evaluation remains intact.
    prop HoistedExpressionValues Dictionary[ExpressionSyntax, GExpression] {
        get;
    }

    // Issue #4262 follow-up (item 2): C# reads of a field/property that an
    // early-return null guard earlier in the SAME block proves non-null,
    // rewritten to reference the local TranslateBlock/TranslateSwitchSectionBody
    // insert right after the guard (see
    // CSharpToGSharpTranslator.GuardedFieldLocalCapture.cs) instead of the
    // field itself — gsc narrows/needs nothing further for a plain local
    // read, so no per-use `!!` is required. The local's name is DERIVED from
    // the field/property's own name (lowercasing only its first letter),
    // never a synthetic `__identifier` (issue #3501's synthetic-identifier
    // reduction target) — a name collision skips the rewrite entirely rather
    // than inventing a suffixed alternative. Keyed by the exact C# syntax
    // node (mirroring HoistedExpressionValues); consulted by
    // TranslateExpression (substitutes the read) and by
    // GSharpExpressionIsStaticallyNonNull (silences the `!!` predicates that
    // would otherwise fire on the pre-rewrite field read).
    prop GuardCapturedFieldReads Dictionary[ExpressionSyntax, string] {
        get;
    }

    // Static-field initializers lifted out of a `static` constructor body
    // (`static T() { Field = value; }`). G# has no static constructor, so a
    // simple static ctor is folded into the corresponding `shared { }` field
    // initializers and the ctor itself is dropped (ADR-0115 §B.11).
    prop StaticFieldInitializers Dictionary[ISymbol, GExpression] {
        get;
    }

    // Issue #1907: a property using the C#14 `field` contextual keyword
    // (`get => field; set => field = ...;`) binds every `field` reference to
    // the compiler-synthesized backing field of THAT property, and any sibling
    // bodyless (auto) accessor on the same property shares the identical
    // field. G# has no synthesized-field surface (ADR-0051 computed
    // properties always name their own backing field explicitly), so one
    // real `var` field is synthesized per property that uses `field` and
    // every `field` reference/auto-accessor is rewritten to read/write it.
    // Keyed by property symbol so all accessors of the same property (get
    // AND set) resolve to the one synthesized name.
    prop SynthesizedPropertyBackingFieldNames Dictionary[IPropertySymbol, string] {
        get;
    }

    // Issue #1743: both <see cref="IsSymbolReassigned"/> and
    // <see cref="IsUsedAsNullable"/> answer a question that depends only on
    // (symbol, scope) — never on WHEN it's asked — yet each call re-walks
    // every descendant node of the scope (a whole method/type/body) looking
    // for it. A file with hundreds of field/property receiver checks was
    // rescanning its whole containing type hundreds of times
    // (O(accesses × type size)). Keyed on the (symbol, scope) pair rather
    // than the symbol alone: nothing here actually requires the extra scope
    // key today (see the two methods' own comments), but it costs nothing
    // and removes any doubt if a future caller ever passes a different scope
    // for the same symbol. Scoped to this translator instance: symbols/
    // scopes come from a specific `SemanticModel`/syntax tree, so even a
    // translator instance reused across documents/compilations (as some
    // tests do) never gets a stale cross-document hit — different
    // compilations produce different (non-equal) symbol/node instances.
    prop SymbolReassignedCache Dictionary[(Symbol ISymbol?, Scope SyntaxNode?), bool] {
        get;
    }

    prop UsedAsNullableCache Dictionary[(Symbol ISymbol?, Scope SyntaxNode?), bool] {
        get;
    }

    // Top-level declarations synthesized while translating an aggregate
    // (receiver-clause extensions and operators) are emitted as siblings.
    prop PendingTopLevelDeclarations List[GMember] {
        get;
    }

    // The syntax node whose body is currently being translated. It bounds the
    // data-flow scan that decides whether a local is mutable (var) or
    // immutable (let) per ADR-0115 §B.3.
    prop CurrentBodyScope SyntaxNode?

    // Source-derived local names already allocated while recursively lowering
    // tuple deconstruction, scoped by the active body so an unrelated earlier
    // method cannot cause suffix drift in a later one.
    prop DeconstructionTempNamesByBody Dictionary[SyntaxNode, HashSet[string]] {
        get;
    }

    // Emitted spellings occupied by source identifiers in each body. Building
    // this once avoids rescanning every token for every synthesized local.
    prop SynthesizedLocalOccupiedNamesByBody Dictionary[SyntaxNode, HashSet[string]] {
        get;
    }

    // Monotonic counter for synthesizing the hoist local when a loop condition
    // carries a binder-less side-effecting `is`-pattern clause (issue #914).
    prop LoopHoistCounter int32

    // The active statement-seam prologue (issue #1731): several lowerings
    // (lock targets, chained-assignment link targets, non-trivial pattern
    // scrutinees) must embed the SAME translated
    // operand at more than one output position; naively reusing the operand's
    // node would print — and so re-evaluate — it once per embed. `SpillOperand`
    // hoists such an operand into a fresh `let` appended here, evaluated
    // exactly once immediately before the statement currently being
    // translated (see <see cref="WithSpillSeam"/>). Expression-only callers
    // open an equivalent native block-expression seam. The value remains null
    // across a lambda/local-function boundary (its body is a distinct
    // evaluation scope; see <see cref="TranslateLambda"/> and
    // <see cref="TranslateLocalFunction"/>) so a hoist can never leak into an
    // unrelated enclosing scope.
    prop PendingSpillPrologue List[GStatement]?

    // Issue #4422: the G# diagnostic identifiers the statement currently being
    // translated must suppress, because a C# `!` that silenced a nullability
    // warning was dropped from a by-reference argument (`ref x!` becomes `&x`,
    // and gsc reports GS0612 where csc was told not to warn). Each statement
    // opens a fresh set and wraps its own output in the ADR-0175 block form;
    // an expression-bodied member collects into the member-level set instead.
    prop PendingStatementSuppressions HashSet[string]?

    // Storage for reordered out declarations belongs to the enclosing statement
    // or expression body, outside nested argument/null-guard evaluation seams.
    // Lambda/local-function boundaries suspend this declaration seam as well.
    prop FunctionArgumentOutDeclarations List[GStatement]?

    // A fallback pattern spill inside a conditionally evaluated short-circuit
    // operand declares its reusable temp in the enclosing expression's seam,
    // then assigns it inside the operand's block expression. This keeps the temp
    // visible to later pattern-variable reads without evaluating the scrutinee
    // before the guards that protect it.
    prop ShortCircuitSpillDeclarations List[GStatement]?

    // Issue #4356: pattern-lowering receivers (member reads, and the locals a
    // nested member is bound to) whose EMITTED G# type is a nullable reference
    // although their Roslyn type says otherwise — ADR-0169 analyzer-API members
    // such as `ParameterSyntax.Identifier` (a Roslyn `SyntaxToken` struct,
    // `SyntaxToken?` in G#). Keyed by node identity: the lowering passes the
    // same GExpression instance down to the nested test it builds.
    prop GSharpNullablePatternReceivers HashSet[GExpression] {
        get;
    }

    // Issue #4315: pattern-lowering member reads whose EMITTED G# type is a bare
    // (non-`?`) array/slice. gsc's sound empty-instance zero value makes such a
    // slot never nil, so a `!= nil` guard on it is the dead check GS0523 warns
    // about; every other reference member keeps its guard. Keyed by node identity
    // like GSharpNullablePatternReceivers.
    prop BareCollectionPatternReceivers HashSet[GExpression] {
        get;
    }

    // Issue #4315: pattern-lowering member reads that cannot run user code or
    // change between reads (a field, or an auto-property that is not virtual), so
    // a non-null member of this kind may be read by both the null guard and the
    // member tests without being bound to a local first.
    prop StablePatternMemberReads HashSet[GExpression] {
        get;
    }

    // Issue #4612: for each collection-expression element, the element (or
    // Add) type CoerceCollectionElement bound it to, so a bridge nested inside
    // the element (a forgiven `x!`) reports the slot the store really uses.
    prop CollectionElementSlots Dictionary[SyntaxNode, ITypeSymbol] {
        get;
    }

    // Issue #4356: `var` locals a nested nullable pattern member is STORED in
    // (so a designation's binding can read it after the test). A binding is
    // materialized after the test's block expression has finished, outside
    // the `!= nil` guard that narrowed the local, so every read BELOW the guard
    // — member tests and descendant bindings alike — goes through `local!!`.
    prop StoredPatternCaptures HashSet[GExpression] {
        get;
    }

    // Issue #4356: for each local cs2gs EMITTED, whether its G# type is `T?`
    // because of the ADR-0169 analyzer map (an untyped `let` inferred from
    // `parameter.Identifier` is `SyntaxToken?` although Roslyn types it as the
    // struct). Recorded where the local is emitted, from the initializer that
    // was actually emitted. A local with NO entry — a binding shape not hooked
    // here — is treated as nullable when its Roslyn type could be `T?` on the G#
    // side (RoslynAnalyzerApiMap.IsGSharpNullableCapableType), so a miss costs a
    // redundant `!!`, never a bare dereference of a `T?`.
    prop EmittedLocalGSharpNullability Dictionary[ILocalSymbol, bool] {
        get;
    }

    // Issue #4445: semantic/CFG default provenance is invariant per local and
    // can be queried repeatedly while lowering one declaration.
    prop InferredLocalDefaultTypedDeclarations Dictionary[ILocalSymbol, bool] {
        get;
    }

    // Outermost short-circuit operand currently redirecting fallback pattern
    // spills. Nested lambdas/local functions must not reuse its declaration seam.
    prop ShortCircuitSpillScope SyntaxNode?

    // Monotonic counter for synthesizing spill temporaries (issue #1731).
    prop SpillCounter int32

    // Monotonic counter for immutable pattern captures that seed mutable C#
    // switch-arm pattern locals.
    prop SwitchPatternCounter int32

    // True only while reusing the switch-pattern code model for a native
    // boolean `is` expression. Boolean type patterns omit switch designators
    // and can compose directly with property/positional constraints.
    prop TranslatingBooleanPattern bool

    // While rebuilding a static-helper receiver chained from `?.`, replace the
    // conditional-receiver placeholder with the already-guarded receiver so the
    // normal member-access translator still applies tuple/nullable/pointer and
    // extension-property rewrites to the rest of the chain.
    prop ConditionalReceiverReplacement GExpression?

    // Issue #2823: a redundant `?[i]` after an earlier conditional-access
    // segment whose own result is non-nullable becomes an ordinary dependent
    // `[i]`. Keying the replacement by the exact element binding prevents a
    // nested conditional access in the continuation from borrowing its receiver.
    prop ConditionalElementReceivers Dictionary[ElementBindingExpressionSyntax, GExpression] {
        get;
    }

    // Issue #3700: while re-splitting a `?[i]`-rooted continuation into a second
    // `?` seam, the element binding itself has already been emitted as the inner
    // seam's TARGET, so the rest of the chain must translate against the
    // conditional receiver instead of re-emitting the index.
    prop ConditionalElementBindingReplacements Dictionary[ElementBindingExpressionSyntax, GExpression] {
        get;
    }

    // Issue #1998: the query currently being lowered, set for the duration of
    // `TranslateQuery` — anchors the arity-cap diagnostic in
    // `BuildScopeParameter`.
    prop CurrentQueryNode QueryExpressionSyntax?

    // Instance helpers synthesized while translating the current aggregate.
    prop PendingInstanceSynthHelpers List[MethodDeclaration]?

    // Shared helpers synthesized from capture-free static local functions.
    prop PendingStaticSynthHelpers List[MethodDeclaration]?

    prop CurrentEmittedAggregate INamedTypeSymbol?

    prop LiftedStaticLocalFunctions Dictionary[IMethodSymbol, string] {
        get;
    }

    prop EmittedLiftedStaticLocalFunctions HashSet[IMethodSymbol] {
        get;
    }

    // Issue #3467: synthesized control-flow label names, allocated per
    // enclosing function body in first-use order instead of embedding the
    // syntax node's SpanStart. The node-keyed memo keeps the independent call
    // sites that must agree on a label (its definition and its gotos)
    // consistent; the counter map hands out the per-scope ordinals.
    prop SyntheticLabelNames Dictionary[SyntaxNode, string] {
        get;
    }

    prop SyntheticLabelCounters Dictionary[(Scope SyntaxNode?, Prefix string), int32] {
        get;
    }

    prop LiftedRecursiveLocalFunctions Dictionary[IMethodSymbol, LiftedRecursiveLocalFunction] {
        get;
    }

    prop EmittedLiftedRecursiveLocalFunctions HashSet[IMethodSymbol] {
        get;
    }

    prop UnsupportedTopLevelRecursiveLocalFunctions HashSet[IMethodSymbol] {
        get;
    }

    prop UnsupportedRecursiveEnclosingTypeParameterLocalFunctions HashSet[IMethodSymbol] {
        get;
    }

    prop UnsupportedSuspendingRefCaptureLocalFunctions HashSet[IMethodSymbol] {
        get;
    }

    // Issue #3399: local functions participating (directly or transitively) in
    // recursion/mutual recursion that cannot be lifted as static helpers
    // (they capture sibling locals), so G#'s non-recursive `let name = func …`
    // binding fails with GS0130/GS0125. Each such strongly-connected component
    // is instead lowered to G#'s nullable-function-local scheme: every member
    // is FIRST declared nil-initialized as `var Name (… -> R)? = nil` (G#
    // closures cannot forward-reference not-yet-declared siblings, so the whole
    // SCC's declarations must precede its first assignment), then each member
    // binds its function literal `Name = func …`; SCC partners are reached from
    // a closure body through the nullable local via a postfix null assertion
    // `Partner!!(…)` (ADR-0137/ADR-0069). Reference-capture semantics preserve
    // C#'s shared mutation of the captured locals.
    prop RecursiveLocalFunctionGroups Dictionary[IMethodSymbol, RecursiveLocalFunctionGroup] {
        get;
    }

    // Issue #3399: state-level dedup for the SCC declarations emission — the
    // first member translated for a group is the one that emits the shared
    // nil-initialized declarations; tracked by member symbol (not by group
    // instance) so re-registered copies of the same SCC cannot double-emit.
    prop EmittedRecursiveGroupMembers HashSet[IMethodSymbol] {
        get;
    }
}

internal class LiftedRecursiveLocalFunction {
    init(name string?, isStatic bool, captures IReadOnlyList[LiftedLocalFunctionCapture]) {
        Name = name
        IsStatic = isStatic
        Captures = captures
    }

    prop Name string? {
        get;
    }

    prop IsStatic bool {
        get;
    }

    prop Captures IReadOnlyList[LiftedLocalFunctionCapture] {
        get;
    }
}

internal class LiftedLocalFunctionCapture {
    init(symbol ISymbol, isByRef bool) {
        Symbol = symbol
        IsByRef = isByRef
    }

    prop Symbol ISymbol {
        get;
    }

    prop IsByRef bool {
        get;
    }
}

/// Issue #1743: equality for the (symbol, scope) cache key used by
/// `IsSymbolReassigned`/`IsUsedAsNullable`'s memoization
/// ((cref:DocumentTranslationState.SymbolReassignedCache) /
/// (cref:DocumentTranslationState.UsedAsNullableCache)). Symbols compare
/// via the Roslyn-recommended (cref:SymbolEqualityComparer.Default);
/// scope nodes compare by reference (the same `SyntaxNode` instance is what
/// every call site passes for a given symbol).
///
/// Issue #3399: the per-SCC emission state for the nullable-function-local
/// lowering of a capturing recursive C# local function (see
/// (cref:DocumentTranslationState.RecursiveLocalFunctionGroups)).
/// Member names and the shared nil-initialized declarations are resolved at
/// registration time; (cref:DeclarationsEmitted) lets the FIRST member
/// translated in document order emit the whole SCC's `var Name … = nil`
/// declarations ahead of its own `Name = func …` assignment (all declarations
/// must precede the first assignment, because a G# closure body cannot
/// reference a sibling local that is not yet declared).
internal class RecursiveLocalFunctionGroup {
    init(members IEnumerable[IMethodSymbol], names IReadOnlyList[string], declarations IReadOnlyList[GStatement]) {
        this.MemberNames = Dictionary[IMethodSymbol, string](SymbolEqualityComparer.Default)
        var index = 0
        for member in members {
            this.MemberNames[member] = names[index]
            index++
        }
        this.Members = HashSet[IMethodSymbol](this.MemberNames.Keys, SymbolEqualityComparer.Default)
        this.Declarations = declarations
    }

    prop Members HashSet[IMethodSymbol] {
        get;
    }

    prop MemberNames Dictionary[IMethodSymbol, string] {
        get;
    }

    prop Declarations IReadOnlyList[GStatement] {
        get;
    }

    prop DeclarationsEmitted bool

    func NameOf(symbol IMethodSymbol) string -> this.MemberNames[symbol]
}

internal class SymbolScopeKeyComparer : IEqualityComparer[(Symbol ISymbol, Scope SyntaxNode)] {
    func Equals(x(Symbol ISymbol, Scope SyntaxNode), y(Symbol ISymbol, Scope SyntaxNode)) bool -> SymbolEqualityComparer
        .Default
        .Equals(x.Symbol, y.Symbol) && object.ReferenceEquals(x.Scope, y.Scope)

    func GetHashCode(obj(Symbol ISymbol, Scope SyntaxNode)) int32 -> HashCode.Combine(
        SymbolEqualityComparer.Default.GetHashCode(obj.Symbol),
        RuntimeHelpers.GetHashCode(obj.Scope)
    )

    shared {
        let Instance SymbolScopeKeyComparer = SymbolScopeKeyComparer()
    }
}
