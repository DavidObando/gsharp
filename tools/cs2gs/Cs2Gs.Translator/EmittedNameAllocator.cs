// <copyright file="EmittedNameAllocator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using GSharpIdentifierNameContext = GSharp.Core.CodeAnalysis.Syntax.IdentifierNameContext;
using GSharpSyntaxFacts = GSharp.Core.CodeAnalysis.Syntax.SyntaxFacts;

namespace Cs2Gs.Translator;

/// <summary>Allocates stable, grammar-safe G# names for bound C# symbols.</summary>
internal sealed class EmittedNameAllocator
{
    private static readonly ConditionalWeakTable<Compilation, EmittedNameAllocator> Cache = new();

    private readonly Compilation compilation;

    private readonly object gate = new();

    private readonly Dictionary<ISymbol, string> emittedNames =
        new(SymbolEqualityComparer.Default);

    private readonly Dictionary<ISymbol, GSharpIdentifierNameContext> additionalContexts =
        new(SymbolEqualityComparer.Default);

    private readonly Dictionary<ISymbol, IReadOnlyCollection<string>> methodScopeNames =
        new(SymbolEqualityComparer.Default);

    private readonly HashSet<ISymbol> invocationSensitive =
        new(SymbolEqualityComparer.Default);

    private EmittedNameAllocator(Compilation compilation)
    {
        this.compilation = compilation;
        this.CollectInvocationSensitiveSymbols();
    }

    public static EmittedNameAllocator For(Compilation compilation) =>
        Cache.GetValue(compilation, static value => new EmittedNameAllocator(value));

    public string GetName(
        ISymbol symbol,
        GSharpIdentifierNameContext additionalContext = GSharpIdentifierNameContext.General)
    {
        if (symbol is null)
        {
            return null;
        }

        lock (this.gate)
        {
            symbol = Canonical(symbol);
            if (additionalContext != GSharpIdentifierNameContext.General)
            {
                this.additionalContexts.TryGetValue(
                    symbol,
                    out GSharpIdentifierNameContext registered);
                this.additionalContexts[symbol] = registered | additionalContext;
            }

            if (this.emittedNames.TryGetValue(symbol, out string existing)
                && additionalContext == GSharpIdentifierNameContext.General)
            {
                return existing;
            }

            this.additionalContexts.TryGetValue(
                symbol,
                out GSharpIdentifierNameContext registeredContext);
            GSharpIdentifierNameContext context =
                this.GetContext(symbol) | registeredContext | additionalContext;
            string emitted = GSharpSyntaxFacts.GetEmittedIdentifier(
                symbol.Name,
                context,
                this.GetScopeNames(symbol));
            this.emittedNames[symbol] = emitted;

            return emitted;
        }
    }

    public string GetName(
        string name,
        GSharpIdentifierNameContext context = GSharpIdentifierNameContext.General,
        IEnumerable<string> scopeNames = null) =>
        GSharpSyntaxFacts.GetEmittedIdentifier(name, context, scopeNames);

    public string GetNamespaceName(INamespaceSymbol namespaceSymbol)
    {
        if (namespaceSymbol is null || namespaceSymbol.IsGlobalNamespace)
        {
            return null;
        }

        var parts = new Stack<string>();
        for (INamespaceSymbol current = namespaceSymbol;
             current != null && !current.IsGlobalNamespace;
             current = current.ContainingNamespace)
        {
            parts.Push(current.Locations.Any(location => location.IsInSource)
                ? this.GetName(current)
                : current.Name);
        }

        return string.Join(".", parts);
    }

    private static ISymbol Canonical(ISymbol symbol) =>
        symbol switch
        {
            IMethodSymbol method => method.OriginalDefinition,
            INamedTypeSymbol type => type.OriginalDefinition,
            _ => symbol,
        };

