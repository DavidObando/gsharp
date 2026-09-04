// <copyright file="DocumentTranslationState.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using Cs2Gs.CodeModel.Ast;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Cs2Gs.Translator;

/// <summary>
/// The per-document MUTABLE working state of
/// <see cref="CSharpToGSharpTranslator.DeclarationVisitor"/> (#1361 Wave 2, T-1).
/// The visitor's ctor-injected collaborators/inputs (<c>context</c>,
/// <c>typeMapper</c>, <c>subclassedBases</c>, <c>partialTypeParts</c>,
/// <c>staticUsingTargets</c>, <c>entryType</c>, and the two partial-mode flags)
/// remain on the visitor; everything that mutates <i>during</i> a document's
/// translation — the memoization caches, the suppression / pending sets, the
/// per-context scalars set-and-restored around nested scopes, and the monotonic
/// name counters — lives here. One instance is created per <c>DeclarationVisitor</c>,
/// matching the previous per-document field lifetime exactly.
/// <para>
/// The save/restore semantics around nested-type recursion and per-body scopes
/// are unchanged: a call site that saved a field to a local, set it, ran work,
/// and restored it now does the same against the corresponding property here.
/// Collection fields keep their original element types and equality comparers.
/// </para>
/// </summary>
internal sealed class DocumentTranslationState
{
    // While translating a switch-expression arm whose C# pattern bound a
    // variable through a property subpattern (`Circle { Radius: var r }`), the
    // bound variable has no G# pattern equivalent; it is rewritten to a member
    // access on the arm's type-pattern designator (`circle.Radius`). The map
    // from the bound local symbol to its replacement expression is consulted
    // by reference-translation (ADR-0115 §B switch lowering).
    public Dictionary<ISymbol, GExpression> PatternBindings { get; } =
        new Dictionary<ISymbol, GExpression>(SymbolEqualityComparer.Default);

    // ADR-0166 / issue #3409: memoized answer to "does this boolean condition
    // root translate its `is` designations as native G# pattern variables?",
    // keyed by the condition root syntax node. The statement/expression
    // dispatchers and TranslateIsPattern must agree, so both consult this.
    public Dictionary<SyntaxNode, bool> NativePatternConditionCache { get; } =
        new Dictionary<SyntaxNode, bool>();

    // ADR-0166: C# pattern locals emitted as native G# pattern variables. G#
    // types them non-nullable and scopes them to the regions the C# reads live
    // in, so no read ever needs a `!!` — including reads after the `if` whose
    // scoped PatternBindings entry TranslateIf has already dropped.
    public HashSet<ISymbol> NativePatternVariables { get; } =
        new HashSet<ISymbol>(SymbolEqualityComparer.Default);

    // Temporary designator overrides used when a mutable C# pattern local is
    // first captured by an immutable native G# pattern variable, then copied
    // into its author-named `var` after an exiting guard.
    public Dictionary<ISymbol, string> NativePatternVariableAliases { get; } =
        new Dictionary<ISymbol, string>(SymbolEqualityComparer.Default);

    // Pattern variables (`x is T t`) that <see cref="TryBuildPositiveGuardHoist"/>
    // materialised as a *nullable* G# local (`var t T? = scrutinee as T`). gsc
    // flow-narrows such a local for reads inside the `if t != nil { … }` guard,
    // but NOT for an assignment-LHS receiver (`t.Member = v`), so those writes
    // need an explicit `t!!`. Tracked because the C# semantic model reports the
    // pattern variable as the non-null `T`, which the read-side null-forgiveness
    // predicate would otherwise treat as not needing an assertion.
    public HashSet<ISymbol> HoistedNullableGuardLocals { get; } =
        new HashSet<ISymbol>(SymbolEqualityComparer.Default);

    // Issue #1967: designation nodes (`SingleVariableDesignationSyntax`) already
    // checked by `ReportIfIndexOrRangeTypedDesignation` for an Index/Range-typed
    // declared symbol. A single designation can be reached from more than one
    // translation path for the SAME node (e.g. a loop-condition pattern's main
    // binder is inspected by both `FindMainPatternBinder` and
    // `EmitMustHoldGuards`/`IsBindOnlyMainBinder`); this dedupes so the loud gap
    // is reported once per designation, not once per visit.
    public HashSet<SyntaxNode> ReportedIndexRangeDesignations { get; } =
        new HashSet<SyntaxNode>();

