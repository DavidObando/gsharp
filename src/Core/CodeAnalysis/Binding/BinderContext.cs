// <copyright file="BinderContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Cross-cutting state shared across a single <see cref="Binder"/> instance
/// and (in subsequent extraction PRs) the components a <see cref="Binder"/>
/// composes — <c>MemberLookup</c>, <c>ConversionClassifier</c>,
/// <c>OverloadResolver</c>, and so on.
/// </summary>
/// <remarks>
/// <para>
/// PR-B-1 introduces this type as the foundation for the Binder decomposition
/// described in the repository-level decomposition plan. No methods are moved
/// in this PR; only the cross-cutting state that downstream extractions will
/// need to consume via constructor injection is centralised here.
/// </para>
/// <para>
/// State that is deliberately <em>not</em> on <see cref="BinderContext"/>:
/// the per-binder <see cref="FunctionSymbol"/> (it is per-binder, not cross-
/// cutting), the pending interface-implementation checks list (declaration-
/// specific; moves in PR-B-8), and the static readonly attribute-target
/// hashsets (they are constants).
/// </para>
/// </remarks>
internal sealed class BinderContext
{
    /// <summary>
    /// ADR-0082 / issue #722. The fully-qualified namespace whose presence
    /// in a compilation unit's import set unlocks the Go-flavored
    /// concurrency surface (<c>go</c>, <c>chan T</c>, <c>&lt;-</c>,
    /// <c>select</c>, <c>close(ch)</c>, <c>make(chan T)</c>) and, in
    /// follow-up issues, Go-style built-ins (#723) and helper namespaces
    /// (#724).
    /// </summary>
    public const string GoExtensionsImportTarget = "Gsharp.Extensions.Go";

    /// <summary>
    /// Counter used to allocate unique <see cref="BoundLabel"/> identifiers.
    /// Mutated in place by callers (sometimes via
    /// <see cref="System.Threading.Interlocked.Increment(ref int)"/>), so it
    /// must remain a field rather than a property.
    /// </summary>
#pragma warning disable SA1401 // Fields should be private — see class remarks.
    public int LabelCounter;

    /// <summary>
    /// Counter used to allocate unique synthetic-local names for null-
    /// conditional receiver captures. Mutated in place by callers.
    /// </summary>
    public int NullConditionalCaptureCounter;

    /// <summary>
    /// Issue #1238: set transiently by the argument-binding loops just before
    /// eagerly binding a top-level conditional (<c>if</c>/<c>else</c>),
    /// ternary, or <c>switch</c>-expression argument that has no target type
    /// yet. When set, those branchy binders suppress a no-common-type
    /// unification failure (instead of reporting it) and return a placeholder
    /// carrying the original syntax, so the argument can be re-bound with the
    /// resolved parameter type as its target once overload resolution picks the
    /// applicable method/constructor. The flag is read-and-cleared by the
    /// branchy binder so nested sub-expressions bind with normal (non-deferred)
    /// semantics.
    /// </summary>
    public bool DeferTargetlessConditional;

    /// <summary>
    /// Counter used to allocate unique synthetic-local names for general
    /// binder-introduced temporaries. Mutated in place by callers via
    /// <see cref="System.Threading.Interlocked.Increment(ref int)"/>.
    /// </summary>
    public int SyntheticLocalCounter;

    /// <summary>
    /// Counter used to allocate unique synthetic-local names for captured
    /// <c>defer</c> argument values. Mutated in place by callers.
    /// </summary>
    public int DeferArgumentCounter;

    /// <summary>
    /// Counter used to allocate unique synthetic-local names for discarded
    /// <c>out</c> argument receivers. Mutated in place by callers.
    /// </summary>
    public int OutDiscardCounter;

