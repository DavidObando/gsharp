// <copyright file="VariableSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols
{
    /// <summary>
    /// Represents a variable symbol in the language.
    /// </summary>
    public abstract class VariableSymbol : Symbol
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="VariableSymbol"/> class.
        /// </summary>
        /// <param name="name">The variable's name.</param>
        /// <param name="isReadOnly">Whether it's read-only or not.</param>
        /// <param name="type">The variable's type.</param>
        public VariableSymbol(string name, bool isReadOnly, TypeSymbol type)
            : base(name)
        {
            IsReadOnly = isReadOnly;
            Type = type;
        }

        /// <summary>
        /// Gets a value indicating whether it's read-only or not.
        /// </summary>
        public bool IsReadOnly { get; }

        /// <summary>
        /// Gets the variable's type.
        /// </summary>
        public TypeSymbol Type { get; }
    }
}
