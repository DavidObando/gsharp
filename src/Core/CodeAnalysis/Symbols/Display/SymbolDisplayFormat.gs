// <copyright file="SymbolDisplayFormat.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols.Display

import System

/// Declarative options controlling how
/// (cref:SymbolDisplay.ToDisplayParts(GSharp.Core.CodeAnalysis.Symbols.Symbol, SymbolDisplayFormat,
/// GSharp.Core.CodeAnalysis.Compilation.Compilation))
/// renders a symbol. The analog of Roslyn's `SymbolDisplayFormat`: a single
/// service produces every IDE view by varying this format rather than maintaining
/// divergent ad-hoc formatters.
/// @param IncludeDescriptorPrefix Emit a leading descriptor such as `(local variable)`, `(parameter)`,
/// or `(field)` (the Roslyn `Description(...)` convention).
/// @param QualifyNames Qualify type, enum, and package names with their containing package
/// (fully-qualified names) when a package is known.
/// @param IncludeConstantValue Append an enum member's numeric value (e.g. `Color.Red = 1`).
/// @param IncludePropertyAccessors Append a property's accessor descriptor (e.g. `{ get; set; }`).
/// @param IncludeModifiers Include declaration modifiers (e.g. `static`, `async`, `open`,
/// `override`) and the extension/receiver clause on functions.
data class SymbolDisplayFormat(
    IncludeDescriptorPrefix bool,
    QualifyNames bool,
    IncludeConstantValue bool,
    IncludePropertyAccessors bool,
    IncludeModifiers bool
) : IEquatable[SymbolDisplayFormat] {
    shared {
        /// The rich format used for LSP hover: descriptors, fully-qualified names,
        /// enum values, property accessors, and modifiers.
        let Hover SymbolDisplayFormat = SymbolDisplayFormat(
            IncludeDescriptorPrefix: true,
            QualifyNames: true,
            IncludeConstantValue: true,
            IncludePropertyAccessors: true,
            IncludeModifiers: true
        )

        /// The compact format used for signature labels (signature help, completion
        /// detail): modifiers and accessors but no descriptor prefix.
        let Signature SymbolDisplayFormat = SymbolDisplayFormat(
            IncludeDescriptorPrefix: false,
            QualifyNames: false,
            IncludeConstantValue: true,
            IncludePropertyAccessors: true,
            IncludeModifiers: true
        )
    }
}