    /// <summary>
    /// ADR-0122 / issue #1014. Nesting depth of the current <c>unsafe</c>
    /// context. Greater than zero inside an <c>unsafe func</c>, the body of an
    /// <c>unsafe class</c> / <c>unsafe struct</c>, or an <c>unsafe { … }</c>
    /// block. When in an unsafe context the prefix <c>*T</c> type clause binds
    /// to an <em>unmanaged</em> pointer (<see cref="Symbols.PointerTypeSymbol"/>,
    /// <c>ELEMENT_TYPE_PTR</c>) rather than a managed by-ref
    /// (<see cref="Symbols.ByRefTypeSymbol"/>), and raw-pointer operations
    /// (dereference, indexing, pointer arithmetic, pointer casts) are permitted.
    /// Mutated in place via <see cref="PushUnsafeContext"/>.
    /// </summary>
    public int UnsafeDepth;
#pragma warning restore SA1401

    /// <summary>
    /// Issue #1201: cached set of user-defined types brought into unqualified
    /// static-member scope via a non-alias type import (<c>import Ns.Type</c>,
    /// the G# spelling of C#'s <c>using static</c>). <c>null</c> until first
    /// computed by <see cref="GetStaticImportTypes"/>; invalidated when the
    /// import or struct count moves.
    /// </summary>
    private ImmutableArray<StructSymbol>? cachedStaticImportTypes;

    private int cachedStaticImportImportCount = -1;

    private int cachedStaticImportStructCount = -1;
    private SyntaxTree cachedStaticImportSyntaxTree;

    /// <summary>
    /// Initializes a new instance of the <see cref="BinderContext"/> class.
    /// </summary>
    /// <param name="parent">The parent <see cref="BoundScope"/> against which
    /// the binder's root scope is created.</param>
    public BinderContext(BoundScope parent)
    {
        RootScope = new BoundScope(parent);
    }

    /// <summary>
    /// Gets the diagnostics bag for the binder this context backs.
    /// </summary>
    public DiagnosticBag Diagnostics { get; } = new DiagnosticBag();

    /// <summary>
    /// Gets the reference resolver associated with the binder's scope chain.
    /// Provided as a first-class accessor so downstream extracted components
    /// don't need to reach through <see cref="RootScope"/>.
    /// </summary>
    public ReferenceResolver References => RootScope.References;

    /// <summary>
    /// Gets a value indicating whether binding is currently inside an
    /// <c>unsafe</c> context (ADR-0122 / issue #1014). When true the prefix
    /// <c>*T</c> type clause binds to an unmanaged pointer
    /// (<see cref="Symbols.PointerTypeSymbol"/>) and raw-pointer operations are
    /// permitted.
    /// </summary>
    public bool InUnsafeContext => UnsafeDepth > 0;

    /// <summary>
    /// Gets a value indicating whether the current <c>checked</c>/<c>unchecked</c>
    /// arithmetic context is checked (issue #1881): <see langword="true"/> inside
    /// a `checked(...)` expression or a `checked { }` statement,
    /// <see langword="false"/> inside `unchecked(...)`/`unchecked { }` or when no
    /// such context has been entered (the C# project default is unchecked).
    /// Innermost context wins — <see cref="PushCheckedContext"/> saves and
    /// restores the previous value, so nesting `checked { unchecked { … } }`
    /// resolves correctly. Only observed by the Sum/Difference/Product binary
    /// operator and by narrowing numeric conversions.
    /// </summary>
    public bool IsCheckedContext { get; private set; }

    /// <summary>
    /// Gets or sets the scope the binder currently operates against. Starts
    /// at the binder's root scope; mutated during nested-scope push/pop by
    /// statement, expression, and lambda binding helpers — so a writable
    /// accessor is required.
    /// </summary>
    public BoundScope RootScope { get; set; }

    /// <summary>
    /// Gets the stack of (label-name, break-label, continue-label) tuples
    /// maintained for loop bodies during binding. The <c>LabelName</c>
    /// element is <see langword="null"/> for unlabeled loops; ADR-0070
    /// labeled <c>break</c> / <c>continue</c> resolve their target by
    /// scanning this stack for a matching label name.
    /// </summary>
    public Stack<(string LabelName, BoundLabel BreakLabel, BoundLabel ContinueLabel)> LoopStack { get; }
        = new Stack<(string LabelName, BoundLabel BreakLabel, BoundLabel ContinueLabel)>();

