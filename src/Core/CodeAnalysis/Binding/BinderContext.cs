// <copyright file="BinderContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Symbols;

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
#pragma warning restore SA1401

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
    /// Gets the stack of per-scope variable-narrowing tables used by pattern
    /// matching and flow analysis. Each entry maps a variable to its narrowed
    /// type within the corresponding scope.
    /// </summary>
    public List<Dictionary<VariableSymbol, TypeSymbol>> NarrowedVariables { get; }
        = new List<Dictionary<VariableSymbol, TypeSymbol>>();

    /// <summary>
    /// Gets the side-table that parks the else-branch narrowing frame of an
    /// <c>if</c>-statement keyed by the resulting bound
    /// <see cref="BoundIfStatement"/> node identity. ADR-0069 / issue #700:
    /// <c>BindBlockStatements</c> consults this table and lifts the frame
    /// into the enclosing block's persistent narrowing scope when the
    /// then-branch ends in an unconditional exit (return, throw, break,
    /// continue), so subsequent reads in the block see the narrowing.
    /// </summary>
    public Dictionary<BoundIfStatement, Dictionary<VariableSymbol, TypeSymbol>> PendingEarlyExitFrames { get; }
        = new Dictionary<BoundIfStatement, Dictionary<VariableSymbol, TypeSymbol>>();

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
    public Dictionary<BoundPatternSwitchStatement, Dictionary<VariableSymbol, TypeSymbol>> PendingSwitchExitFrames { get; }
        = new Dictionary<BoundPatternSwitchStatement, Dictionary<VariableSymbol, TypeSymbol>>();

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
}