    private GSharpIdentifierNameContext GetContext(ISymbol symbol)
    {
        GSharpIdentifierNameContext context = symbol switch
        {
            IParameterSymbol => GSharpIdentifierNameContext.Parameter,
            IRangeVariableSymbol =>
                GSharpIdentifierNameContext.Parameter | GSharpIdentifierNameContext.Local,
            ITypeParameterSymbol => GSharpIdentifierNameContext.TypeParameter | GSharpIdentifierNameContext.Type,
            INamedTypeSymbol => GSharpIdentifierNameContext.Type,
            IAliasSymbol => GSharpIdentifierNameContext.Type,
            IPropertySymbol { ContainingType.IsAnonymousType: true } =>
                GSharpIdentifierNameContext.Parameter,
            IPropertySymbol property when property.DeclaringSyntaxReferences
                .Any(reference => reference.GetSyntax() is ParameterSyntax) =>
                GSharpIdentifierNameContext.Parameter,
            IMethodSymbol method when method.Name == "init"
                && !method.DeclaringSyntaxReferences.IsDefaultOrEmpty =>
                GSharpIdentifierNameContext.Invocation,
            IMethodSymbol { MethodKind: MethodKind.LocalFunction } => GSharpIdentifierNameContext.Local,
            ILocalSymbol local when local.DeclaringSyntaxReferences
                .Any(reference => reference.GetSyntax() is SingleVariableDesignationSyntax) =>
                GSharpIdentifierNameContext.Pattern,
            ILocalSymbol => GSharpIdentifierNameContext.Local,
            _ => GSharpIdentifierNameContext.General,
        };

        if (this.invocationSensitive.Contains(symbol))
        {
            context |= GSharpIdentifierNameContext.Invocation;
        }

        return context;
    }

    private IReadOnlyCollection<string> GetScopeNames(ISymbol symbol)
    {
        switch (symbol)
        {
            case IParameterSymbol parameter
                when parameter.ContainingSymbol is IMethodSymbol method:
                return method.Parameters.Select(candidate => candidate.Name).ToArray();

            case ITypeParameterSymbol typeParameter
                when typeParameter.ContainingSymbol is IMethodSymbol method:
                return method.TypeParameters.Select(candidate => candidate.Name).ToArray();

            case ITypeParameterSymbol typeParameter
                when typeParameter.ContainingSymbol is INamedTypeSymbol type:
                return type.TypeParameters.Select(candidate => candidate.Name).ToArray();

            case ILocalSymbol:
            case IRangeVariableSymbol:
            case ILabelSymbol:
            case IMethodSymbol { MethodKind: MethodKind.LocalFunction }:
                return this.GetMethodScopeNames(symbol.ContainingSymbol);

            case IAliasSymbol alias:
                return this.GetAliasScopeNames(alias);

            case INamespaceSymbol namespaceSymbol:
                return namespaceSymbol.ContainingNamespace?
                    .GetMembers()
                    .Select(candidate => candidate.Name)
                    .ToArray()
                    ?? Array.Empty<string>();

            default:
                return symbol.ContainingType?.GetMembers()
                    .Select(candidate => candidate.Name)
                    .ToArray()
                    ?? symbol.ContainingNamespace?.GetMembers()
                        .Select(candidate => candidate.Name)
                        .ToArray()
                    ?? Array.Empty<string>();
        }
    }

    private IReadOnlyCollection<string> GetAliasScopeNames(IAliasSymbol alias)
    {
        SyntaxReference reference = alias.DeclaringSyntaxReferences.FirstOrDefault();
        if (reference is null)
        {
            return Array.Empty<string>();
        }

        return reference.SyntaxTree.GetRoot()
            .DescendantNodes()
            .OfType<UsingDirectiveSyntax>()
            .Where(directive => directive.Alias != null)
            .Select(directive => directive.Alias.Name.Identifier.ValueText)
            .ToArray();
    }