    /// <summary>
    /// Gets the enclosing function's user-defined <c>goto</c> labels
    /// (issue #1884): a label placed on any non-loop statement, keyed by
    /// name. Populated by a pre-pass over the function body before any
    /// statement is bound, so a <c>goto</c> may target a label declared
    /// later in the same function (forward reference). Fresh per function/
    /// lambda/local-function — matches ADR-0070's "label namespace is local
    /// to the enclosing function" rule.
    /// </summary>
    public Dictionary<string, BoundLabel> UserLabels { get; }
        = new Dictionary<string, BoundLabel>();

    /// <summary>
    /// Gets the set of user-defined <c>goto</c> label names (issue #1884)
    /// that have already been declared via a <c>label: statement</c> in this
    /// function. Used to detect a duplicate label declaration (GS0470).
    /// </summary>
    public HashSet<string> DefinedUserLabels { get; } = new HashSet<string>();

    /// <summary>
    /// Gets the user-defined <c>goto</c> label names (issue #1884) that have
    /// been referenced by a <c>goto</c> but not yet declared, keyed to the
    /// location of the first such reference. Checked once the enclosing
    /// function finishes binding (<c>StatementBinder.FinalizeUserLabels</c>);
    /// any name still present is an undefined label (GS0469).
    /// </summary>
    public Dictionary<string, TextLocation> UnresolvedGotoLabels { get; }
        = new Dictionary<string, TextLocation>();

    /// <summary>
    /// Gets the stack of per-scope variable-narrowing tables used by pattern
    /// matching and flow analysis. Each entry maps a variable to its narrowed
    /// type within the corresponding scope.
    /// </summary>
    public List<Dictionary<AccessPath, TypeSymbol>> NarrowedVariables { get; }
        = new List<Dictionary<AccessPath, TypeSymbol>>();

    /// <summary>
    /// Gets the side-table that parks the else-branch narrowing frame of an
    /// <c>if</c>-statement keyed by the resulting bound
    /// <see cref="BoundIfStatement"/> node identity. ADR-0069 / issue #700:
    /// <c>BindBlockStatements</c> consults this table and lifts the frame
    /// into the enclosing block's persistent narrowing scope when the
    /// then-branch ends in an unconditional exit (return, throw, break,
    /// continue), so subsequent reads in the block see the narrowing.
    /// </summary>
    public Dictionary<BoundIfStatement, Dictionary<AccessPath, TypeSymbol>> PendingEarlyExitFrames { get; }
        = new Dictionary<BoundIfStatement, Dictionary<AccessPath, TypeSymbol>>();

    /// <summary>
    /// Gets the side-table that parks the post-switch narrowing frame for a
    /// <c>switch</c> statement keyed by the resulting bound
    /// <see cref="BoundPatternSwitchStatement"/> node identity. ADR-0069
    /// addendum / issue #712: when every non-default arm either ends in an
    /// unconditional exit OR contributes the same narrowing on the
    /// discriminator (and the default arm, if any, does likewise), the
    /// common narrowing is lifted into the enclosing block's persistent
    /// narrowing scope so subsequent reads in the block see the narrowing.
    /// </summary>
    public Dictionary<BoundPatternSwitchStatement, Dictionary<AccessPath, TypeSymbol>> PendingSwitchExitFrames { get; }
        = new Dictionary<BoundPatternSwitchStatement, Dictionary<AccessPath, TypeSymbol>>();

    /// <summary>
    /// Gets or sets the type-parameter dictionary in scope while binding a
    /// generic function body. Indexed by type-parameter name. <c>null</c> when
    /// no generic context is active.
    /// </summary>
    public Dictionary<string, TypeParameterSymbol> CurrentTypeParameters { get; set; }

    /// <summary>
    /// Gets or sets the cached list of imported static <c>[Extension]</c>
    /// classes for instance-syntax extension-method dispatch (issue #294).
    /// Recomputed when <see cref="CachedImportedExtensionImportCount"/> falls
    /// out of step with the current import count.
    /// </summary>
    public List<Type> CachedImportedExtensionClasses { get; set; }

