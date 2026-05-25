// <copyright file="GeneratedNames.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// Deterministic mangled-name generator for compiler-synthesized async
/// state-machine members. The naming scheme intentionally mirrors Roslyn's
/// generated names so PDB tooling and the debugger surface familiar
/// identifiers.
/// </summary>
/// <remarks>
/// <para>Per ADR-0023 and the Roslyn-async spec (see <c>~/roslyn-async.md</c> §4),
/// the CLR does not care about these names; they only matter for debugger
/// experience and (future) Edit-and-Continue stability. GSharp does not
/// support EnC, but adopting Roslyn's scheme keeps the diff visible to
/// users who decompile the produced PE.</para>
/// <para>The generator is stateful per-method: state machine kind suffixes
/// (e.g. <c>d__N</c>) and per-type awaiter slot indices (<c>u__N</c>) are
/// allocated by the caller, which threads its own counters through. All
/// methods on this class are pure.</para>
/// </remarks>
public static class GeneratedNames
{
    /// <summary>The hoisted <c>state</c> field on a state-machine type.</summary>
    public const string StateField = "<>1__state";

    /// <summary>The hoisted async-method-builder field on a state-machine type.</summary>
    public const string BuilderField = "<>t__builder";

    /// <summary>The hoisted <c>this</c> reference field, present when the
    /// containing method is an instance method that captures <c>this</c>.</summary>
    public const string ThisField = "<>4__this";

    /// <summary>
    /// Returns the name of the hoisted field that mirrors a parameter of the
    /// original async method.
    /// </summary>
    /// <param name="parameterName">The user-visible parameter name.</param>
    /// <returns>The mangled hoisted-field name.</returns>
    public static string ParameterField(string parameterName) => "<>3__" + parameterName;

    /// <summary>
    /// Returns the name of the hoisted field for a user-declared local that
    /// must survive an await suspension.
    /// </summary>
    /// <param name="localName">The user-visible local name.</param>
    /// <param name="ordinal">A per-method monotonic ordinal that disambiguates
    /// reused names across shadowing scopes (mirrors Roslyn's
    /// <c>&lt;&lt;name&gt;&gt;5__N</c> shape).</param>
    /// <returns>The mangled hoisted-field name.</returns>
    public static string HoistedLocalField(string localName, int ordinal)
        => "<" + localName + ">5__" + ordinal.ToString(System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>
    /// Returns the name of the per-awaiter-type pooled field. One field is
    /// shared across every <c>await</c> whose awaiter has the same type;
    /// reference-typed awaiters collapse into a single <c>System.Object</c>
    /// field (spec §5, "Awaiter slot pooling").
    /// </summary>
    /// <param name="ordinal">A per-method monotonic ordinal.</param>
    /// <returns>The mangled awaiter-slot field name.</returns>
    public static string AwaiterField(int ordinal)
        => "<>u__" + ordinal.ToString(System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>
    /// Returns the name of the synthesized state-machine type for an async
    /// method. The type lives as a nested type on the containing type (or
    /// at top-level for the script entry point); the ordinal disambiguates
    /// methods that share a name (overloads / generic instantiations).
    /// </summary>
    /// <param name="methodName">The original async method's user-visible name.</param>
    /// <param name="ordinal">A per-containing-type monotonic ordinal.</param>
    /// <returns>The mangled state-machine type name.</returns>
    public static string StateMachineTypeName(string methodName, int ordinal)
        => "<" + methodName + ">d__" + ordinal.ToString(System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>
    /// Returns the name of a reusable hoisted temp introduced by the spiller
    /// (analogue of Roslyn's <c>&lt;&gt;7__wrapN</c>).
    /// </summary>
    /// <param name="ordinal">A per-method monotonic ordinal.</param>
    /// <returns>The mangled spill-temp field name.</returns>
    public static string SpillTempField(int ordinal)
        => "<>7__wrap" + ordinal.ToString(System.Globalization.CultureInfo.InvariantCulture);
}
