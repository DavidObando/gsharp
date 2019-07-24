// <copyright file="BoundScope.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    using System;
    using System.Collections.Generic;
    using System.Collections.Immutable;
    using System.Linq;
    using GSharp.Core.CodeAnalysis.Symbols;
    using GSharp.Core.CodeAnalysis.Syntax;

    /// <summary>
    /// Bound scope.
    /// </summary>
    public sealed class BoundScope
    {
        private Dictionary<string, Symbol> symbols;
        private List<ImportSymbol> imports;

        /// <summary>
        /// Initializes a new instance of the <see cref="BoundScope"/> class.
        /// </summary>
        /// <param name="parent">The parent scope.</param>
        public BoundScope(BoundScope parent)
        {
            Parent = parent;
            imports = parent?.imports;
        }

        /// <summary>
        /// Gets the parent scope.
        /// </summary>
        public BoundScope Parent { get; }

        /// <summary>
        /// Tries to add an import to this scope.
        /// </summary>
        /// <param name="import">The import.</param>
        /// <returns>Whether the import was registered or not.</returns>
        public bool TryImport(ImportSymbol import)
        {
            if (imports == null)
            {
                imports = new List<ImportSymbol>();
            }

            imports.Add(import);
            return true;
        }

        /// <summary>
        /// Tries to declare a variable in this scope.
        /// </summary>
        /// <param name="variable">The variable to declare.</param>
        /// <returns>Wherther the variable was declared or not.</returns>
        public bool TryDeclareVariable(VariableSymbol variable)
            => TryDeclareSymbol(variable);

        /// <summary>
        /// Tries to declare a function in this scope.
        /// </summary>
        /// <param name="function">The function to declare.</param>
        /// <returns>Whether the function was declared or not.</returns>
        public bool TryDeclareFunction(FunctionSymbol function)
            => TryDeclareSymbol(function);

        /// <summary>
        /// Tries to lookup a variable in this scope.
        /// </summary>
        /// <param name="name">The name of the variable.</param>
        /// <param name="variable">The variable result, if found.</param>
        /// <returns>Whether a variable was found or not.</returns>
        public bool TryLookupVariable(string name, out VariableSymbol variable)
            => TryLookupSymbol(name, out variable);

        /// <summary>
        /// Tries to lookup a function in this scope.
        /// </summary>
        /// <param name="name">The function name.</param>
        /// <param name="function">The function result, if found.</param>
        /// <returns>Whether a function was found or not.</returns>
        public bool TryLookupFunction(string name, out FunctionSymbol function)
            => TryLookupSymbol(name, out function);

        /// <summary>
        /// Tries to lookup an imported class.
        /// </summary>
        /// <param name="name">The class name.</param>
        /// <param name="declaration">The declaration.</param>
        /// <param name="importedClass">The result, if found.</param>
        /// <returns>Whether a class was found or not.</returns>
        public bool TryLookupImportedClass(string name, ExpressionSyntax declaration, out ImportedClassSymbol importedClass)
        {
            importedClass = null;

            if (imports != null)
            {
                string[] sources = new[]
                {
                    string.Empty,
                    ", mscorlib",
                    ", System.Runtime",
                };
                foreach (var source in sources)
                {
                    foreach (var import in imports)
                    {
                        Console.WriteLine();
                        var typeName = import.Name + "." + name + source;
                        var type = Type.GetType(typeName);
                        if (type != null)
                        {
                            importedClass = new ImportedClassSymbol(type, declaration);
                            return true;
                        }
                    }
                }
            }

            return false;
        }

        /// <summary>
        /// Gets an immutable array of all the declared variables.
        /// </summary>
        /// <returns>The declared variables.</returns>
        public ImmutableArray<VariableSymbol> GetDeclaredVariables()
            => GetDeclaredSymbols<VariableSymbol>();

        /// <summary>
        /// Gets an immutable array of all the declared functions.
        /// </summary>
        /// <returns>The declared functions.</returns>
        public ImmutableArray<FunctionSymbol> GetDeclaredFunctions()
            => GetDeclaredSymbols<FunctionSymbol>();

        /// <summary>
        /// Gets an immutable array of all the declared imports.
        /// </summary>
        /// <returns>The declared imports.</returns>
        public ImmutableArray<ImportSymbol> GetDeclaredImports()
            => imports.ToImmutableArray();

        private bool TryDeclareSymbol<TSymbol>(TSymbol symbol)
            where TSymbol : Symbol
        {
            if (symbols == null)
            {
                symbols = new Dictionary<string, Symbol>();
            }
            else if (symbols.ContainsKey(symbol.Name))
            {
                return false;
            }

            symbols.Add(symbol.Name, symbol);
            return true;
        }

        private bool TryLookupSymbol<TSymbol>(string name, out TSymbol symbol)
            where TSymbol : Symbol
        {
            symbol = null;

            if (symbols != null && symbols.TryGetValue(name, out var declaredSymbol))
            {
                if (declaredSymbol is TSymbol matchingSymbol)
                {
                    symbol = matchingSymbol;
                    return true;
                }

                return false;
            }

            if (Parent == null)
            {
                return false;
            }

            return Parent.TryLookupSymbol(name, out symbol);
        }

        private ImmutableArray<TSymbol> GetDeclaredSymbols<TSymbol>()
            where TSymbol : Symbol
        {
            if (symbols == null)
            {
                return ImmutableArray<TSymbol>.Empty;
            }

            return symbols.Values.OfType<TSymbol>().ToImmutableArray();
        }
    }
}