    // C# post-increment/decrement (`i++`, `i--`) sub-expressions that the
    // surrounding statement seam has hoisted into trailing `i++` statements
    // (G# models inc/dec as statements, not expressions; spec §Statements).
    // While a node is in this set, `TranslateExpression` renders it as a bare
    // read of its operand (the pre-increment value).
    public HashSet<SyntaxNode> SuppressedPostfix { get; } =
        new HashSet<SyntaxNode>();

    // Value-position deconstruction assignments whose statement fallback has
    // already run. Ordinary, compound, and coalescing assignments now retain
    // their native expression position (ADR-0161 / issue #3347).
    public HashSet<SyntaxNode> SuppressedAssignments { get; } =
        new HashSet<SyntaxNode>();

    // Exact result captured while flattening a chain that contains a
    // value-position deconstruction assignment.
    public Dictionary<AssignmentExpressionSyntax, GExpression> AssignmentValues { get; } =
        new Dictionary<AssignmentExpressionSyntax, GExpression>();

    // Caches the G# value expression a value-position deconstruction
    // assignment (`(a, b) = (1, 2)` used as a value, not a bare statement)
    // was lowered to, keyed by its LHS tuple-target syntax node. Populated
    // once by <see cref="LowerTupleAssignmentForValue"/> when the write is
    // hoisted (see <see cref="FlattenChainedAssignment"/>); read back when
    // `TranslateExpression` later revisits the (now suppressed) assignment
    // node in its original position (issue #1974).
    public Dictionary<TupleExpressionSyntax, GExpression> TupleAssignmentValues { get; } =
        new Dictionary<TupleExpressionSyntax, GExpression>();

    // Values captured before a nested deconstruction assignment is hoisted.
    // TranslateExpression substitutes these temps at their original positions
    // so C# left-to-right operand evaluation remains intact.
    public Dictionary<ExpressionSyntax, GExpression> HoistedExpressionValues { get; } =
        new Dictionary<ExpressionSyntax, GExpression>();

    // Static-field initializers lifted out of a `static` constructor body
    // (`static T() { Field = value; }`). G# has no static constructor, so a
    // simple static ctor is folded into the corresponding `shared { }` field
    // initializers and the ctor itself is dropped (ADR-0115 §B.11).
    public Dictionary<ISymbol, GExpression> StaticFieldInitializers { get; } =
        new Dictionary<ISymbol, GExpression>(SymbolEqualityComparer.Default);

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
    public Dictionary<IPropertySymbol, string> SynthesizedPropertyBackingFieldNames { get; } =
        new Dictionary<IPropertySymbol, string>(SymbolEqualityComparer.Default);

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
    public Dictionary<(ISymbol Symbol, SyntaxNode Scope), bool> SymbolReassignedCache { get; } =
        new Dictionary<(ISymbol, SyntaxNode), bool>(SymbolScopeKeyComparer.Instance);

    public Dictionary<(ISymbol Symbol, SyntaxNode Scope), bool> UsedAsNullableCache { get; } =
        new Dictionary<(ISymbol, SyntaxNode), bool>(SymbolScopeKeyComparer.Instance);

    // Top-level declarations synthesized while translating an aggregate
    // (receiver-clause extensions and operators) are emitted as siblings.
    public List<GMember> PendingTopLevelDeclarations { get; } = new List<GMember>();

    // The syntax node whose body is currently being translated. It bounds the
    // data-flow scan that decides whether a local is mutable (var) or
    // immutable (let) per ADR-0115 §B.3.
    public SyntaxNode CurrentBodyScope { get; set; }

    // Monotonic counter for synthesizing unique temporaries when lowering
    // tuple-deconstruction assignments (`(a, b) = (x, y)`); ADR-0115 §B.
    public int DeconCounter { get; set; }

    // Monotonic counter for synthesizing the hoist local when a loop condition
    // carries a binder-less side-effecting `is`-pattern clause (issue #914).
    public int LoopHoistCounter { get; set; }

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
    public List<GStatement> PendingSpillPrologue { get; set; }

    // A fallback pattern spill inside a conditionally evaluated short-circuit
    // operand declares its reusable temp in the enclosing expression's seam,
    // then assigns it inside the operand's block expression. This keeps the temp
    // visible to later pattern-variable reads without evaluating the scrutinee
    // before the guards that protect it.
    public List<GStatement> ShortCircuitSpillDeclarations { get; set; }

