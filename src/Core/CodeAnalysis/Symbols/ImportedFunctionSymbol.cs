// <copyright file="ImportedFunctionSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols
{
    using System;
    using System.Reflection;
    using GSharp.Core.CodeAnalysis.Syntax;

    /// <summary>
    /// Represents an imported function symbol in the language.
    /// </summary>
    public sealed class ImportedFunctionSymbol : Symbol
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="ImportedFunctionSymbol"/> class.
        /// </summary>
        /// <param name="name">The function name.</param>
        /// <param name="importedClass">The imported class that holds this imported function.</param>
        /// <param name="method">The method.</param>
        /// <param name="declaration">The declaration.</param>
        public ImportedFunctionSymbol(
            string name,
            ImportedClassSymbol importedClass,
            MethodInfo method,
            ExpressionSyntax declaration)
            : base(name)
        {
            ImportedClass = importedClass;
            Method = method;
            Declaration = declaration;
            Type = GetMethodType(Method);
        }

        /// <inheritdoc/>
        public override SymbolKind Kind => SymbolKind.ImportedFunction;

        /// <summary>
        /// Gets the imported class that holds this imported function.
        /// </summary>
        public ImportedClassSymbol ImportedClass { get; }

        /// <summary>
        /// Gets the method.
        /// </summary>
        public MethodInfo Method { get; }

        /// <summary>
        /// Gets the declaration.
        /// </summary>
        public ExpressionSyntax Declaration { get; }

        /// <summary>
        /// Gets the imported function type.
        /// </summary>
        public TypeSymbol Type { get; }

        private TypeSymbol GetMethodType(MethodInfo method)
        {
            var returnType = method.ReturnType;
            if (returnType == null)
            {
                return TypeSymbol.Void;
            }
            else if (returnType.Equals(typeof(bool)))
            {
                return TypeSymbol.Bool;
            }
            else if (returnType.Equals(typeof(int)))
            {
                return TypeSymbol.Int;
            }
            else if (returnType.Equals(typeof(string)))
            {
                return TypeSymbol.String;
            }

            return TypeSymbol.Error;
        }
    }
}
