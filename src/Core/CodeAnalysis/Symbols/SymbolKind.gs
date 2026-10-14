// <copyright file="SymbolKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

/// Represents the kind of symbol in the language.
enum SymbolKind {
    Function,
    GlobalVariable,
    LocalVariable,
    Parameter,
    Type,
    Package,
    Import,
    ImportedClass,
    ImportedFunction,
    Field,
    EnumMember,
    Property,
    Event
}