    // Outermost short-circuit operand currently redirecting fallback pattern
    // spills. Nested lambdas/local functions must not reuse its declaration seam.
    public SyntaxNode ShortCircuitSpillScope { get; set; }

    // Monotonic counter for synthesizing spill temporaries (issue #1731).
    public int SpillCounter { get; set; }

    // Monotonic counter for immutable pattern captures that seed mutable C#
    // switch-arm pattern locals.
    public int SwitchPatternCounter { get; set; }

    // True only while reusing the switch-pattern code model for a native
    // boolean `is` expression. Boolean type patterns omit switch designators
    // and can compose directly with property/positional constraints.
    public bool TranslatingBooleanPattern { get; set; }

    // While rebuilding a static-helper receiver chained from `?.`, replace the
    // conditional-receiver placeholder with the already-guarded receiver so the
    // normal member-access translator still applies tuple/nullable/pointer and
    // extension-property rewrites to the rest of the chain.
    public GExpression ConditionalReceiverReplacement { get; set; }

    // Issue #2823: a redundant `?[i]` after an earlier conditional-access
    // segment whose own result is non-nullable becomes an ordinary dependent
    // `[i]`. Keying the replacement by the exact element binding prevents a
    // nested conditional access in the continuation from borrowing its receiver.
    public Dictionary<ElementBindingExpressionSyntax, GExpression> ConditionalElementReceivers { get; } =
        new Dictionary<ElementBindingExpressionSyntax, GExpression>();

    // Issue #3700: while re-splitting a `?[i]`-rooted continuation into a second
    // `?` seam, the element binding itself has already been emitted as the inner
    // seam's TARGET, so the rest of the chain must translate against the
    // conditional receiver instead of re-emitting the index.
    public Dictionary<ElementBindingExpressionSyntax, GExpression> ConditionalElementBindingReplacements { get; } =
        new Dictionary<ElementBindingExpressionSyntax, GExpression>();

    // Issue #1902: numbers the `__qN` tuple parameter synthesized to carry a
    // query's transparent identifier (multiple in-scope range variables)
    // through a lambda that C#'s query-translation spec (§12.19.3) would bind
    // via an anonymous type; G# has no anonymous types, so a positional tuple
    // stands in (see <see cref="BuildScopeParameter"/>).
    public int QueryScopeCounter { get; set; }

    // Issue #1998: the query currently being lowered, set for the duration of
    // `TranslateQuery` — anchors the arity-cap diagnostic in
    // `BuildScopeParameter`.
    public QueryExpressionSyntax CurrentQueryNode { get; set; }

    // Instance helpers synthesized while translating the current aggregate.
    public List<MethodDeclaration> PendingInstanceSynthHelpers { get; set; }

    // Shared helpers synthesized from capture-free static local functions.
    public List<MethodDeclaration> PendingStaticSynthHelpers { get; set; }

    public Dictionary<IMethodSymbol, string> LiftedStaticLocalFunctions { get; } =
        new Dictionary<IMethodSymbol, string>(SymbolEqualityComparer.Default);

    // Issue #3467: synthesized control-flow label names, allocated per
    // enclosing function body in first-use order instead of embedding the
    // syntax node's SpanStart. The node-keyed memo keeps the independent call
    // sites that must agree on a label (its definition and its gotos)
    // consistent; the counter map hands out the per-scope ordinals.
    public Dictionary<SyntaxNode, string> SyntheticLabelNames { get; } =
        new Dictionary<SyntaxNode, string>();

    public Dictionary<(SyntaxNode Scope, string Prefix), int> SyntheticLabelCounters { get; } =
        new Dictionary<(SyntaxNode Scope, string Prefix), int>();

    // Issue #3467: lifted local-function helper names already allocated in
    // this document, so a name collision (same enclosing member name + same
    // local-function name) takes an ordinal suffix instead of embedding
    // SpanStart.
    public HashSet<string> UsedLiftedLocalFunctionNames { get; } =
        new HashSet<string>(StringComparer.Ordinal);

    public Dictionary<IMethodSymbol, LiftedRecursiveLocalFunction> LiftedRecursiveLocalFunctions { get; } =
        new Dictionary<IMethodSymbol, LiftedRecursiveLocalFunction>(SymbolEqualityComparer.Default);

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
    public Dictionary<IMethodSymbol, RecursiveLocalFunctionGroup> RecursiveLocalFunctionGroups { get; } =
        new Dictionary<IMethodSymbol, RecursiveLocalFunctionGroup>(SymbolEqualityComparer.Default);