    /// <summary>
    /// Gets or sets the import count snapshot for the entries cached in
    /// <see cref="CachedImportedExtensionClasses"/>. Initialised to <c>-1</c>
    /// so the first lookup always misses.
    /// </summary>
    public int CachedImportedExtensionImportCount { get; set; } = -1;

    public SyntaxTree CachedImportedExtensionSyntaxTree { get; set; }

    /// <summary>
    /// Issue #1201: resolves the compilation's non-alias type imports
    /// (<c>import Ns.Type</c>) to the user-defined <see cref="StructSymbol"/>s
    /// whose <c>shared</c> (static) members are thereby brought into scope for
    /// unqualified reference — the G# equivalent of C#'s <c>using static</c>.
    /// A plain namespace import (<c>import Ns</c>) names no type and contributes
    /// nothing; an alias import (<c>import x = Ns.Type</c>) is a type alias, not
    /// a static import, and is likewise excluded (mirroring C#, where
    /// <c>using X = T;</c> does not hoist members). Same-compilation user types
    /// only; imported CLR static classes are out of scope (see ADR-0134).
    /// </summary>
    /// <returns>The distinct imported static-import types, in import order. Empty when none apply.</returns>
    public ImmutableArray<StructSymbol> GetStaticImportTypes()
    {
        var imports = RootScope.GetDeclaredImports();
        var structs = RootScope.GetDeclaredStructs();
        if (cachedStaticImportTypes is { } cached
            && cachedStaticImportImportCount == imports.Length
            && cachedStaticImportStructCount == structs.Length
            && ReferenceEquals(cachedStaticImportSyntaxTree, RootScope.GetCurrentReferencingSyntaxTreeForCache()))
        {
            return cached;
        }

        ImmutableArray<StructSymbol>.Builder builder = null;
        HashSet<StructSymbol> seen = null;
        foreach (var imp in imports)
        {
            // A compiler-synthesized (implicit `import System`) import always
            // names a namespace, and an alias import is a type alias rather than
            // a static import — neither hoists members.
            if (imp.IsImplicit || imp.IsAlias)
            {
                continue;
            }

            foreach (var s in structs)
            {
                if (!ImportTargetNamesType(imp.Target, s))
                {
                    continue;
                }

                seen ??= new HashSet<StructSymbol>();
                if (seen.Add(s))
                {
                    (builder ??= ImmutableArray.CreateBuilder<StructSymbol>()).Add(s);
                }

                break;
            }
        }

        var result = builder?.ToImmutable() ?? ImmutableArray<StructSymbol>.Empty;
        cachedStaticImportTypes = result;
        cachedStaticImportImportCount = imports.Length;
        cachedStaticImportStructCount = structs.Length;
        cachedStaticImportSyntaxTree = RootScope.GetCurrentReferencingSyntaxTreeForCache();
        return result;

        // Issue #1201: whether the fully-qualified import `target` names the user
        // type `s` — its package-qualified name (`PackageName.Name`), or its bare
        // simple name for a default-package type imported as `import TypeName`.
        static bool ImportTargetNamesType(string target, StructSymbol s)
        {
            if (string.IsNullOrEmpty(target) || string.IsNullOrEmpty(s.Name))
            {
                return false;
            }

            var pkg = s.PackageName;
            var fq = string.IsNullOrEmpty(pkg) || string.Equals(pkg, "Default", StringComparison.Ordinal)
                ? s.Name
                : pkg + "." + s.Name;

            if (string.Equals(fq, target, StringComparison.Ordinal))
            {
                return true;
            }

            // A bare `import TypeName` (no dotted prefix) names a default-package type.
            return target.IndexOf('.') < 0 && string.Equals(s.Name, target, StringComparison.Ordinal);
        }
    }

