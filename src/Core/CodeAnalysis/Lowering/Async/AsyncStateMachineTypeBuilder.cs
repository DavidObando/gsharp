// <copyright file="AsyncStateMachineTypeBuilder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// Pure factory that composes the foundation pieces
/// (<see cref="AsyncMethodBuilderInfo"/>, <see cref="AsyncCaptureWalker"/>,
/// <see cref="GeneratedNames"/>, <see cref="SynthesizedStateMachineType"/>)
/// into a fully populated state-machine type for one async kickoff method.
/// The returned type carries every field the state-machine rewriter and the
/// emitter will read: control fields (<c>&lt;&gt;1__state</c>,
/// <c>&lt;&gt;t__builder</c>), the optional <c>&lt;&gt;4__this</c> proxy,
/// parameter proxies (one per parameter, named after the parameter itself
/// per Roslyn convention), and hoisted user-local proxies
/// (<c>&lt;name&gt;5__N</c>).
/// </summary>
/// <remarks>
/// <para>This builder produces the type only — it does not generate
/// <c>MoveNext</c>, <c>SetStateMachine</c>, the constructor, or the rewritten
/// kickoff body. Those are the state-machine rewriter's responsibility and
/// will plug into this type as a follow-up step.</para>
/// <para>Builder selection follows Roslyn:</para>
/// <list type="bullet">
/// <item><description>Declared inner return type <c>Void</c> ⇒ caller observes
/// <c>System.Threading.Tasks.Task</c>, builder is
/// <c>AsyncTaskMethodBuilder</c>.</description></item>
/// <item><description>Declared inner return type <c>T</c> ⇒ caller observes
/// <c>System.Threading.Tasks.Task&lt;T&gt;</c>, builder is
/// <c>AsyncTaskMethodBuilder&lt;T&gt;</c>.</description></item>
/// <item><description>Return type carries
/// <c>[AsyncMethodBuilder(typeof(T))]</c> ⇒ custom builder
/// <c>T</c> (or <c>T&lt;TResult&gt;</c>).</description></item>
/// </list>
/// <para>Iterator producers (<c>async IAsyncEnumerable&lt;T&gt;</c>) take the
/// class container; everything else takes struct.</para>
/// <para>Returns <see langword="null"/> if the BCL types <c>Task</c> /
/// <c>Task&lt;T&gt;</c> cannot be resolved through the supplied
/// <see cref="ReferenceResolver"/> (e.g. an exotic TFM without the standard
/// libraries) or if the kickoff's declared inner return type lacks a CLR
/// projection (e.g. a pure GSharp type that cannot yet be wrapped as
/// <c>Task&lt;T&gt;</c> — see ADR-0023 Phase 5.1 limitation). Callers route
/// such cases through a diagnostic rather than dereferencing the null.</para>
/// </remarks>
public static class AsyncStateMachineTypeBuilder
{
    /// <summary>The base ordinal Roslyn uses for hoisted-local field names
    /// (<c>&lt;name&gt;5__1</c>). The leading <c>5</c> is the Edit-and-Continue
    /// "generation" identifier; GSharp does not support EnC, but adopts the
    /// convention so produced PEs decompile to the same name shape.</summary>
    private const int FirstHoistedLocalOrdinal = 1;

    /// <summary>
    /// Builds and populates the state-machine type for <paramref name="kickoff"/>.
    /// </summary>
    /// <param name="kickoff">The async function whose body will be lowered
    /// into the returned type's <c>MoveNext</c>.</param>
    /// <param name="loweredBody">The kickoff method's lowered body — input to
    /// the capture walker. Must be the post-<see cref="Lowerer"/> form.</param>
    /// <param name="references">The compilation's reference resolver, used to
    /// look up <c>System.Threading.Tasks.Task[`1]</c> on the target TFM and to
    /// resolve the builder type's members.</param>
    /// <param name="ordinal">Per-kickoff disambiguator for the synthesized
    /// type's mangled name. The caller (compilation wireup) maintains a
    /// monotonic counter scoped to the kickoff's container so overloads /
    /// generic instantiations do not collide.</param>
    /// <returns>The populated state-machine type, or <see langword="null"/>
    /// when the builder cannot be resolved (see remarks on
    /// <see cref="AsyncStateMachineTypeBuilder"/>).</returns>
    public static SynthesizedStateMachineType Build(
        FunctionSymbol kickoff,
        BoundStatement loweredBody,
        ReferenceResolver references,
        int ordinal = 0)
    {
        if (kickoff == null)
        {
            throw new ArgumentNullException(nameof(kickoff));
        }

        if (!kickoff.IsAsync)
        {
            throw new ArgumentException("Kickoff method is not declared async.", nameof(kickoff));
        }

        var returnClrType = ResolveAsyncReturnClrType(kickoff, references);
        if (returnClrType == null)
        {
            return null;
        }

        var builderInfo = AsyncMethodBuilderInfo.Resolve(returnClrType, references);
        if (!builderInfo.IsValid)
        {
            return null;
        }

        var containerKind = builderInfo.Kind == AsyncMethodBuilderKind.AsyncIterator
            ? StateMachineContainerKind.Class
            : StateMachineContainerKind.Struct;

        var typeName = GeneratedNames.StateMachineTypeName(kickoff.Name, ordinal);
        var sm = new SynthesizedStateMachineType(typeName, containerKind, kickoff, builderInfo);

        var stateField = new FieldSymbol(GeneratedNames.StateField, TypeSymbol.Int, Accessibility.Public);
        sm.AddField(stateField);
        sm.StateField = stateField;

        var builderField = new FieldSymbol(
            GeneratedNames.BuilderField,
            TypeSymbol.FromClrType(builderInfo.BuilderType),
            Accessibility.Public);
        sm.AddField(builderField);
        sm.BuilderField = builderField;

        if (kickoff.ReceiverType != null)
        {
            var thisField = new FieldSymbol(GeneratedNames.ThisField, kickoff.ReceiverType, Accessibility.Public);
            sm.AddField(thisField);
            sm.ThisField = thisField;
        }

        var hoist = AsyncCaptureWalker.Analyze(loweredBody, kickoff.Parameters);

        foreach (var parameter in hoist.Parameters)
        {
            sm.AddField(new FieldSymbol(parameter.Name, parameter.Type, Accessibility.Public));
        }

        int hoistedOrdinal = FirstHoistedLocalOrdinal;
        foreach (var local in hoist.Locals)
        {
            var fieldName = GeneratedNames.HoistedLocalField(local.Name, hoistedOrdinal++);
            sm.AddField(new FieldSymbol(fieldName, local.Type, Accessibility.Public));
        }

        return sm;
    }

    private static Type ResolveAsyncReturnClrType(FunctionSymbol kickoff, ReferenceResolver references)
    {
        if (references == null)
        {
            return null;
        }

        if (kickoff.Type == TypeSymbol.Void)
        {
            return references.TryResolveType("System.Threading.Tasks.Task", out var taskType) ? taskType : null;
        }

        var inner = kickoff.Type?.ClrType;
        if (inner == null)
        {
            return null;
        }

        return references.TryResolveType("System.Threading.Tasks.Task`1", out var open)
            ? open.MakeGenericType(inner)
            : null;
    }
}
