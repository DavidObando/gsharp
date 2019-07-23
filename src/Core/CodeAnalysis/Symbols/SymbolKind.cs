// <copyright file="SymbolKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols
{
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
    }
}