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

    private readonly Dictionary<ISymbol, GSharpIdentifierNameContext> precomputedContexts =
        new(SymbolEqualityComparer.Default);

    private readonly Dictionary<ISymbol, IReadOnlyCollection<ISymbol>> contractGroups =
        new(SymbolEqualityComparer.Default);

    private readonly Dictionary<ISymbol, IReadOnlyCollection<string>> methodScopeNames =
        new(SymbolEqualityComparer.Default);

    private readonly HashSet<ISymbol> invocationSensitive =
        new(SymbolEqualityComparer.Default);

    private EmittedNameAllocator(Compilation compilation)
    {
        this.compilation = compilation;
        this.CollectContractGroups();
        this.CollectInvocationSensitiveSymbols();
        this.CollectPrimaryParameterContexts();
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
            if (this.emittedNames.TryGetValue(symbol, out string existing))
            {
                return existing;
            }

            IReadOnlyCollection<ISymbol> contract = this.GetContractGroup(symbol);
            GSharpIdentifierNameContext context = additionalContext;
            foreach (ISymbol member in contract)
            {
                this.precomputedContexts.TryGetValue(
                    member,
                    out GSharpIdentifierNameContext precomputed);
                context |= this.GetContext(member) | precomputed;
            }

            // ADR-0170 / issue #3610: a METADATA-VISIBLE symbol whose name is
            // a G# reserved spelling keeps its exact CLR name via the `$name`
            // escape instead of the lossy `name_` rename — the rename changes
            // the emitted metadata (reflection, InternalsVisibleTo,
            // cross-assembly consumers) and can collide with a legal `name_`
            // neighbor. Locals, parameters, and other non-metadata names keep
            // the #3461 rename below, where readability wins and metadata
            // does not care.
            string sourceName = SourceName(symbol);
            if (contract.Any(IsMetadataVisible)
                && GSharpSyntaxFacts.IsReservedIdentifier(sourceName, context))
            {
                string escaped = "$" + sourceName;
                foreach (ISymbol member in contract)
                {
                    this.emittedNames[member] = escaped;
                }

                return escaped;
            }

            string emitted = GSharpSyntaxFacts.GetEmittedIdentifier(
                sourceName,
                context,
                contract.SelectMany(this.GetScopeNames).Distinct(StringComparer.Ordinal));
            foreach (ISymbol member in contract)
            {
                this.emittedNames[member] = emitted;
            }

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
            parts.Push(this.GetName(current));
        }

        return string.Join(".", parts);
    }

    // ADR-0170: symbols whose emitted names ARE their CLR metadata names —
    // namespaces, named types, and type members. Everything scoped to a body
    // (locals, parameters, type parameters, range variables, local/anonymous
    // functions) and synthesized shapes (anonymous-type members, aliases,
    // discards) stay on the rename path.
    private static bool IsMetadataVisible(ISymbol symbol) =>
        symbol switch
        {
            INamespaceSymbol => true,
            INamedTypeSymbol { IsAnonymousType: false } => true,
            IMethodSymbol { MethodKind: MethodKind.LocalFunction or MethodKind.AnonymousFunction } => false,
            IMethodSymbol method => method.ContainingType?.IsAnonymousType == false,
            IPropertySymbol property => property.ContainingType?.IsAnonymousType == false,
            IFieldSymbol field => field.ContainingType?.IsAnonymousType == false,
            IEventSymbol => true,
            _ => false,
        };

    private static ISymbol Canonical(ISymbol symbol) =>
        symbol switch
        {
            IMethodSymbol method => method.OriginalDefinition,
            IPropertySymbol property => property.OriginalDefinition,
            IEventSymbol @event => @event.OriginalDefinition,
            INamedTypeSymbol type => type.OriginalDefinition,
            _ => symbol,
        };

    private static string SourceName(ISymbol symbol)
    {
        int separator = symbol.Name.LastIndexOf('.');
        return separator >= 0
            ? symbol.Name.Substring(separator + 1)
            : symbol.Name;
    }

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

        if (!symbol.DeclaringSyntaxReferences.IsDefaultOrEmpty
            && this.invocationSensitive.Contains(symbol))
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
                IEnumerable<string> parameterNames =
                    method.Parameters.Select(candidate => candidate.Name);
                if (parameter.ContainingType is { } parameterType)
                {
                    parameterNames = parameterNames.Concat(
                        this.GetVisibleTypeMemberNames(parameterType));
                }

                return parameterNames.Distinct(StringComparer.Ordinal).ToArray();

            case ITypeParameterSymbol typeParameter
                when typeParameter.ContainingSymbol is IMethodSymbol method:
                return this.GetVisibleTypeParameterNames(method)
                    .Concat(this.GetLexicallyVisibleTypeNames(typeParameter))
                    .Distinct(StringComparer.Ordinal)
                    .ToArray();

            case ITypeParameterSymbol typeParameter
                when typeParameter.ContainingSymbol is INamedTypeSymbol type:
                return this.GetVisibleTypeParameterNames(type)
                    .Concat(this.GetLexicallyVisibleTypeNames(typeParameter))
                    .Distinct(StringComparer.Ordinal)
                    .ToArray();

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
                    .Select(SourceName)
                    .ToArray()
                    ?? Array.Empty<string>();

            default:
                return symbol.ContainingType is { } containingType
                    ? this.GetVisibleTypeMemberNames(containingType)
                    : symbol.ContainingNamespace?.GetMembers()
                        .Select(SourceName)
                        .ToArray()
                    ?? Array.Empty<string>();
        }
    }

    private IReadOnlyCollection<string> GetVisibleTypeMemberNames(
        INamedTypeSymbol type)
    {
        var names = new HashSet<string>(
            type.GetMembers().Select(SourceName),
            StringComparer.Ordinal);
        for (INamedTypeSymbol current = type.BaseType;
             current != null;
             current = current.BaseType)
        {
            foreach (ISymbol member in current.GetMembers())
            {
                if (IsVisibleInheritedMember(member, type))
                {
                    names.Add(SourceName(member));
                }
            }
        }

        foreach (INamedTypeSymbol iface in type.AllInterfaces)
        {
            foreach (ISymbol member in iface.GetMembers())
            {
                names.Add(SourceName(member));
            }
        }

        return names.ToArray();
    }

    private static bool IsVisibleInheritedMember(
        ISymbol member,
        INamedTypeSymbol derivedType) =>
        member.DeclaredAccessibility switch
        {
            Accessibility.Public or Accessibility.Protected
                or Accessibility.ProtectedOrInternal => true,
            Accessibility.Internal or Accessibility.ProtectedAndInternal =>
                SymbolEqualityComparer.Default.Equals(
                    member.ContainingAssembly,
                    derivedType.ContainingAssembly)
                || member.ContainingAssembly?.GivesAccessTo(
                    derivedType.ContainingAssembly) == true,
            _ => false,
        };

    private IEnumerable<string> GetVisibleTypeParameterNames(ISymbol symbol)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        for (ISymbol current = symbol;
             current != null;
             current = current.ContainingSymbol)
        {
            switch (current)
            {
                case IMethodSymbol method:
                    names.UnionWith(
                        method.TypeParameters.Select(parameter => parameter.Name));
                    break;
                case INamedTypeSymbol type:
                    names.UnionWith(
                        type.TypeParameters.Select(parameter => parameter.Name));
                    names.UnionWith(this.GetVisibleNestedTypeNames(type));
                    break;
            }
        }

        return names;
    }

    private IEnumerable<string> GetVisibleNestedTypeNames(INamedTypeSymbol type)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        for (INamedTypeSymbol current = type;
             current != null;
             current = current.ContainingType)
        {
            names.UnionWith(current.GetTypeMembers().Select(SourceName));
            for (INamedTypeSymbol baseType = current.BaseType;
                 baseType != null;
                 baseType = baseType.BaseType)
            {
                foreach (INamedTypeSymbol nested in baseType.GetTypeMembers())
                {
                    if (IsVisibleInheritedMember(nested, current))
                    {
                        names.Add(SourceName(nested));
                    }
                }
            }
        }

        return names;
    }

    private IEnumerable<string> GetLexicallyVisibleTypeNames(
        ITypeParameterSymbol typeParameter)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (SyntaxReference reference in typeParameter.DeclaringSyntaxReferences)
        {
            SemanticModel model = this.compilation.GetSemanticModel(reference.SyntaxTree);
            foreach (ISymbol symbol in model.LookupNamespacesAndTypes(
                reference.Span.Start))
            {
                switch (symbol)
                {
                    case INamedTypeSymbol type:
                        names.Add(SourceName(type));
                        break;
                    case IAliasSymbol alias
                        when alias.Target is INamedTypeSymbol:
                        names.Add(alias.Name);
                        break;
                }
            }
        }

        return names;
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
        if (method.ContainingType is { } containingType)
        {
            names.UnionWith(this.GetVisibleTypeMemberNames(containingType));
        }

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

    private IReadOnlyCollection<ISymbol> GetContractGroup(ISymbol symbol) =>
        this.contractGroups.TryGetValue(symbol, out IReadOnlyCollection<ISymbol> group)
            ? group
            : new[] { symbol };

    private void AddPrecomputedContext(
        ISymbol symbol,
        GSharpIdentifierNameContext context)
    {
        symbol = Canonical(symbol);
        this.precomputedContexts.TryGetValue(
            symbol,
            out GSharpIdentifierNameContext existing);
        this.precomputedContexts[symbol] = existing | context;
    }

    private void CollectContractGroups()
    {
        var parent = new Dictionary<ISymbol, ISymbol>(SymbolEqualityComparer.Default);

        ISymbol Find(ISymbol symbol)
        {
            symbol = Canonical(symbol);
            if (!parent.TryGetValue(symbol, out ISymbol current))
            {
                parent[symbol] = symbol;
                return symbol;
            }

            if (!SymbolEqualityComparer.Default.Equals(current, symbol))
            {
                parent[symbol] = Find(current);
            }

            return parent[symbol];
        }

        void Union(ISymbol left, ISymbol right)
        {
            ISymbol leftRoot = Find(left);
            ISymbol rightRoot = Find(right);
            if (!SymbolEqualityComparer.Default.Equals(leftRoot, rightRoot))
            {
                parent[rightRoot] = leftRoot;
            }
        }

        foreach (INamedTypeSymbol type in EnumerateSourceTypes(
            this.compilation.Assembly.GlobalNamespace))
        {
            foreach (ISymbol member in type.GetMembers())
            {
                if (member is IPropertySymbol propertyMember)
                {
                    foreach (SyntaxReference reference in propertyMember.DeclaringSyntaxReferences)
                    {
                        if (reference.GetSyntax() is ParameterSyntax parameterSyntax
                            && this.compilation.GetSemanticModel(reference.SyntaxTree)
                                .GetDeclaredSymbol(parameterSyntax) is IParameterSymbol parameter)
                        {
                            Union(propertyMember, parameter);
                        }
                    }
                }

                ISymbol overridden = member switch
                {
                    IMethodSymbol method => method.OverriddenMethod,
                    IPropertySymbol property => property.OverriddenProperty,
                    IEventSymbol @event => @event.OverriddenEvent,
                    _ => null,
                };
                if (overridden != null)
                {
                    Union(member, overridden);
                }

                IEnumerable<ISymbol> explicitImplementations = member switch
                {
                    IMethodSymbol method => method.ExplicitInterfaceImplementations,
                    IPropertySymbol property => property.ExplicitInterfaceImplementations,
                    IEventSymbol @event => @event.ExplicitInterfaceImplementations,
                    _ => Array.Empty<ISymbol>(),
                };
                foreach (ISymbol implemented in explicitImplementations)
                {
                    Union(member, implemented);
                }
            }

            foreach (INamedTypeSymbol iface in type.AllInterfaces)
            {
                foreach (ISymbol interfaceMember in iface.GetMembers())
                {
                    ISymbol implementation =
                        type.FindImplementationForInterfaceMember(interfaceMember);
                    if (implementation != null)
                    {
                        Union(implementation, interfaceMember);
                    }
                }
            }
        }

        var groups = new Dictionary<ISymbol, List<ISymbol>>(
            SymbolEqualityComparer.Default);
        foreach (ISymbol symbol in parent.Keys.ToArray())
        {
            ISymbol root = Find(symbol);
            if (!groups.TryGetValue(root, out List<ISymbol> group))
            {
                group = new List<ISymbol>();
                groups[root] = group;
            }

            group.Add(symbol);
        }

        foreach (List<ISymbol> group in groups.Values)
        {
            ISymbol[] members = group.ToArray();
            foreach (ISymbol member in members)
            {
                this.contractGroups[member] = members;
            }
        }
    }

    private void CollectPrimaryParameterContexts()
    {
        foreach (Microsoft.CodeAnalysis.SyntaxTree tree in this.compilation.SyntaxTrees)
        {
            SemanticModel model = this.compilation.GetSemanticModel(tree);
            foreach (RecordDeclarationSyntax record in tree.GetRoot()
                .DescendantNodes()
                .OfType<RecordDeclarationSyntax>())
            {
                if (record.ParameterList != null)
                {
                    continue;
                }

                List<ConstructorDeclarationSyntax> instanceConstructors = record.Members
                    .OfType<ConstructorDeclarationSyntax>()
                    .Where(constructor =>
                        !constructor.Modifiers.Any(
                            Microsoft.CodeAnalysis.CSharp.SyntaxKind.StaticKeyword))
                    .ToList();
                if (instanceConstructors.Count > 0)
                {
                    if (instanceConstructors.Count == 1
                        && model.GetDeclaredSymbol(record) is INamedTypeSymbol
                            { IsValueType: true } recordStruct)
                    {
                        this.CollectRecordStructConstructorContexts(
                            instanceConstructors[0],
                            recordStruct,
                            model);
                    }

                    continue;
                }

                var candidates = record.Members
                    .OfType<PropertyDeclarationSyntax>()
                    .Where(property =>
                        !property.Modifiers.Any(
                            Microsoft.CodeAnalysis.CSharp.SyntaxKind.StaticKeyword)
                        && property.ExpressionBody == null
                        && property.AccessorList != null
                        && property.AccessorList.Accessors.All(accessor =>
                            accessor.Body == null && accessor.ExpressionBody == null)
                        && property.AccessorList.Accessors.Any(accessor =>
                            accessor.IsKind(
                                Microsoft.CodeAnalysis.CSharp.SyntaxKind.GetAccessorDeclaration)))
                    .Select(property => (
                        Syntax: property,
                        Symbol: model.GetDeclaredSymbol(property) as IPropertySymbol))
                    .Where(candidate => candidate.Symbol != null)
                    .ToList();
                if (candidates.Count == 0
                    || candidates.Any(candidate =>
                        this.GetContractGroup(Canonical(candidate.Symbol)).Count > 1))
                {
                    continue;
                }

                bool abort = false;
                var parameters = new List<IPropertySymbol>();
                foreach (var candidate in candidates)
                {
                    IPropertySymbol property = candidate.Symbol;
                    if (property.IsRequired || property.SetMethod?.IsInitOnly == true)
                    {
                        continue;
                    }

                    bool nonConstantInitializer = candidate.Syntax.Initializer != null
                        && !model.GetConstantValue(candidate.Syntax.Initializer.Value).HasValue;
                    if (nonConstantInitializer)
                    {
                        if (property.ContainingType.IsValueType)
                        {
                            abort = true;
                            break;
                        }

                        continue;
                    }

                    parameters.Add(property);
                }

                if (!abort)
                {
                    foreach (IPropertySymbol property in parameters)
                    {
                        this.AddPrecomputedContext(
                            property,
                            GSharpIdentifierNameContext.Parameter);
                    }
                }
            }
        }
    }

    private void CollectRecordStructConstructorContexts(
        ConstructorDeclarationSyntax constructor,
        INamedTypeSymbol containingType,
        SemanticModel model)
    {
        if (constructor.Body == null
            || constructor.Initializer != null
            || model.GetDeclaredSymbol(constructor) is not IMethodSymbol constructorSymbol)
        {
            return;
        }

        var targets = new Dictionary<IParameterSymbol, ISymbol>(
            SymbolEqualityComparer.Default);
        foreach (StatementSyntax statement in constructor.Body.Statements)
        {
            if (statement is not ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax assignment }
                || !assignment.OperatorToken.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.EqualsToken)
                || model.GetSymbolInfo(assignment.Left).Symbol is not ISymbol target
                || target is not IFieldSymbol and not IPropertySymbol
                || target.IsStatic
                || !SymbolEqualityComparer.Default.Equals(
                    target.ContainingType,
                    containingType)
                || assignment.Right is not IdentifierNameSyntax right
                || model.GetSymbolInfo(right).Symbol is not IParameterSymbol parameter
                || !SymbolEqualityComparer.Default.Equals(
                    parameter.ContainingSymbol,
                    constructorSymbol)
                || !targets.TryAdd(parameter, target))
            {
                return;
            }
        }

        if (constructorSymbol.Parameters.Any(parameter => !targets.ContainsKey(parameter)))
        {
            return;
        }

        foreach (ISymbol target in targets.Values)
        {
            this.AddPrecomputedContext(
                target,
                GSharpIdentifierNameContext.Parameter);
        }
    }

    private static IEnumerable<INamedTypeSymbol> EnumerateSourceTypes(
        INamespaceSymbol namespaceSymbol)
    {
        foreach (INamedTypeSymbol type in namespaceSymbol.GetTypeMembers())
        {
            yield return type;
            foreach (INamedTypeSymbol nested in EnumerateNestedTypes(type))
            {
                yield return nested;
            }
        }

        foreach (INamespaceSymbol child in namespaceSymbol.GetNamespaceMembers())
        {
            foreach (INamedTypeSymbol type in EnumerateSourceTypes(child))
            {
                yield return type;
            }
        }
    }

    private static IEnumerable<INamedTypeSymbol> EnumerateNestedTypes(
        INamedTypeSymbol type)
    {
        foreach (INamedTypeSymbol nested in type.GetTypeMembers())
        {
            yield return nested;
            foreach (INamedTypeSymbol deeper in EnumerateNestedTypes(nested))
            {
                yield return deeper;
            }
        }
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
                    || model.GetSymbolInfo(simple).Symbol is not { } symbol)
                {
                    continue;
                }

                if (GSharpSyntaxFacts.IsReservedIdentifier(
                    simple.Identifier.ValueText,
                    GSharpIdentifierNameContext.Invocation))
                {
                    this.invocationSensitive.Add(Canonical(symbol));
                }

                if (simple is GenericNameSyntax
                    && !symbol.DeclaringSyntaxReferences.IsDefaultOrEmpty
                    && GSharpSyntaxFacts.IsReservedIdentifier(
                        simple.Identifier.ValueText,
                        GSharpIdentifierNameContext.Index))
                {
                    this.AddPrecomputedContext(
                        symbol,
                        GSharpIdentifierNameContext.Index);
                }
            }

            foreach (ObjectCreationExpressionSyntax creation in root.DescendantNodes().OfType<ObjectCreationExpressionSyntax>())
            {
                if (model.GetSymbolInfo(creation).Symbol is not IMethodSymbol constructor)
                {
                    continue;
                }

                string name = RightmostIdentifier(creation.Type);
                if (GSharpSyntaxFacts.IsReservedIdentifier(
                    name,
                    GSharpIdentifierNameContext.Invocation))
                {
                    this.invocationSensitive.Add(Canonical(constructor.ContainingType));
                }

                if (HasGenericRightmostName(creation.Type)
                    && GSharpSyntaxFacts.IsReservedIdentifier(
                        name,
                        GSharpIdentifierNameContext.Index))
                {
                    this.AddPrecomputedContext(
                        constructor.ContainingType,
                        GSharpIdentifierNameContext.Index);
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

                if (model.GetTypeInfo(creation).Type is INamedTypeSymbol
                        { IsGenericType: true } genericType
                    && GSharpSyntaxFacts.IsReservedIdentifier(
                        genericType.Name,
                        GSharpIdentifierNameContext.Index))
                {
                    this.AddPrecomputedContext(
                        genericType,
                        GSharpIdentifierNameContext.Index);
                }
            }

            foreach (ElementAccessExpressionSyntax access in root.DescendantNodes().OfType<ElementAccessExpressionSyntax>())
            {
                if (access.Expression is IdentifierNameSyntax identifier
                    && GSharpSyntaxFacts.IsReservedIdentifier(
                        identifier.Identifier.ValueText,
                        GSharpIdentifierNameContext.Index)
                    && model.GetSymbolInfo(identifier).Symbol is { } symbol
                    && !symbol.DeclaringSyntaxReferences.IsDefaultOrEmpty)
                {
                    this.AddPrecomputedContext(
                        symbol,
                        GSharpIdentifierNameContext.Index);
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

    private static bool HasGenericRightmostName(TypeSyntax type) =>
        type switch
        {
            GenericNameSyntax => true,
            QualifiedNameSyntax qualified => qualified.Right is GenericNameSyntax,
            AliasQualifiedNameSyntax alias => alias.Name is GenericNameSyntax,
            _ => false,
        };
}
