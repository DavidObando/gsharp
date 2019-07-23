// <copyright file="ImportedClassSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols
{
    using System;
    using System.Collections.Immutable;
    using System.Linq;
    using System.Reflection;
    using System.Reflection.Metadata;
    using GSharp.Core.CodeAnalysis.Binding;
    using GSharp.Core.CodeAnalysis.Syntax;

    /// <summary>
    /// Represents an imported class symbol in the language.
    /// </summary>
    public sealed class ImportedClassSymbol : Symbol
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="ImportedClassSymbol"/> class.
        /// </summary>
        /// <param name="type">The imported class type.</param>
        /// <param name="declaration">The imported class declaration.</param>
        public ImportedClassSymbol(Type type, ExpressionSyntax declaration)
            : base(type.FullName)
        {
            ClassType = type;
            Declaration = declaration;
        }

        /// <inheritdoc/>
        public override SymbolKind Kind => SymbolKind.ImportedClass;

        /// <summary>
        /// Gets the imported class type.
        /// </summary>
        public Type ClassType { get; }

        /// <summary>
        /// Gets the imported class declaration.
        /// </summary>
        public ExpressionSyntax Declaration { get; }

        /// <summary>
        /// Tries to get a member from this imported class symbol.
        /// </summary>
        /// <param name="text">The name of the member.</param>
        /// <param name="ne">The name expression.</param>
        /// <param name="member">The resulting member, if one is found.</param>
        /// <returns>Whether we found a matching member or not.</returns>
        internal bool TryLookupMember(string text, NameExpressionSyntax ne, out object member)
        {
            throw new NotImplementedException();
        }

        /// <summary>
        /// Tries to get a function from this imported class symbol.
        /// </summary>
        /// <param name="text">The name of the function.</param>
        /// <param name="callExpression">The call expression.</param>
        /// <param name="arguments">The bound arguments.</param>
        /// <param name="function">The resulting function, if one is found.</param>
        /// <returns>Whether we found a matching function or not.</returns>
        internal bool TryLookupFunction(string text, CallExpressionSyntax callExpression, ImmutableArray<BoundExpression> arguments, out ImportedFunctionSymbol function)
        {
            function = null;
            var methods = ClassType.GetMethods(BindingFlags.Static | BindingFlags.Instance | BindingFlags.Public);
            var nameMatches = methods.Where(m => m.Name == text).ToList();
            foreach (var match in nameMatches)
            {
                var parameters = match.GetParameters();
                if (arguments.Length != parameters.Length)
                {
                    continue;
                }

                bool hasMatchError = false;
                for (var i = 0; i < arguments.Length; i++)
                {
                    var argument = arguments[i];
                    var parameter = parameters[i];

                    if (!TypesMatch(argument.Type, parameter.ParameterType))
                    {
                        hasMatchError = true;
                        break;
                    }
                }

                if (!hasMatchError)
                {
                    function = new ImportedFunctionSymbol(text, this, match, callExpression);
                    return true;
                }
            }

            return false;
        }

        private bool TypesMatch(TypeSymbol type, Type parameterType)
        {
            if (type == TypeSymbol.Bool)
            {
                return parameterType.Equals(typeof(bool));
            }
            else if (type == TypeSymbol.Int)
            {
                return parameterType.Equals(typeof(int));
            }
            else if (type == TypeSymbol.String)
            {
                return parameterType.Equals(typeof(string));
            }

            return false;
        }
    }
}