    private IReadOnlyCollection<string> GetMethodScopeNames(ISymbol containingSymbol)
    {
        if (containingSymbol is not IMethodSymbol method)
        {
            return Array.Empty<string>();
        }

        method = method.OriginalDefinition;
        if (this.methodScopeNames.TryGetValue(method, out IReadOnlyCollection<string> existing))
        {
            return existing;
        }

        var names = new HashSet<string>(
            method.Parameters.Select(parameter => parameter.Name),
            StringComparer.Ordinal);
        foreach (SyntaxReference reference in method.DeclaringSyntaxReferences)
        {
            Microsoft.CodeAnalysis.SyntaxNode root = reference.GetSyntax();
            SemanticModel model = this.compilation.GetSemanticModel(reference.SyntaxTree);
            foreach (Microsoft.CodeAnalysis.SyntaxNode node in root.DescendantNodesAndSelf())
            {
                ISymbol declared = model.GetDeclaredSymbol(node);
                if (declared is ILocalSymbol or IRangeVariableSymbol or ILabelSymbol
                    || declared is IMethodSymbol { MethodKind: MethodKind.LocalFunction })
                {
                    if (SymbolEqualityComparer.Default.Equals(
                        Canonical(declared.ContainingSymbol),
                        method))
                    {
                        names.Add(declared.Name);
                    }
                }
            }
        }

        string[] result = names.ToArray();
        this.methodScopeNames[method] = result;
        return result;
    }

    private void CollectInvocationSensitiveSymbols()
    {
        foreach (Microsoft.CodeAnalysis.SyntaxTree tree in this.compilation.SyntaxTrees)
        {
            SemanticModel model = this.compilation.GetSemanticModel(tree);
            Microsoft.CodeAnalysis.SyntaxNode root = tree.GetRoot();
            foreach (InvocationExpressionSyntax invocation in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                if (invocation.Expression is not SimpleNameSyntax simple
                    || !GSharpSyntaxFacts.IsReservedIdentifier(
                        simple.Identifier.ValueText,
                        GSharpIdentifierNameContext.Invocation))
                {
                    continue;
                }

                ISymbol symbol = model.GetSymbolInfo(simple).Symbol;
                if (symbol != null)
                {
                    this.invocationSensitive.Add(Canonical(symbol));
                }
            }

            foreach (ObjectCreationExpressionSyntax creation in root.DescendantNodes().OfType<ObjectCreationExpressionSyntax>())
            {
                if (!GSharpSyntaxFacts.IsReservedIdentifier(
                    RightmostIdentifier(creation.Type),
                    GSharpIdentifierNameContext.Invocation))
                {
                    continue;
                }

                if (model.GetSymbolInfo(creation).Symbol is IMethodSymbol constructor)
                {
                    this.invocationSensitive.Add(Canonical(constructor.ContainingType));
                }
            }

            foreach (ImplicitObjectCreationExpressionSyntax creation in root.DescendantNodes().OfType<ImplicitObjectCreationExpressionSyntax>())
            {
                if (model.GetTypeInfo(creation).Type is INamedTypeSymbol type
                    && GSharpSyntaxFacts.IsReservedIdentifier(
                        type.Name,
                        GSharpIdentifierNameContext.Invocation))
                {
                    this.invocationSensitive.Add(Canonical(type));
                }
            }

            foreach (ElementAccessExpressionSyntax access in root.DescendantNodes().OfType<ElementAccessExpressionSyntax>())
            {
                if (access.Expression is IdentifierNameSyntax identifier
                    && GSharpSyntaxFacts.IsReservedIdentifier(
                        identifier.Identifier.ValueText,
                        GSharpIdentifierNameContext.Index)
                    && model.GetSymbolInfo(identifier).Symbol is { } symbol)
                {
                    this.additionalContexts[Canonical(symbol)] =
                        GSharpIdentifierNameContext.Index;
                }
            }
        }
    }

    private static string RightmostIdentifier(TypeSyntax type) =>
        type switch
        {
            SimpleNameSyntax simple => simple.Identifier.ValueText,
            QualifiedNameSyntax qualified => qualified.Right.Identifier.ValueText,
            AliasQualifiedNameSyntax alias => alias.Name.Identifier.ValueText,
            _ => type.ToString(),
        };
}
