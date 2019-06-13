// <copyright file="BuiltinFunctions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis
{
    using System.Collections.Generic;
    using System.Collections.Immutable;
    using System.Linq;
    using System.Reflection;
    using GSharp.Core.CodeAnalysis.Symbols;

    /// <summary>
    /// Built-in functions.
    /// </summary>
    internal static class BuiltinFunctions
    {
        /// <summary>
        /// Prints to the console.
        /// </summary>
        public static readonly FunctionSymbol Print = new FunctionSymbol(
            name: "print",
            parameters: ImmutableArray.Create(new ParameterSymbol("text", TypeSymbol.String)),
            type: TypeSymbol.Void);

        /// <summary>
        /// Reads from the console.
        /// </summary>
        public static readonly FunctionSymbol Input = new FunctionSymbol(
            name: "input",
            parameters: ImmutableArray<ParameterSymbol>.Empty,
            type: TypeSymbol.String);

        /// <summary>
        /// Produces a random number.
        /// </summary>
        public static readonly FunctionSymbol Rnd = new FunctionSymbol(
            name: "rnd",
            parameters: ImmutableArray.Create(new ParameterSymbol("max", TypeSymbol.Int)),
            type: TypeSymbol.Int);

        /// <summary>
        /// Returns the entire set of built-in functions.
        /// </summary>
        /// <returns>An <see cref="IEnumerable{FunctionSymbol}"/>.</returns>
        internal static IEnumerable<FunctionSymbol> GetAll()
            => typeof(BuiltinFunctions).GetFields(BindingFlags.Public | BindingFlags.Static)
                                       .Where(f => f.FieldType == typeof(FunctionSymbol))
                                       .Select(f => (FunctionSymbol)f.GetValue(null));
    }
}
