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

    // C# assignment-expressions used in VALUE position (`while ((line =
    // r.ReadLine()) != null)`, `M(x = 5)`, `if ((x = f()) > 0)`) that the
    // surrounding statement/condition seam has hoisted into a preceding
    // assignment statement (G# assignment is a statement, not a
    // value-yielding expression; spec §Statements). While a node is in this
    // set, `TranslateExpression` renders it as a bare read of its already-
    // written target rather than dropping the write (issue #1723).
    public HashSet<SyntaxNode> SuppressedAssignments { get; } =
        new HashSet<SyntaxNode>();

    // Caches the G# value expression a value-position deconstruction
    // assignment (`(a, b) = (1, 2)` used as a value, not a bare statement)
    // was lowered to, keyed by its LHS tuple-target syntax node. Populated
    // once by <see cref="LowerTupleAssignmentForValue"/> when the write is
    // hoisted (see <see cref="FlattenChainedAssignment"/>); read back when
    // `TranslateExpression` later revisits the (now suppressed) assignment
    // node in its original position (issue #1974).
    public Dictionary<TupleExpressionSyntax, GExpression> TupleAssignmentValues { get; } =
        new Dictionary<TupleExpressionSyntax, GExpression>();

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

    // Issue #1893: gsc has no rectangular multi-dimensional array type (only
    // the fixed-length `[N]T`/slice `[]T`, both rank 1), so a C# `T[,]` local
    // initialized directly from `new T[d0, d1, ...]` (or a rectangular
    // initializer `new T[,]{{...}}`) is lowered to a single flat backing
    // array of length `d0*d1*...`, with each dimension's size hoisted to its
    // own `let` (or, for a literal initializer, kept as the constant row/
    // column count). This map remembers, per declared local/field symbol,
    // the ordered per-dimension size expressions so every later `grid[r, c]`
    // access and `grid.GetLength(k)` call can rebuild the faithful
    // row-major flat index/dimension instead of dropping indices. A
    // multi-dim array reached through any other shape (field, parameter,
    // return value, reassignment, ...) is not tracked here and reports a
    // loud CS2GS-GAP rather than silently collapsing to 1-D.
    public Dictionary<ISymbol, MultiDimArrayInfo> MultiDimArrays { get; } =
        new Dictionary<ISymbol, MultiDimArrayInfo>(SymbolEqualityComparer.Default);

    // Owned struct / data-struct instance methods cannot live in the type
    // body (the parser rejects an in-body `func`); they are lifted to
    // top-level receiver-clause `func`s emitted as siblings of the type
    // (issue #938, ADR-0115 §B.5). Collected here per aggregate and drained
    // by the document translator.
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
    // scrutinees, range-slice start operands) must embed the SAME translated
    // operand at more than one output position; naively reusing the operand's
    // node would print — and so re-evaluate — it once per embed. `SpillOperand`
    // hoists such an operand into a fresh `let` appended here, evaluated
    // exactly once immediately before the statement currently being
    // translated (see <see cref="WithSpillSeam"/>). Null outside any
    // statement seam and across a lambda/local-function boundary (its body is
    // a distinct evaluation scope; see <see cref="TranslateLambda"/> and
    // <see cref="TranslateLocalFunction"/>) so a hoist can never leak into an
    // unrelated enclosing scope — in that case `SpillOperand` conservatively
    // leaves the operand embedded as-is.
    public List<GStatement> PendingSpillPrologue { get; set; }

    // Monotonic counter for synthesizing spill temporaries (issue #1731).
    public int SpillCounter { get; set; }

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

    // Issue #1897: numbers the `__spreadN` temporary built to lower a
    // collection-expression spread element (see
    // <see cref="TranslateSpreadCollectionExpression"/>).
    public int SpreadCounter { get; set; }

    // Issue #1849: when non-null, `SpillOperand` is inside a "null-seam"
    // expression context — a field/property initializer or a
    // base(...)/this(...) constructor argument (issue #1731 N1) — that has
    // no statement to host a spill `let`. `TranslateNullSeamExpression`/
    // `TranslateNullSeamArgument` open this capture list instead: a
    // non-trivial operand is recorded here as a would-be synthetic helper
    // parameter (name + translated operand + resolved type) and replaced
    // with a bare reference to that parameter, so the surrounding
    // pattern/range-slice lowering is unaffected — it just ends up reading a
    // parameter instead of a spilled local. The caller then synthesizes a
    // private static helper method taking these captures as parameters and
    // rewrites the null-seam expression into a call to it, passing the
    // captured operands as arguments (evaluated once, by the caller, in
    // source order). Null outside a null-seam capture session, in which case
    // `SpillOperand` falls back to the loud `Unsupported` diagnostic.
    public List<(string Name, GExpression Operand, GTypeReference Type)> PendingHelperCaptures { get; set; }

    // Issue #1849: synthetic helper methods (see `PendingHelperCaptures`)
    // collected while translating the CURRENT aggregate's members, added to
    // that aggregate's `shared { }` block once the member loop completes
    // (see `VisitAggregate`). Saved/restored around a nested type
    // declaration's own recursive `VisitAggregate` call so a nested type's
    // helpers never leak into its enclosing type.
    public List<MethodDeclaration> PendingSynthHelpers { get; set; }

    // Instance helpers synthesized while translating the current aggregate.
    // Unlike PendingSynthHelpers, these remain ordinary class members.
    public List<MethodDeclaration> PendingInstanceSynthHelpers { get; set; }

    // Monotonic counter for synthesizing null-seam helper method names
    // (issue #1849), reset per aggregate alongside `PendingSynthHelpers`.
    public int SynthHelperCounter { get; set; }

    // When translating the body of a lifted owned-value-aggregate receiver
    // method (issue #938), the implicit `this.` of a bare instance-member
    // reference must be made explicit through the receiver name (`self.`),
    // because a top-level receiver-clause `func` has no implicit receiver.
    public string CurrentReceiverName { get; set; }

    // The exception variable bound by the innermost enclosing `catch` clause,
    // used to translate a C# re-throw (`throw;`) — which has no bare G# form —
    // to `throw <caughtVar>` (ADR-0115 §B).
    public string CurrentCatchVariable { get; set; }
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

/// <summary>
/// Issue #1893: per-declared-symbol record of a flat-lowered multi-dim array's
/// per-dimension size expressions. See the field comment on
/// <see cref="DocumentTranslationState.MultiDimArrays"/> for the full rationale.
/// </summary>
internal sealed class MultiDimArrayInfo
{
    public MultiDimArrayInfo(IReadOnlyList<GExpression> dimensionSizes)
    {
        this.DimensionSizes = dimensionSizes;
    }

    /// <summary>
    /// Gets the per-dimension size expressions, outermost dimension
    /// first, each safe to reference repeatedly (a hoisted `let`
    /// identifier or a compile-time-constant literal — never a raw
    /// expression that could re-run a side effect).
    /// </summary>
    public IReadOnlyList<GExpression> DimensionSizes { get; }
}
