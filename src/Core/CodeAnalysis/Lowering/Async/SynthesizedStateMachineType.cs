// <copyright file="SynthesizedStateMachineType.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Text;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// A compiler-synthesized CLR type that hosts the lowered state machine for
/// an <c>async</c> method (see <c>~/roslyn-async.md</c> §5). It carries all
/// hoisted control fields (<c>&lt;&gt;1__state</c>, <c>&lt;&gt;t__builder</c>),
/// the <c>this</c>-proxy field, parameter proxies, hoisted user locals, and
/// the per-type pooled awaiter fields.
/// </summary>
/// <remarks>
/// <para>The type is emitted by <see cref="Emit.ReflectionMetadataEmitter"/>
/// as a nested type on the containing type (or top-level for the script
/// entry-point's async helpers). Its kind — struct vs class — is fixed at
/// construction:</para>
/// <list type="bullet">
/// <item><description><b>struct</b> by default for <c>async void</c> /
/// <c>async Task</c> / <c>async Task&lt;T&gt;</c> / custom task-likes; the
/// no-alloc fast path on synchronously-completing awaits depends on this.</description></item>
/// <item><description><b>class</b> for async-iterators (always), and as the
/// fallback when EnC stability is needed (not currently supported by GSharp).</description></item>
/// </list>
/// <para>This class is a thin data container. Field population happens in
/// <c>AsyncStateMachineRewriter</c> (todo: state-rewriter), which decides
/// hoist set, allocates awaiter slot indices, and registers the synthesized
/// type with its kickoff <see cref="FunctionSymbol"/>.</para>
/// </remarks>
public sealed class SynthesizedStateMachineType : TypeSymbol
{
    internal const string ReferenceAwaiterPoolKey = "!reference-awaiter";

    private readonly List<FieldSymbol> fields = new List<FieldSymbol>();
    private readonly Dictionary<string, FieldSymbol> awaiterPoolFields = new Dictionary<string, FieldSymbol>(StringComparer.Ordinal);
    private StructSymbol materializedStruct;

    /// <summary>
    /// Initializes a new instance of the <see cref="SynthesizedStateMachineType"/> class.
    /// </summary>
    /// <param name="name">The mangled type name produced by
    /// <see cref="GeneratedNames.StateMachineTypeName"/>.</param>
    /// <param name="containerKind">Whether the type is a <c>struct</c> or
    /// <c>class</c>; see <see cref="StateMachineContainerKind"/>.</param>
    /// <param name="kickoffMethod">The original async method whose body
    /// the state machine implements.</param>
    /// <param name="builderInfo">The resolved BCL builder for the kickoff
    /// method's return type.</param>
    public SynthesizedStateMachineType(
        string name,
        StateMachineContainerKind containerKind,
        FunctionSymbol kickoffMethod,
        AsyncMethodBuilderInfo builderInfo)
        : base(name)
    {
        ContainerKind = containerKind;
        KickoffMethod = kickoffMethod;
        BuilderInfo = builderInfo;
    }

    /// <summary>Gets the storage kind (struct or class). Spec §5.</summary>
    public StateMachineContainerKind ContainerKind { get; }

    /// <summary>Gets the original async method whose body the state machine implements.</summary>
    public FunctionSymbol KickoffMethod { get; }

    /// <summary>Gets the resolved BCL builder information for the kickoff
    /// method's return type.</summary>
    public AsyncMethodBuilderInfo BuilderInfo { get; }

    /// <summary>
    /// Gets or sets the symbolic async result type declared on the kickoff
    /// method before it was widened to <c>Task&lt;T&gt;</c>.
    /// </summary>
    public TypeSymbol ResultTypeSymbol { get; set; }

    /// <summary>Gets or sets the <c>&lt;&gt;1__state</c> field. Always
    /// present; populated by the state-machine rewriter.</summary>
    public FieldSymbol StateField { get; set; }

    /// <summary>Gets or sets the <c>&lt;&gt;t__builder</c> field. Always
    /// present; typed as <see cref="AsyncMethodBuilderInfo.BuilderType"/>.</summary>
    public FieldSymbol BuilderField { get; set; }

