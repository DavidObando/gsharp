#nullable disable

// <copyright file="SymbolKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents the kind of symbol in the language.
/// </summary>
public enum SymbolKind
{
    /// <summary>
    /// The symbol is a function.
    /// </summary>
    Function,

    /// <summary>
    /// The symbol is a global variable.
    /// </summary>
    GlobalVariable,

    /// <summary>
    /// The symbol is a local variable.
    /// </summary>
    LocalVariable,

    /// <summary>
    /// The symbol is a parameter.
    /// </summary>
    Parameter,

    /// <summary>
    /// The symbol is a type.
    /// </summary>
    Type,

    /// <summary>
    /// The symbol is a package.
    /// </summary>
    Package,

    /// <summary>
    /// The symbol is an import.
    /// </summary>
    Import,

    /// <summary>
    /// The symbol is an imported class.
    /// </summary>
    ImportedClass,

    /// <summary>
    /// The symbol is an imported function.
    /// </summary>
    ImportedFunction,

    /// <summary>
    /// The symbol is a field on a struct or class.
    /// </summary>
    Field,

    /// <summary>
    /// The symbol is an enum member.
    /// </summary>
    EnumMember,

    /// <summary>
    /// The symbol is a property on a struct or class.
    /// </summary>
    Property,

    /// <summary>
    /// The symbol is an event on a struct or class (ADR-0052).
    /// </summary>
    Event,
}