    // Issue #3399: state-level dedup for the SCC declarations emission — the
    // first member translated for a group is the one that emits the shared
    // nil-initialized declarations; tracked by member symbol (not by group
    // instance) so re-registered copies of the same SCC cannot double-emit.
    public HashSet<IMethodSymbol> EmittedRecursiveGroupMembers { get; } =
        new HashSet<IMethodSymbol>(SymbolEqualityComparer.Default);
}

internal sealed class LiftedRecursiveLocalFunction
{
    public LiftedRecursiveLocalFunction(
        string name,
        bool isStatic,
        IReadOnlyList<LiftedLocalFunctionCapture> captures)
    {
        Name = name;
        IsStatic = isStatic;
        Captures = captures;
    }

    public string Name { get; }

    public bool IsStatic { get; }

    public IReadOnlyList<LiftedLocalFunctionCapture> Captures { get; }
}

internal sealed class LiftedLocalFunctionCapture
{
    public LiftedLocalFunctionCapture(ISymbol symbol, bool isByRef)
    {
        Symbol = symbol;
        IsByRef = isByRef;
    }

    public ISymbol Symbol { get; }

    public bool IsByRef { get; }
}

/// <summary>
/// Issue #1743: equality for the (symbol, scope) cache key used by
/// <c>IsSymbolReassigned</c>/<c>IsUsedAsNullable</c>'s memoization
/// (<see cref="DocumentTranslationState.SymbolReassignedCache"/> /
/// <see cref="DocumentTranslationState.UsedAsNullableCache"/>). Symbols compare
/// via the Roslyn-recommended <see cref="SymbolEqualityComparer.Default"/>;
/// scope nodes compare by reference (the same <c>SyntaxNode</c> instance is what
/// every call site passes for a given symbol).
/// </summary>
/// <summary>
/// Issue #3399: the per-SCC emission state for the nullable-function-local
/// lowering of a capturing recursive C# local function (see
/// <see cref="DocumentTranslationState.RecursiveLocalFunctionGroups"/>).
/// Member names and the shared nil-initialized declarations are resolved at
/// registration time; <see cref="DeclarationsEmitted"/> lets the FIRST member
/// translated in document order emit the whole SCC's `var Name … = nil`
/// declarations ahead of its own `Name = func …` assignment (all declarations
/// must precede the first assignment, because a G# closure body cannot
/// reference a sibling local that is not yet declared).
/// </summary>
internal sealed class RecursiveLocalFunctionGroup
{
    public RecursiveLocalFunctionGroup(
        IEnumerable<IMethodSymbol> members,
        IReadOnlyList<string> names,
        IReadOnlyList<GStatement> declarations)
    {
        this.MemberNames = new Dictionary<IMethodSymbol, string>(SymbolEqualityComparer.Default);
        int index = 0;
        foreach (IMethodSymbol member in members)
        {
            this.MemberNames[member] = names[index++];
        }

        this.Members = new HashSet<IMethodSymbol>(this.MemberNames.Keys, SymbolEqualityComparer.Default);
        this.Declarations = declarations;
    }

    public HashSet<IMethodSymbol> Members { get; }

    public Dictionary<IMethodSymbol, string> MemberNames { get; }

    public IReadOnlyList<GStatement> Declarations { get; }

    public bool DeclarationsEmitted { get; set; }

    public string NameOf(IMethodSymbol symbol) => this.MemberNames[symbol];
}

internal sealed class SymbolScopeKeyComparer : IEqualityComparer<(ISymbol Symbol, SyntaxNode Scope)>
{
    public static readonly SymbolScopeKeyComparer Instance = new SymbolScopeKeyComparer();

    public bool Equals((ISymbol Symbol, SyntaxNode Scope) x, (ISymbol Symbol, SyntaxNode Scope) y) =>
        SymbolEqualityComparer.Default.Equals(x.Symbol, y.Symbol) &&
        ReferenceEquals(x.Scope, y.Scope);

    public int GetHashCode((ISymbol Symbol, SyntaxNode Scope) obj) =>
        HashCode.Combine(
            SymbolEqualityComparer.Default.GetHashCode(obj.Symbol),
            System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(obj.Scope));
}
