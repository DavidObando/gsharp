// <copyright file="SymbolDisplayFormat.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols.Display;

/// <summary>
/// Declarative options controlling how <see cref="SymbolDisplay.ToDisplayParts(GSharp.Core.CodeAnalysis.Symbols.Symbol, SymbolDisplayFormat, GSharp.Core.CodeAnalysis.Compilation.Compilation)"/>
/// renders a symbol. The analog of Roslyn's <c>SymbolDisplayFormat</c>: a single
/// service produces every IDE view by varying this format rather than maintaining
/// divergent ad-hoc formatters.
/// </summary>
/// <param name="IncludeDescriptorPrefix">
/// Emit a leading descriptor such as <c>(local variable)</c>, <c>(parameter)</c>,
/// or <c>(field)</c> (the Roslyn <c>Description(...)</c> convention).
/// </param>
/// <param name="QualifyNames">
/// Qualify type, enum, and package names with their containing package
/// (fully-qualified names) when a package is known.
/// </param>
/// <param name="IncludeConstantValue">
/// Append an enum member's numeric value (e.g. <c>Color.Red = 1</c>).
/// </param>
/// <param name="IncludePropertyAccessors">
/// Append a property's accessor descriptor (e.g. <c>{ get; set; }</c>).
/// </param>
/// <param name="IncludeModifiers">
/// Include declaration modifiers (e.g. <c>static</c>, <c>async</c>, <c>open</c>,
/// <c>override</c>) and the extension/receiver clause on functions.
/// </param>
public sealed record SymbolDisplayFormat(
    bool IncludeDescriptorPrefix,
    bool QualifyNames,
    bool IncludeConstantValue,
    bool IncludePropertyAccessors,
    bool IncludeModifiers)
{
    /// <summary>
    /// The rich format used for LSP hover: descriptors, fully-qualified names,
    /// enum values, property accessors, and modifiers.
    /// </summary>
    public static readonly SymbolDisplayFormat Hover = new(
        IncludeDescriptorPrefix: true,
        QualifyNames: true,
        IncludeConstantValue: true,
        IncludePropertyAccessors: true,
        IncludeModifiers: true);

    /// <summary>
    /// The compact format used for signature labels (signature help, completion
    /// detail): modifiers and accessors but no descriptor prefix.
    /// </summary>
    public static readonly SymbolDisplayFormat Signature = new(
        IncludeDescriptorPrefix: false,
        QualifyNames: false,
        IncludeConstantValue: true,
        IncludePropertyAccessors: true,
        IncludeModifiers: true);
}
