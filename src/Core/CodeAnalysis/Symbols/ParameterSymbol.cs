// <copyright file="ParameterSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a function declaration parameter symbol in the language.
/// </summary>
public sealed class ParameterSymbol : LocalVariableSymbol
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ParameterSymbol"/> class.
    /// </summary>
    /// <param name="name">The parameter name.</param>
    /// <param name="type">The parameter type (already wrapped in <c>SliceTypeSymbol</c> if variadic).</param>
    /// <param name="isVariadic">Whether the parameter is variadic (Phase 4.8).</param>
    /// <param name="declaringSyntax">
    /// The originating parameter-declaration syntax (may be <see langword="null"/>
    /// for compiler-synthesised parameters — async kickoff <c>&lt;&gt;sm_this</c>,
    /// state-machine builder receivers, etc.). Consumed by the PDB emitter for
    /// arg-display in debuggers.
    /// </param>
    /// <param name="isScoped">
    /// Whether the parameter carries the <c>scoped</c> modifier (ADR-0058 / issue #376).
    /// When <see langword="true"/>, the parameter's safe-to-escape scope is restricted to the
    /// current function body and returning its value is rejected.
    /// </param>
    /// <param name="refKind">
    /// ADR-0060: the by-reference passing mode of this parameter (<c>none</c>, <c>ref</c>, <c>out</c>, or <c>in</c>).
    /// Defaults to <see cref="Binding.RefKind.None"/>. When non-<c>None</c>, the parameter's signature-effective
    /// type is the managed pointer <c>T&amp;</c>; inside the body the symbol's <see cref="Type"/> remains the
    /// pointee type <c>T</c> and reads/writes are implicitly indirected.
    /// </param>
    public ParameterSymbol(string name, TypeSymbol type, bool isVariadic = false, SyntaxNode declaringSyntax = null, bool isScoped = false, RefKind refKind = RefKind.None)
        : base(name, isReadOnly: refKind == RefKind.None || refKind == RefKind.In, type, declaringSyntax)
    {
        IsVariadic = isVariadic;
        IsScoped = isScoped;
        RefKind = refKind;
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.Parameter;

    /// <summary>Gets a value indicating whether this parameter is variadic (Phase 4.8).</summary>
    public bool IsVariadic { get; }

    /// <summary>
    /// Gets or sets a value indicating whether this parameter carries the <c>scoped</c> modifier (ADR-0058 / issue #376).
    /// When <see langword="true"/>, the parameter's safe-to-escape scope is restricted to the
    /// current function body and it may not be directly returned from a ref-struct-returning function.
    /// </summary>
    public override bool IsScoped { get; set; }

    /// <summary>
    /// Gets or sets the ADR-0060 by-reference passing mode of this parameter (<c>None</c>, <c>Ref</c>, <c>Out</c>, or <c>In</c>).
    /// </summary>
    public override RefKind RefKind { get; set; }

    /// <summary>
    /// Gets a value indicating whether this parameter declares an explicit default value (ADR-0063).
    /// When <see langword="true"/>, callers may omit a corresponding argument and the binder
    /// substitutes <see cref="ExplicitDefaultValue"/> at the call site.
    /// </summary>
    public bool HasExplicitDefaultValue { get; private set; }

    /// <summary>
    /// Gets the constant default value declared on this parameter (ADR-0063).
    /// Only meaningful when <see cref="HasExplicitDefaultValue"/> is <see langword="true"/>.
    /// Value kinds: numeric primitive, <see cref="bool"/>, <see cref="char"/>,
    /// <see cref="string"/>, enum constant (carried as its underlying integral value),
    /// or <see langword="null"/> for a nullable/reference parameter.
    /// </summary>
    public object ExplicitDefaultValue { get; private set; }

    /// <summary>
    /// Gets the resolved <c>@MarshalAs(UnmanagedType.…)</c> override for
    /// this parameter (ADR-0096 / issue #762), or <see langword="null"/>
    /// when the parameter has no such annotation. Attached by
    /// <see cref="Binding.PInvokeBinder"/> on P/Invoke declarations after
    /// per-parameter validation; consumed by the emitter to write a
    /// <c>FieldMarshal</c> table row and stamp
    /// <see cref="System.Reflection.ParameterAttributes.HasFieldMarshal"/>
    /// on the Param row.
    /// </summary>
    public MarshalAsMetadata MarshalAsMetadata { get; private set; }

    /// <summary>
    /// Records the constant default value for this parameter (ADR-0063). Called exactly
    /// once by the binder when the parameter syntax includes a <c>= constant</c> clause
    /// and the constant has passed all ADR-0063 §3 restrictions.
    /// </summary>
    /// <param name="value">The encoded constant default. May be <see langword="null"/> to represent the source-level <c>nil</c> default.</param>
    public void SetExplicitDefaultValue(object value)
    {
        HasExplicitDefaultValue = true;
        ExplicitDefaultValue = value;
    }

    /// <summary>
    /// Attaches the resolved <see cref="MarshalAsMetadata"/> for this
    /// parameter (ADR-0096 / issue #762). Called exactly once by the
    /// P/Invoke binder after the <c>@MarshalAs</c> annotation has been
    /// validated against the parameter type and the rest of the
    /// P/Invoke shape.
    /// </summary>
    /// <param name="metadata">The resolved override. Must not be <see langword="null"/>.</param>
    public void SetMarshalAsMetadata(MarshalAsMetadata metadata)
    {
        MarshalAsMetadata = metadata;
    }
}