    /// <summary>Gets or sets the <c>&lt;&gt;4__this</c> field, present only
    /// when the kickoff method is an instance method that captures <c>this</c>.</summary>
    public FieldSymbol ThisField { get; set; }

    /// <summary>Gets the read-only sequence of all synthesized fields on
    /// the state machine, in declaration order. Includes the control
    /// fields, the parameter proxies, the hoisted user locals, and the
    /// pooled awaiter slots.</summary>
    public ImmutableArray<FieldSymbol> Fields => fields.ToImmutableArray();

    /// <summary>Appends a field to the synthesized type. Call order
    /// determines emit order; the state-machine rewriter pushes control
    /// fields first, then parameter proxies, then hoisted locals, then
    /// awaiter slots, matching Roslyn's emit order.</summary>
    /// <param name="field">The field to append.</param>
    public void AddField(FieldSymbol field)
    {
        if (materializedStruct != null)
        {
            throw new InvalidOperationException("Cannot add fields after the synthesized state-machine type has been materialized.");
        }

        fields.Add(field);
    }

    /// <summary>Registers a pooled awaiter field keyed by its emitted type identity.</summary>
    /// <param name="poolKey">The emitted type identity key for the awaiter pool.</param>
    /// <param name="field">The field symbol for the pool slot.</param>
    public void RegisterAwaiterPoolField(string poolKey, FieldSymbol field)
    {
        if (poolKey == null)
        {
            throw new ArgumentNullException(nameof(poolKey));
        }

        if (field == null)
        {
            throw new ArgumentNullException(nameof(field));
        }

        awaiterPoolFields[poolKey] = field;
    }

    /// <summary>Gets the pooled awaiter field for the given emitted awaiter type.</summary>
    /// <param name="awaiterClrType">The CLR awaiter type.</param>
    /// <param name="awaiterTypeSymbol">The symbolic awaiter type retained for emission.</param>
    /// <returns>The awaiter pool field, or <see langword="null"/> if not registered.</returns>
    public FieldSymbol GetAwaiterPoolField(Type awaiterClrType, TypeSymbol awaiterTypeSymbol)
    {
        if (awaiterClrType == null)
        {
            return null;
        }

        var key = GetAwaiterPoolKey(awaiterClrType, awaiterTypeSymbol);
        return awaiterPoolFields.TryGetValue(key, out var field) ? field : null;
    }

    /// <summary>
    /// Materializes this synthesized type as a real <see cref="StructSymbol"/>
    /// so later async-rewriter slices can reuse existing bound nodes such as
    /// <see cref="GSharp.Core.CodeAnalysis.Binding.BoundFieldAccessExpression"/>, which require a
    /// <see cref="StructSymbol"/> receiver type.
    /// </summary>
    /// <remarks>
    /// Calling this method freezes the field list. Struct state machines are
    /// projected as value types; async-iterator class state machines are
    /// projected with <see cref="StructSymbol.IsClass"/> set.
    /// </remarks>
    /// <returns>The stable aggregate projection for this state-machine type.</returns>
    public StructSymbol MaterializeAsStructSymbol()
    {
        if (materializedStruct != null)
        {
            return materializedStruct;
        }

        materializedStruct = new StructSymbol(
            name: Name,
            fields: Fields,
            accessibility: Accessibility.Private,
            declaration: null,
            packageName: KickoffMethod.Package?.Name,
            isData: false,
            isInline: false,
            isClass: ContainerKind == StateMachineContainerKind.Class);

        return materializedStruct;
    }

    internal static string GetAwaiterPoolKey(Type awaiterClrType, TypeSymbol awaiterTypeSymbol)
    {
        if (!awaiterClrType.IsValueType)
        {
            return ReferenceAwaiterPoolKey;
        }

        // Issue #2750: distinct symbolic Task<T> results can share the erased
        // TaskAwaiter<object> CLR shape, but their emitted fields cannot.
        var builder = new StringBuilder();
        FunctionTypeSymbol.AppendIdentityKey(
            builder,
            awaiterTypeSymbol ?? TypeSymbol.FromClrType(awaiterClrType));
        return builder.ToString();
    }
}