    /// <summary>
    /// ADR-0082 / issue #722. Returns whether <c>import Gsharp.Extensions.Go</c>
    /// is declared in the compilation unit that contains the given syntax
    /// node. The check is per <see cref="Syntax.SyntaxTree"/> — multi-file
    /// packages (ADR-0028) do not collapse import sets across files.
    /// Implicit / compiler-synthesized imports never match: the Go-flavored
    /// surface is always opt-in regardless of <c>/noimplicitimports</c>.
    /// </summary>
    /// <param name="syntax">The syntax node whose owning compilation unit is checked.</param>
    /// <returns><c>true</c> when the same compilation unit declares <c>import Gsharp.Extensions.Go</c>; <c>false</c> otherwise.</returns>
    public bool IsGoExtensionsImported(Syntax.SyntaxNode syntax)
    {
        if (syntax == null)
        {
            return false;
        }

        var tree = syntax.SyntaxTree;
        if (tree == null)
        {
            return false;
        }

        foreach (var imp in RootScope.GetDeclaredImports())
        {
            if (string.Equals(imp.Target, GoExtensionsImportTarget, StringComparison.Ordinal)
                && imp.Declaration is { SyntaxTree: var declTree }
                && declTree == tree)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// ADR-0082 / issue #722. Convenience wrapper that reports <c>GS0316</c>
    /// at <paramref name="location"/> when the file containing
    /// <paramref name="syntax"/> does not import <c>Gsharp.Extensions.Go</c>.
    /// Returns <c>true</c> when the diagnostic fired so callers can
    /// short-circuit cosmetic recovery, but every gated binder still
    /// produces the same bound tree it would have produced with the import
    /// present (per ADR-0082 "Recovery").
    /// </summary>
    /// <param name="syntax">The syntax node whose owning compilation unit is checked.</param>
    /// <param name="location">The location to anchor the diagnostic at (typically the keyword or operator token).</param>
    /// <param name="form">The triggering syntactic form (<c>go</c>, <c>chan</c>, <c>&lt;-</c>, <c>select</c>, <c>close</c>, <c>make(chan)</c>).</param>
    /// <returns><c>true</c> when GS0316 was reported.</returns>
    public bool ReportIfGoExtensionsImportMissing(Syntax.SyntaxNode syntax, Text.TextLocation location, string form)
    {
        if (IsGoExtensionsImported(syntax))
        {
            return false;
        }

        Diagnostics.ReportGoExtensionsImportRequired(location, form);
        return true;
    }

    /// <summary>
    /// ADR-0083 / issue #723. Convenience wrapper that reports <c>GS0317</c>
    /// at <paramref name="location"/> when the file containing
    /// <paramref name="syntax"/> does not import <c>Gsharp.Extensions.Go</c>.
    /// Picks the .NET-idiomatic suggestion text (if any) from the
    /// per-built-in / per-receiver-type table in ADR-0083 §"Suggestion
    /// matrix" so the message points the user at <c>.Length</c>,
    /// <c>.Count</c>, <c>.Remove(k)</c>, etc. when there is one. Returns
    /// <c>true</c> when GS0317 fired so callers can preserve recovery
    /// behaviour identical to the import-present path (per ADR-0083
    /// "Recovery"): the gated built-in still binds to its placeholder
    /// <c>BoundExpression</c> so subsequent type / shape diagnostics still
    /// surface in the same pass.
    /// </summary>
    /// <param name="syntax">The syntax node whose owning compilation unit is checked.</param>
    /// <param name="location">The location to anchor the diagnostic at (typically the built-in identifier token).</param>
    /// <param name="builtin">The triggering built-in name (e.g. <c>len</c>, <c>cap</c>, <c>append</c>, <c>delete</c>).</param>
    /// <param name="receiverType">The bound type of the built-in's primary receiver argument, when known; <c>null</c> for the unresolved / error case.</param>
    /// <returns><c>true</c> when GS0317 was reported.</returns>
    public bool ReportIfGoBuiltinImportMissing(Syntax.SyntaxNode syntax, Text.TextLocation location, string builtin, TypeSymbol receiverType)
    {
        if (IsGoExtensionsImported(syntax))
        {
            return false;
        }

        Diagnostics.ReportGoBuiltinRequiresImport(location, builtin, GetGoBuiltinSuggestion(builtin, receiverType));
        return true;
    }

    /// <summary>
    /// ADR-0083 / issue #723. Returns the .NET-idiomatic alternative for a
    /// gated Go-style built-in, based on the built-in's identifier and the
    /// bound type of its primary receiver. Returns <c>null</c> when no
    /// clean alternative exists (e.g. <c>cap</c>, or <c>append</c> on a
    /// slice — the recommendation in that case is the import itself or a
    /// mutable <c>List[T].Add</c>).
    /// </summary>
    /// <param name="builtin">The built-in name (e.g. <c>len</c>, <c>cap</c>, <c>append</c>, <c>delete</c>).</param>
    /// <param name="receiverType">The bound type of the receiver argument, when known.</param>
    /// <returns>The suggestion snippet (e.g. <c>.Length</c>, <c>.Count</c>, <c>.Remove(k)</c>, <c>List[T].Add</c>), or <c>null</c> when no clean .NET-idiomatic alternative is documented.</returns>
    public static string GetGoBuiltinSuggestion(string builtin, TypeSymbol receiverType)
    {
        switch (builtin)
        {
            case "len":
                if (receiverType is MapTypeSymbol)
                {
                    return ".Count";
                }

                if (receiverType is ArrayTypeSymbol || receiverType is SliceTypeSymbol || receiverType == TypeSymbol.String)
                {
                    return ".Length";
                }

                // Unknown / error receiver: keep `.Length` as the most common
                // hint without lying about maps; the per-type case above
                // already steered maps to `.Count`.
                return ".Length";

            case "delete":
                return ".Remove(k)";

            case "append":
                return "List[T].Add";

            default:
                // cap / make / close have no clean .NET-idiomatic alternative.
                return null;
        }
    }

    /// <summary>
    /// ADR-0122 / issue #1014. Enters an <c>unsafe</c> context for the lifetime
    /// of the returned token (incrementing <see cref="UnsafeDepth"/>); disposing
    /// the token leaves the context. When <paramref name="active"/> is
    /// <see langword="false"/> the call is a no-op (the depth is unchanged), so
    /// callers can unconditionally wrap a region with the modifier's truthiness.
    /// </summary>
    /// <param name="active">Whether to actually enter an unsafe context.</param>
    /// <returns>A disposable token that leaves the unsafe context when disposed.</returns>
    public UnsafeContextScope PushUnsafeContext(bool active = true)
    {
        if (active)
        {
            UnsafeDepth++;
        }

        return new UnsafeContextScope(this, active);
    }

    /// <summary>
    /// Issue #1881. Enters a `checked`/`unchecked` arithmetic context for the
    /// lifetime of the returned token; disposing the token restores the
    /// previous context (innermost nesting wins).
    /// </summary>
    /// <param name="isChecked">Whether the entered context is checked (true) or unchecked (false).</param>
    /// <returns>A disposable token that restores the previous context when disposed.</returns>
    public CheckedContextScope PushCheckedContext(bool isChecked)
    {
        var previous = IsCheckedContext;
        IsCheckedContext = isChecked;
        return new CheckedContextScope(this, previous);
    }

    /// <summary>
    /// Disposable token returned by <see cref="PushUnsafeContext"/> that
    /// decrements <see cref="UnsafeDepth"/> on disposal (ADR-0122 / issue #1014).
    /// </summary>
    public readonly struct UnsafeContextScope : IDisposable
    {
        private readonly BinderContext owner;
        private readonly bool active;

        internal UnsafeContextScope(BinderContext owner, bool active)
        {
            this.owner = owner;
            this.active = active;
        }

        /// <inheritdoc/>
        public void Dispose()
        {
            if (active)
            {
                owner.UnsafeDepth--;
            }
        }
    }

    /// <summary>
    /// Disposable token returned by <see cref="PushCheckedContext"/> that
    /// restores the enclosing checked/unchecked context on disposal (issue #1881).
    /// </summary>
    public readonly struct CheckedContextScope : IDisposable
    {
        private readonly BinderContext owner;
        private readonly bool previous;

        internal CheckedContextScope(BinderContext owner, bool previous)
        {
            this.owner = owner;
            this.previous = previous;
        }

        /// <inheritdoc/>
        public void Dispose()
        {
            if (owner != null)
            {
                owner.IsCheckedContext = previous;
            }
        }
    }
}
